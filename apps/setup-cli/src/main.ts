#!/usr/bin/env node
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapPairing,
  initializeLocalRuntime,
  revokePairing
} from "../../../services/daemon/src/setup.js";
import { loadDaemonRuntimeConfig } from "../../../services/daemon/src/runtime-config.js";
import { KeychainCommandSecretStore } from "../../../services/daemon/src/secret-store.js";
import { openDeviceAdmin, publicDeviceView } from "./device-admin.js";
import { enrollLocalDevice, repairLocalDevice } from "./local-device.js";
import { openProjectAdmin } from "./project-admin.js";

const applicationDirectory = join(homedir(), "Library", "Application Support", "EXARCH");
const defaultConfigPath = join(applicationDirectory, "config.json");
const defaultDataDirectory = join(applicationDirectory, "data");

process.umask(0o077);

interface PairArguments {
  relayWebSocketUrl: string;
  configPath: string;
  dataDirectory: string;
}

async function main(): Promise<void> {
  const [command = "help", ...arguments_] = process.argv.slice(2);
  if (command === "pair") {
    await pair(parsePairArguments(arguments_));
    return;
  }
  if (command === "initialize") {
    const options = parseInitializeArguments(arguments_);
    const config = await initializeLocalRuntime({
      ...options,
      secretStore: new KeychainCommandSecretStore(keychainHelperPath())
    });
    emit("setup.initialized", {
      configPath: options.configPath,
      dataDirectory: config.dataDirectory,
      paired: config.pairing !== null
    });
    return;
  }
  if (command === "status") {
    const config = await loadDaemonRuntimeConfig(defaultConfigPath);
    emit("setup.status", {
      configured: config.pairing !== null,
      relayWebSocketUrl: config.pairing?.relayWebSocketUrl ?? null,
      routingId: config.pairing?.routingId ?? null,
      expectedDevicePeerId: config.pairing?.expectedDevicePeerId ?? null,
      dataDirectory: config.dataDirectory
    });
    return;
  }
  if (command === "unpair") {
    await unpair(parseConfigArguments(arguments_));
    return;
  }
  if (command === "enroll-local") {
    await enrollLocal(parseEnrollArguments(arguments_));
    return;
  }
  if (command === "repair-local") {
    await repairLocal(parseEnrollArguments(arguments_));
    return;
  }
  if (command === "devices") {
    await listDevices(parseConfigArguments(arguments_));
    return;
  }
  if (command === "revoke") {
    await revokeDevice(parseRevokeArguments(arguments_));
    return;
  }
  if (command === "projects") {
    await listProjects(parseConfigArguments(arguments_));
    return;
  }
  if (command === "project-add") {
    await addProject(parseProjectAddArguments(arguments_));
    return;
  }
  process.stdout.write(
    "Usage: exarch-setup pair --relay-url <wss://host/v1/relay> [--config <path>] [--data-dir <path>]\n" +
      "       exarch-setup initialize [--config <path>] [--data-dir <path>]\n" +
      "       exarch-setup status\n" +
      "       exarch-setup unpair [--config <path>]\n" +
      "       exarch-setup repair-local --signing-key <key> --approval-key <key> --display-name <name> [--config <path>]\n" +
      "       exarch-setup devices [--config <path>]\n" +
      "       exarch-setup revoke --device-id <id> [--config <path>]\n" +
      "       exarch-setup projects [--config <path>]\n" +
      "       exarch-setup project-add --name <name> --repo-root <absolute-path> [--config <path>]\n"
  );
}

async function unpair(options: { configPath: string }): Promise<void> {
  const config = await loadDaemonRuntimeConfig(options.configPath);
  const secretStore = new KeychainCommandSecretStore(keychainHelperPath());
  const admin = await openDeviceAdmin({
    configPath: options.configPath,
    keychainHelper: keychainHelperPath()
  });
  try {
    const revokedDeviceIds = await revokePairing({
      config,
      configPath: options.configPath,
      secretStore,
      store: admin.store
    });
    emit("pairing.revoked", { revokedDeviceIds, contextPreserved: true });
  } finally {
    admin.close();
  }
}

