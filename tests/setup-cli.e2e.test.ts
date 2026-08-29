import { execFile, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromString } from "@libp2p/peer-id";
import { describe, expect, it } from "vitest";
import type { PairingInvitation } from "../packages/protocol/src/index.js";
import {
  NoiseEndpoint,
  connectEncryptedRelay,
  pairDevice
} from "../packages/relay/src/index.js";
import { p256Signer } from "../services/daemon/src/index.js";
import {
  OpaqueRelayServer,
  RelayAccessAuthority,
  RelayTicketAuthority
} from "../services/relay/src/index.js";

interface SetupEvent {
  event: string;
  [key: string]: unknown;
}

const execFileAsync = promisify(execFile);

describe.sequential("exarch-setup CLI", () => {
  it("accepts the administrator token over stdin and completes the real pairing protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "exarch-setup-cli-"));
    const configPath = join(root, "config.json");
    const dataDirectory = join(root, "data");
    const secretDirectory = join(root, "secrets");
    await mkdir(secretDirectory, { mode: 0o700 });
    const helper = join(process.cwd(), "services/daemon/src/fixtures/secret-store-helper.mjs");
    await chmod(helper, 0o700);
    const cliEnvironment = {
      ...process.env,
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
      EXARCH_KEYCHAIN_HELPER: helper,
      EXARCH_TEST_SECRET_DIR: secretDirectory
    };
    await expect(runSetupCLI(
      ["initialize", "--config", configPath, "--data-dir", dataDirectory],
      cliEnvironment
    )).resolves.toMatchObject({
      event: "setup.initialized",
      configPath,
      dataDirectory,
      paired: false
    });
    expect(await readdir(secretDirectory)).toHaveLength(3);

    const relaySecret = randomBytes(32);
    const adminToken = randomBytes(32).toString("base64url");
    const tickets = new RelayTicketAuthority(relaySecret);
    const relay = new OpaqueRelayServer(tickets, undefined, {
      adminToken,
      access: new RelayAccessAuthority(relaySecret, tickets)
    });
    const relayAddress = await relay.start();
    const deviceTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const devicePair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const signer = p256Signer(devicePair.privateKey, devicePair.publicKey);
    let child: ChildProcess | undefined;
    let stderr = "";
    try {
      child = spawn(
        process.execPath,
        [
          join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
          join(process.cwd(), "apps/setup-cli/src/main.ts"),
          "pair",
          "--relay-url", relayAddress.wsUrl,
          "--config", configPath,
          "--data-dir", dataDirectory
        ],
        {
          cwd: process.cwd(),
          env: cliEnvironment,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      const events = new SetupEventReader(child);

      expect((await events.next("setup.admin_token_required")).event).toBe("setup.admin_token_required");
      child.stdin?.write(`${adminToken}\n`);
      const invitationEvent = await events.next("pair.invitation");
      const invitation = invitationEvent.invitation as PairingInvitation;
      expect(JSON.parse(String(invitationEvent.invitationText))).toEqual(invitation);

      let resolveDeviceSas: (sas: string) => void = () => undefined;
      const deviceSasReady = new Promise<string>((resolve) => {
        resolveDeviceSas = resolve;
      });
      const mobile = (async () => {
        const connection = await connectEncryptedRelay({
          wsUrl: invitation.relayWebSocketUrl,
          routingId: invitation.routingId,
          role: "device",
          ticket: invitation.deviceTicket,
          endpoint: deviceTransport,
          handshake: "initiator",
          expectedRemote: peerIdFromString(invitation.hostTransportPeerId)
        });
        try {
          return await pairDevice(
            connection.channel,
            invitation,
            {
              deviceId: "device_setup_cli",
              displayName: "CLI test phone",
              signingKey: signer,
              approvalPublicKey: signer.publicKey
            },
            async (sas) => {
              resolveDeviceSas(sas);
              return true;
            }
          );
        } finally {
          await connection.close();
        }
      })();

      const sasEvent = await events.next("pair.sas");
      const deviceSas = await deviceSasReady;
      expect(sasEvent.sas).toBe(deviceSas);
      child.stdin?.write("yes\n");
      const complete = await events.next("pair.complete");
      const paired = await mobile;
      expect(complete.deviceId).toBe("device_setup_cli");
      expect(paired.sas).toBe(deviceSas);
      expect(await waitForExit(child)).toBe(0);

      const config = await readFile(configPath, "utf8");
      expect(config).not.toContain(adminToken);
      expect(stderr).not.toContain(adminToken);
      expect(events.raw).not.toContain(adminToken);
      expect(await readdir(secretDirectory)).toHaveLength(4);
      expect((await readFile(join(dataDirectory, "context.sqlite"))).includes(Buffer.from("CLI test phone"))).toBe(false);

      const projectRoot = join(root, "workspace");
      await mkdir(projectRoot, { mode: 0o700 });
      const resolvedProjectRoot = await realpath(projectRoot);
      const listed = await runSetupCLI(["devices", "--config", configPath], cliEnvironment);
      expect(listed).toMatchObject({
        event: "devices.listed",
        devices: [{ id: "device_setup_cli", displayName: "CLI test phone", status: "active" }]
      });
      const revoked = await runSetupCLI(
        ["revoke", "--device-id", "device_setup_cli", "--config", configPath],
        cliEnvironment
      );
      expect(revoked).toMatchObject({
        event: "device.revoked",
        id: "device_setup_cli",
        status: "revoked",
        revokedAt: expect.any(String)
      });
      const after = await runSetupCLI(["devices", "--config", configPath], cliEnvironment);
      expect(after).toMatchObject({
        event: "devices.listed",
        devices: [{ id: "device_setup_cli", status: "revoked", revokedAt: expect.any(String) }]
      });
      const added = await runSetupCLI(
        [
          "project-add",
          "--name", "Laptop project",
          "--repo-root", projectRoot,
          "--config", configPath
        ],
        cliEnvironment
      );
      expect(added).toMatchObject({
        event: "project.added",
        name: "Laptop project",
        repoRoot: resolvedProjectRoot,
        allowedPaths: [resolvedProjectRoot]
      });
      const projects = await runSetupCLI(["projects", "--config", configPath], cliEnvironment);
      expect(projects).toMatchObject({
        event: "projects.listed",
        projects: [{ id: added.id, name: "Laptop project", repoRoot: resolvedProjectRoot }]
      });
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      await relay.stop();
    }
  }, 20_000);
});

async function runSetupCLI(arguments_: string[], environment: NodeJS.ProcessEnv): Promise<SetupEvent> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
      join(process.cwd(), "apps/setup-cli/src/main.ts"),
      ...arguments_
    ],
    { cwd: process.cwd(), env: environment, maxBuffer: 1024 * 1024 }
  );
  expect(stderr).toBe("");
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as SetupEvent;
}

class SetupEventReader {
  readonly #iterator: AsyncIterator<string>;
  raw = "";

  constructor(child: ChildProcess) {
    if (child.stdout === null) throw new Error("Setup stdout is unavailable");
    this.#iterator = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  }

  async next(expected: string): Promise<SetupEvent> {
    while (true) {
      const line = await this.#iterator.next();
      if (line.done) throw new Error(`Setup ended before ${expected}`);
      this.raw += `${line.value}\n`;
      const event = JSON.parse(line.value) as SetupEvent;
      if (event.event === expected) return event;
    }
  }
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Setup process did not exit")), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
