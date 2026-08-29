import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CanonicalStore } from "../../../packages/core/src/index.js";
import { loadDaemonRuntimeConfig } from "../../../services/daemon/src/runtime-config.js";
import { KeychainCommandSecretStore, loadDaemonCoreSecrets } from "../../../services/daemon/src/secret-store.js";

export interface DeviceAdminOptions {
  configPath?: string;
  keychainHelper?: string;
}

export interface DeviceAdmin {
  store: CanonicalStore;
  close(): void;
}

export async function openDeviceAdmin(options: DeviceAdminOptions = {}): Promise<DeviceAdmin> {
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
  const store = new CanonicalStore(join(config.dataDirectory, "context.sqlite"), {
    requireEncrypted: config.requireEncryptedStorage,
    encryptionKey: Buffer.from(secrets.databaseEncryptionKey, "base64url")
  });
  return {
    store,
    close() {
      store.close();
    }
  };
}

export function publicDeviceView(device: ReturnType<CanonicalStore["getDevice"]>) {
  return {
    id: device.id,
    displayName: device.displayName,
    status: device.status,
    capabilities: device.capabilities,
    createdAt: device.createdAt,
    revokedAt: device.revokedAt,
    lastCounter: device.lastCounter,
    signingPublicKey: device.signingPublicKey,
    approvalPublicKey: device.approvalPublicKey
  };
}
