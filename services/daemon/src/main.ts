#!/usr/bin/env node
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromString } from "@libp2p/peer-id";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CanonicalStore,
  ContextCapabilityIssuer,
  ContextService,
  DeviceAuthenticator
} from "../../../packages/core/src/index.js";
import { NoiseEndpoint } from "../../../packages/relay/src/index.js";
import { ClaudeAdapter } from "./providers/claude-adapter.js";
import { CodexAdapter } from "./providers/codex-adapter.js";
import { HermesAdapter } from "./providers/hermes-adapter.js";
import { ConversationCoordinator } from "./coordinator.js";
import { ContextAccessManager } from "./context-access.js";
import { GitWorkspaceManager } from "./git-workspace-manager.js";
import { LaptopApiServer } from "./api-server.js";
import { RelayHostConnector } from "./relay-host-connector.js";
import { loadDaemonRuntimeConfig } from "./runtime-config.js";
import {
  KeychainCommandSecretStore,
  loadDaemonCoreSecrets,
  secretAccount
} from "./secret-store.js";
import { HistorySyncService } from "./history/history-sync.js";
import {
  completePairingRevocation,
  preparePairingRevocation
} from "./setup.js";

const defaultConfigPath = join(
  homedir(),
  "Library",
  "Application Support",
  "EXARCH",
  "config.json"
);

process.umask(0o077);

