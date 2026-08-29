import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KeychainCommandSecretStore,
  loadDaemonSecrets,
  secretAccount
} from "./secret-store.js";

describe("Keychain command bridge", () => {
  it("keeps secret values on stdin and loads a complete validated set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-secret-store-"));
    const helper = join(process.cwd(), "services/daemon/src/fixtures/secret-store-helper.mjs");
    await chmod(helper, 0o700);
    const store = new KeychainCommandSecretStore(helper, {
      ...process.env,
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
      EXARCH_TEST_SECRET_DIR: directory
    });
    const prefix = "p".repeat(32);
    await store.put(secretAccount.databaseKey(prefix), "d".repeat(43));
    await store.put(secretAccount.contextCapability(prefix), "c".repeat(43));
    await store.put(secretAccount.hostTransport(prefix), "aGVsbG8");
    await store.put(secretAccount.hostRelayAccess(prefix), "r".repeat(32));
    await expect(loadDaemonSecrets(prefix, store)).resolves.toEqual({
      databaseEncryptionKey: "d".repeat(43),
      contextCapabilitySecret: "c".repeat(43),
      hostTransportPrivateKey: "aGVsbG8",
      hostAccessToken: "r".repeat(32)
    });
    await store.delete(secretAccount.hostRelayAccess(prefix));
    await expect(store.get(secretAccount.hostRelayAccess(prefix))).rejects.toThrow(/Keychain operation/);
  });

  it("rejects unsafe accounts and oversized values before spawning", async () => {
    expect(() => new KeychainCommandSecretStore("relative/helper")).toThrow(/absolute/);
    const store = new KeychainCommandSecretStore("/missing/helper");
    await expect(store.put("../escape", "secret")).rejects.toThrow(/account/);
    await expect(store.put("valid", "")).rejects.toThrow(/size/);
    await expect(store.put("valid", "x".repeat(9 * 1024))).rejects.toThrow(/size/);
    await expect(store.get("../escape")).rejects.toThrow(/account/);
    await expect(store.delete("../escape")).rejects.toThrow(/account/);
  });
});
