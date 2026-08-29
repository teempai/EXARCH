import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CanonicalStore } from "../../../packages/core/src/index.js";
import { loadDaemonRuntimeConfig } from "../../../services/daemon/src/runtime-config.js";
import { KeychainCommandSecretStore, loadDaemonCoreSecrets } from "../../../services/daemon/src/secret-store.js";

export interface ProjectAdminOptions {
  configPath?: string;
  keychainHelper?: string;
}

export async function openProjectAdmin(options: ProjectAdminOptions = {}): Promise<CanonicalStore> {
  const configPath =
    options.configPath ??
    join(homedir(), "Library", "Application Support", "EXARCH", "config.json");
  const config = await loadDaemonRuntimeConfig(configPath);
  const helper =
    options.keychainHelper ??
    process.env.EXARCH_KEYCHAIN_HELPER ??
    fileURLToPath(new URL("../../../../bin/exarch-keychain", import.meta.url));
  const secrets = await loadDaemonCoreSecrets(
    config.secretAccountPrefix,
    new KeychainCommandSecretStore(helper)
  );
  return new CanonicalStore(join(config.dataDirectory, "context.sqlite"), {
    requireEncrypted: config.requireEncryptedStorage,
    encryptionKey: Buffer.from(secrets.databaseEncryptionKey, "base64url")
  });
}