async function main(): Promise<void> {
  const configPath = process.env.EXARCH_CONFIG_PATH ?? defaultConfigPath;
  let config = await loadDaemonRuntimeConfig(configPath);
  const keychainHelper = process.env.EXARCH_KEYCHAIN_HELPER
    ?? fileURLToPath(new URL("../../../../bin/exarch-keychain", import.meta.url));
  const secretStore = new KeychainCommandSecretStore(keychainHelper);
  const secrets = await loadDaemonCoreSecrets(config.secretAccountPrefix, secretStore);
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const store = new CanonicalStore(join(config.dataDirectory, "context.sqlite"), {
    requireEncrypted: config.requireEncryptedStorage,
    encryptionKey: Buffer.from(secrets.databaseEncryptionKey, "base64url")
  });
  // Bounds are checked when a project is written, so a row created under
  // looser rules — or whose root has since moved — keeps a scope it would not
  // be granted now. Withdraw those before anything can start a turn in one.
  const revalidated = store.revalidateProjectScopes();
  if (revalidated.withdrawn.length > 0) {
    log("project-scope-withdrawn", {
      projects: revalidated.withdrawn,
      checked: revalidated.checked,
      remedy: "exarch-setup project-add"
    });
  }
  if (config.pairing?.revocationPending === true) {
    // A prior process persisted the tombstone before it acknowledged the
    // phone. Re-assert local revocation before exposing any API on restart.
    await preparePairingRevocation({ config, configPath, secretStore, store });
    log("pairing-revocation-resumed", { contextPreserved: true });
  }
  const codex = new CodexAdapter({ defaultCwd: homedir() });
  const claude = new ClaudeAdapter({ defaultCwd: homedir() });
  const hermes = new HermesAdapter({ defaultCwd: homedir() });
  const contextIssuer = new ContextCapabilityIssuer(
    Buffer.from(secrets.contextCapabilitySecret, "base64url")
  );
  const contextSocket = join(config.dataDirectory, "context.sock");
  const contextAccess = new ContextAccessManager({
    issuer: contextIssuer,
    socketPath: contextSocket,
    capabilityDirectory: join(config.dataDirectory, "turn-capabilities"),
    nodeExecutable: process.execPath,
    cliPath: fileURLToPath(new URL("../../../apps/context-cli/src/main.js", import.meta.url))
  });
  const coordinator = new ConversationCoordinator(
    store,
    [codex, claude, hermes],
    new GitWorkspaceManager(store),
    { contextAccess }
  );
  const history = new HistorySyncService(store, [codex, claude, hermes]);
  // Every request writes an audit row and nothing removed them, so the table
  // grew for as long as the daemon ran. Prune at start and daily thereafter.
  const pruneAudit = () => {
    try {
      const removed = store.pruneAuditLog();
      if (removed > 0) log("audit-pruned", { removed });
    } catch (error) {
      log("audit-prune-failed", {
        error: error instanceof Error ? error.message : "Unknown audit prune failure"
      });
    }
  };
  pruneAudit();
  const auditPruneTimer = setInterval(pruneAudit, 24 * 60 * 60_000);
  auditPruneTimer.unref?.();
  const abort = new AbortController();
  let revocationStarted = false;
  let revocationDeviceId: string | undefined;
  let revocationRetryTimer: ReturnType<typeof setTimeout> | undefined;

  const finishPairingRevocation = async (): Promise<void> => {
    if (revocationStarted || config.pairing === null) return;
    revocationStarted = true;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await completePairingRevocation({ config, configPath, secretStore, store });
        config = { ...config, pairing: null };
        log("pairing-revoked", {
          ...(revocationDeviceId === undefined ? {} : { deviceId: revocationDeviceId }),
          contextPreserved: true,
          attempt
        });
        const timer = setTimeout(() => abort.abort(new Error("pairing-revoked")), 1_500);
        timer.unref?.();
        return;
      } catch (error) {
        log("pairing-revocation-failed", {
          ...(revocationDeviceId === undefined ? {} : { deviceId: revocationDeviceId }),
          attempt,
          error: error instanceof Error ? error.message : "Unknown pairing revocation failure"
        });
        if (attempt === 3) break;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, attempt * 1_000);
          timer.unref?.();
        });
      }
    }
    revocationStarted = false;
    log("pairing-revocation-retry-scheduled", {
      ...(revocationDeviceId === undefined ? {} : { deviceId: revocationDeviceId }),
      retryAfterSeconds: 30
    });
    revocationRetryTimer = setTimeout(() => void finishPairingRevocation(), 30_000);
    revocationRetryTimer.unref?.();
  };

  const api = new LaptopApiServer(
    coordinator,
    new DeviceAuthenticator(store),
    "127.0.0.1",
    history,
    {
      prepare: async (deviceId) => {
        await preparePairingRevocation({ config, configPath, secretStore, store, deviceId });
        revocationDeviceId = deviceId;
        config = await loadDaemonRuntimeConfig(configPath);
        log("pairing-revocation-prepared", { deviceId, contextPreserved: true });
      },
      complete: finishPairingRevocation
    }
  );
  const context = new ContextService(
    contextSocket,
    store,
    contextIssuer
  );
  const hostKey = privateKeyFromProtobuf(Buffer.from(secrets.hostTransportPrivateKey, "base64url"));
  if (hostKey.type !== "Ed25519") throw new Error("Host transport identity must be Ed25519");
  const endpoint = new NoiseEndpoint(hostKey);
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (reason: string): Promise<void> => {
    shutdownPromise ??= performShutdown(reason);
    return shutdownPromise;
  };
  const performShutdown = async (reason: string) => {
    log("stopping", { reason });
    clearInterval(auditPruneTimer);
    if (revocationRetryTimer !== undefined) clearTimeout(revocationRetryTimer);
    abort.abort(new Error(reason));
    await Promise.allSettled([
      api.stop(),
      context.stop()
    ]);
    await history.stopMonitoring();
    await Promise.allSettled([
      codex.close(),
      claude.close(),
      hermes.close()
    ]);
    store.close();
    await writeStatus(config.dataDirectory, {
      version: 1,
      state: "offline",
      pid: process.pid,
      stoppedAt: new Date().toISOString(),
      reason
    });
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const address = await api.start(config.apiPort);
    await context.start();
    await writeStatus(config.dataDirectory, {
      version: 1,
      state: "online",
      pid: process.pid,
      apiBaseUrl: address.baseUrl,
      relayWebSocketUrl: config.pairing?.relayWebSocketUrl ?? null,
      routingId: config.pairing?.routingId ?? null,
      contextSocket,
      startedAt: new Date().toISOString()
    });
    log("online", { apiBaseUrl: address.baseUrl, transportPeerId: endpoint.peerId.toString() });
    history.startMonitoring();
    log("history-import-started", {});
    void history.syncAll().then((historyStatus) => {
      log("history-import-completed", {
        state: historyStatus.state,
        providers: historyStatus.providers.map((provider) => ({
          provider: provider.provider,
          state: provider.state,
          discovered: provider.discovered,
          imported: provider.imported,
          ...(provider.error === null ? {} : { error: provider.error })
        }))
      });
    }).catch((error: unknown) => {
      log("history-import-failed", {
        error: error instanceof Error ? error.message : "Unknown history import failure"
      });
    });
    if (config.pairing === null) {
      log("unpaired", { contextPreserved: true });
      await waitForAbort(abort.signal);
    } else if (config.pairing.revocationPending === true) {
      void finishPairingRevocation();
      await waitForAbort(abort.signal);
    } else {
      const connector = new RelayHostConnector({
        relayWebSocketUrl: config.pairing.relayWebSocketUrl,
        routingId: config.pairing.routingId,
        accessToken: await secretStore.get(secretAccount.hostRelayAccess(config.secretAccountPrefix)),
        endpoint,
        expectedDevicePeer: peerIdFromString(config.pairing.expectedDevicePeerId),
        laptopBaseUrl: address.baseUrl,
        onState: (state, detail) => log("relay", { state, ...(detail === undefined ? {} : { detail }) })
      });
      await connector.run(abort.signal);
    }
  } finally {
    await shutdown("runtime-ended");
  }
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function writeStatus(directory: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.runtime-status-${process.pid}.json`);
  const destination = join(directory, "runtime-status.json");
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

function log(event: string, detail: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    at: new Date().toISOString(),
    event: "fatal",
    error: error instanceof Error ? error.message : "Unknown startup failure"
  })}\n`);
  process.exitCode = 1;
});