async function pair(arguments_: PairArguments): Promise<void> {
  const input = createInterface({ input: process.stdin, terminal: false });
  const lines = input[Symbol.asyncIterator]();
  try {
    emit("setup.admin_token_required", {});
    const adminToken = (await lines.next()).value?.trim();
    if (adminToken === undefined || adminToken.length === 0) {
      throw new Error("Relay administrator token was not provided");
    }
    const result = await bootstrapPairing({
      relayWebSocketUrl: arguments_.relayWebSocketUrl,
      relayAdminToken: adminToken,
      configPath: arguments_.configPath,
      dataDirectory: arguments_.dataDirectory,
      secretStore: new KeychainCommandSecretStore(keychainHelperPath()),
      onInvitation(invitation) {
        emit("pair.invitation", { invitation, invitationText: JSON.stringify(invitation) });
      },
      async confirm(pending) {
        emit("pair.sas", {
          sas: pending.sas,
          deviceId: pending.deviceId,
          displayName: pending.displayName
        });
        const answer = (await lines.next()).value?.trim().toLowerCase();
        return answer === "yes" || answer === "y";
      }
    });
    emit("pair.complete", {
      deviceId: result.deviceId,
      displayName: result.deviceDisplayName,
      transportPeerId: result.transportPeerId,
      configPath: arguments_.configPath
    });
  } finally {
    input.close();
  }
}

function keychainHelperPath(): string {
  return process.env.EXARCH_KEYCHAIN_HELPER
    ?? fileURLToPath(new URL("../../../../bin/exarch-keychain", import.meta.url));
}

async function enrollLocal(options: {
  configPath: string;
  signingKey: string;
  approvalKey: string;
  displayName: string;
}): Promise<void> {
  const admin = await openDeviceAdmin({
    configPath: options.configPath,
    keychainHelper: keychainHelperPath()
  });
  try {
    const device = enrollLocalDevice({
      store: admin.store,
      signingPublicKey: options.signingKey,
      approvalPublicKey: options.approvalKey,
      displayName: options.displayName
    });
    emit("device.enrolled", publicDeviceView(device));
  } finally {
    admin.close();
  }
}

async function repairLocal(options: {
  configPath: string;
  signingKey: string;
  approvalKey: string;
  displayName: string;
}): Promise<void> {
  const admin = await openDeviceAdmin({
    configPath: options.configPath,
    keychainHelper: keychainHelperPath()
  });
  try {
    const device = repairLocalDevice({
      store: admin.store,
      signingPublicKey: options.signingKey,
      approvalPublicKey: options.approvalKey,
      displayName: options.displayName
    });
    emit("device.repaired", publicDeviceView(device));
  } finally {
    admin.close();
  }
}

