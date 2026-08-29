import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDaemonRuntimeConfig } from "./runtime-config.js";

const valid = {
  version: 1,
  dataDirectory: "/tmp/exarch-data",
  relayWebSocketUrl: "wss://relay.example/v1/relay",
  routingId: "a".repeat(43),
  expectedDevicePeerId: "12D3KooWNativeDeviceIdentity",
  secretAccountPrefix: "s".repeat(32),
  apiPort: 32_146,
  requireEncryptedStorage: true
};

describe("daemon runtime config", () => {
  it("accepts only a private, owned, strict production configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-config-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 });
    await expect(loadDaemonRuntimeConfig(path)).resolves.toEqual({
      version: 2,
      dataDirectory: valid.dataDirectory,
      secretAccountPrefix: valid.secretAccountPrefix,
      apiPort: valid.apiPort,
      requireEncryptedStorage: valid.requireEncryptedStorage,
      pairing: {
        relayWebSocketUrl: valid.relayWebSocketUrl,
        routingId: valid.routingId,
        expectedDevicePeerId: valid.expectedDevicePeerId
      }
    });
    await chmod(path, 0o644);
    await expect(loadDaemonRuntimeConfig(path)).rejects.toThrow(/permissions/);
  });

  it("rejects plaintext remote relays, ambiguous URLs, and relative data paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-config-invalid-"));
    for (const [name, changes] of [
      ["plaintext", { relayWebSocketUrl: "ws://relay.example/v1/relay" }],
      ["query", { relayWebSocketUrl: "wss://relay.example/v1/relay?token=secret" }],
      ["credentials", { relayWebSocketUrl: "wss://user:pass@relay.example/v1/relay" }],
      ["invalid-url", { relayWebSocketUrl: "not a url" }],
      ["relative", { dataDirectory: "./data" }]
    ] as const) {
      const path = join(directory, `${name}.json`);
      await writeFile(path, JSON.stringify({ ...valid, ...changes }), { mode: 0o600 });
      await expect(loadDaemonRuntimeConfig(path)).rejects.toThrow();
    }
  });

  it("accepts an explicit unpaired state without discarding laptop storage configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-config-unpaired-"));
    const path = join(directory, "config.json");
    const unpaired = {
      version: 2,
      dataDirectory: "/tmp/exarch-data",
      secretAccountPrefix: "s".repeat(32),
      apiPort: 32_146,
      requireEncryptedStorage: true,
      pairing: null
    };
    await writeFile(path, JSON.stringify(unpaired), { mode: 0o600 });
    await expect(loadDaemonRuntimeConfig(path)).resolves.toEqual(unpaired);
  });

  it("preserves a durable pending-revocation tombstone across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-config-revocation-"));
    const path = join(directory, "config.json");
    const pending = {
      version: 2,
      dataDirectory: "/tmp/exarch-data",
      secretAccountPrefix: "s".repeat(32),
      apiPort: 32_146,
      requireEncryptedStorage: true,
      pairing: {
        relayWebSocketUrl: "wss://relay.example/v1/relay",
        routingId: "a".repeat(43),
        expectedDevicePeerId: "12D3KooWNativeDeviceIdentity",
        revocationPending: true
      }
    };
    await writeFile(path, JSON.stringify(pending), { mode: 0o600 });
    await expect(loadDaemonRuntimeConfig(path)).resolves.toEqual(pending);
  });

  it("rejects non-files and implausibly sized files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-config-shape-"));
    await expect(loadDaemonRuntimeConfig(directory)).rejects.toThrow(/regular file/);

    const emptyPath = join(directory, "empty.json");
    await writeFile(emptyPath, "", { mode: 0o600 });
    await expect(loadDaemonRuntimeConfig(emptyPath)).rejects.toThrow(/size/);

    const oversizedPath = join(directory, "oversized.json");
    await writeFile(oversizedPath, "x".repeat(65 * 1024), { mode: 0o600 });
    await expect(loadDaemonRuntimeConfig(oversizedPath)).rejects.toThrow(/size/);
  });
});
