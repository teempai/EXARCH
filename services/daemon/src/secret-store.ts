import { spawn } from "node:child_process";
import { z } from "zod";

const MAX_SECRET_BYTES = 8 * 1024;

export interface SecretStore {
  put(account: string, value: string): Promise<void>;
  get(account: string): Promise<string>;
  delete(account: string): Promise<void>;
}

export class KeychainCommandSecretStore implements SecretStore {
  constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {
    if (!executable.startsWith("/")) throw new Error("Keychain helper path must be absolute");
  }

  async put(account: string, value: string): Promise<void> {
    validateAccount(account);
    if (Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      throw new Error("Secret is outside the allowed size");
    }
    await this.run("put", account, value);
  }

  async get(account: string): Promise<string> {
    validateAccount(account);
    return this.run("get", account);
  }

  async delete(account: string): Promise<void> {
    validateAccount(account);
    await this.run("delete", account);
  }

  private run(command: "put" | "get" | "delete", account: string, stdin = ""): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.executable, [command, account], {
        shell: false,
        env: this.environment,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const output: Buffer[] = [];
      let outputBytes = 0;
      let errorBytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_SECRET_BYTES) child.kill("SIGKILL");
        else output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errorBytes += chunk.byteLength;
        if (errorBytes > 4 * 1024) child.kill("SIGKILL");
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0 && outputBytes <= MAX_SECRET_BYTES) {
          resolve(Buffer.concat(output, outputBytes).toString("utf8"));
        } else {
          reject(new Error("macOS Keychain operation failed"));
        }
      });
      child.stdin.end(stdin, "utf8");
    });
  }
}

export const secretAccount = {
  databaseKey: (prefix: string) => `${prefix}.database-key`,
  contextCapability: (prefix: string) => `${prefix}.context-capability`,
  hostTransport: (prefix: string) => `${prefix}.host-transport`,
  hostRelayAccess: (prefix: string) => `${prefix}.host-relay-access`
} as const;

const DaemonCoreSecretsSchema = z.object({
  databaseEncryptionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  contextCapabilitySecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  hostTransportPrivateKey: z.string().regex(/^[A-Za-z0-9_-]+$/).max(1024)
}).strict();

const DaemonSecretsSchema = DaemonCoreSecretsSchema.extend({
  hostAccessToken: z.string().min(32).max(4096)
}).strict();

export type DaemonCoreSecrets = z.infer<typeof DaemonCoreSecretsSchema>;
export type DaemonSecrets = z.infer<typeof DaemonSecretsSchema>;

export async function loadDaemonCoreSecrets(
  prefix: string,
  store: SecretStore
): Promise<DaemonCoreSecrets> {
  const [databaseEncryptionKey, contextCapabilitySecret, hostTransportPrivateKey] = await Promise.all([
    store.get(secretAccount.databaseKey(prefix)),
    store.get(secretAccount.contextCapability(prefix)),
    store.get(secretAccount.hostTransport(prefix))
  ]);
  return DaemonCoreSecretsSchema.parse({
    databaseEncryptionKey,
    contextCapabilitySecret,
    hostTransportPrivateKey
  });
}

export async function loadDaemonSecrets(
  prefix: string,
  store: SecretStore
): Promise<DaemonSecrets> {
  const [core, hostAccessToken] = await Promise.all([
    loadDaemonCoreSecrets(prefix, store),
    store.get(secretAccount.hostRelayAccess(prefix))
  ]);
  return DaemonSecretsSchema.parse({
    ...core,
    hostAccessToken
  });
}

function validateAccount(account: string): void {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(account)) throw new Error("Keychain account is invalid");
}