function parseEnrollArguments(arguments_: string[]): {
  configPath: string;
  signingKey: string;
  approvalKey: string;
  displayName: string;
} {
  let configPath = defaultConfigPath;
  let signingKey: string | undefined;
  let approvalKey: string | undefined;
  let displayName: string | undefined;
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name ?? "argument"}`);
    if (name === "--config") configPath = resolve(value);
    else if (name === "--signing-key") signingKey = value;
    else if (name === "--approval-key") approvalKey = value;
    else if (name === "--display-name") displayName = value;
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (signingKey === undefined || approvalKey === undefined || displayName === undefined) {
    throw new Error("--signing-key, --approval-key, and --display-name are required");
  }
  return { configPath, signingKey, approvalKey, displayName };
}

async function listDevices(options: { configPath: string }): Promise<void> {
  const admin = await openDeviceAdmin({
    configPath: options.configPath,
    keychainHelper: keychainHelperPath()
  });
  try {
    emit("devices.listed", {
      devices: admin.store.listDevices().map(publicDeviceView)
    });
  } finally {
    admin.close();
  }
}

async function revokeDevice(options: { configPath: string; deviceId: string }): Promise<void> {
  const admin = await openDeviceAdmin({
    configPath: options.configPath,
    keychainHelper: keychainHelperPath()
  });
  try {
    const device = admin.store.revokeDevice(options.deviceId);
    emit("device.revoked", publicDeviceView(device));
  } finally {
    admin.close();
  }
}

async function listProjects(options: { configPath: string }): Promise<void> {
  const store = await openProjectAdmin({
    configPath: options.configPath,
    keychainHelper: keychainHelperPath()
  });
  try {
    emit("projects.listed", { projects: store.listProjects() });
  } finally {
    store.close();
  }
}

async function addProject(options: { configPath: string; name: string; repoRoot: string }): Promise<void> {
  const store = await openProjectAdmin({
    configPath: options.configPath,
    keychainHelper: keychainHelperPath()
  });
  try {
    const project = store.enrollProject({ name: options.name, repoRoot: options.repoRoot });
    emit("project.added", { ...project });
  } finally {
    store.close();
  }
}

function parseConfigArguments(arguments_: string[]): { configPath: string } {
  let configPath = defaultConfigPath;
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name ?? "argument"}`);
    if (name === "--config") configPath = resolve(value);
    else throw new Error(`Unknown argument: ${name}`);
  }
  return { configPath };
}

function parseRevokeArguments(arguments_: string[]): { configPath: string; deviceId: string } {
  let configPath = defaultConfigPath;
  let deviceId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name ?? "argument"}`);
    if (name === "--config") configPath = resolve(value);
    else if (name === "--device-id") deviceId = value;
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (deviceId === undefined || deviceId.length === 0) throw new Error("--device-id is required");
  return { configPath, deviceId };
}

function parseProjectAddArguments(arguments_: string[]): {
  configPath: string;
  name: string;
  repoRoot: string;
} {
  let configPath = defaultConfigPath;
  let projectName: string | undefined;
  let repoRoot: string | undefined;
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name ?? "argument"}`);
    if (name === "--config") configPath = resolve(value);
    else if (name === "--name") projectName = value.trim();
    else if (name === "--repo-root") repoRoot = value;
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (projectName === undefined || projectName.length === 0 || projectName.length > 200) {
    throw new Error("--name must contain between 1 and 200 characters");
  }
  if (repoRoot === undefined || !isAbsolute(repoRoot) || repoRoot.length > 4096) {
    throw new Error("--repo-root must be an absolute path no longer than 4096 characters");
  }
  return { configPath, name: projectName, repoRoot };
}

function parsePairArguments(arguments_: string[]): PairArguments {
  let relayWebSocketUrl: string | undefined;
  let configPath = defaultConfigPath;
  let dataDirectory = defaultDataDirectory;
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name ?? "argument"}`);
    if (name === "--relay-url") relayWebSocketUrl = value;
    else if (name === "--config") configPath = resolve(value);
    else if (name === "--data-dir") dataDirectory = resolve(value);
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (relayWebSocketUrl === undefined) throw new Error("--relay-url is required");
  return { relayWebSocketUrl, configPath, dataDirectory };
}

function parseInitializeArguments(arguments_: string[]): {
  configPath: string;
  dataDirectory: string;
} {
  let configPath = defaultConfigPath;
  let dataDirectory = defaultDataDirectory;
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name ?? "argument"}`);
    if (name === "--config") configPath = resolve(value);
    else if (name === "--data-dir") dataDirectory = resolve(value);
    else throw new Error(`Unknown argument: ${name}`);
  }
  return { configPath, dataDirectory };
}

function emit(event: string, detail: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    at: new Date().toISOString(),
    event: "setup.failed",
    error: error instanceof Error ? error.message : "Unknown setup failure"
  })}\n`);
  process.exitCode = 1;
});
