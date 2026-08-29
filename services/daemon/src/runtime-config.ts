import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

const RelayPairingSchema = z
  .object({
    relayWebSocketUrl: z.string().url().max(2048),
    routingId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expectedDevicePeerId: z.string().min(20).max(200),
    /** Durable tombstone: local authority is being withdrawn and relay cleanup must resume. */
    revocationPending: z.boolean().optional()
  })
  .strict()
  .superRefine((value, context) => validateRelayUrl(value.relayWebSocketUrl, context));

const RuntimeConfigV2Schema = z
  .object({
    version: z.literal(2),
    dataDirectory: z.string().min(1).max(4096),
    secretAccountPrefix: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    apiPort: z.number().int().min(1).max(65_535).default(32_146),
    requireEncryptedStorage: z.boolean().default(true),
    pairing: RelayPairingSchema.nullable()
  })
  .strict()
  .superRefine(validateDataDirectory);

const RuntimeConfigV1Schema = z
  .object({
    version: z.literal(1),
    dataDirectory: z.string().min(1).max(4096),
    relayWebSocketUrl: z.string().url().max(2048),
    routingId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expectedDevicePeerId: z.string().min(20).max(200),
    secretAccountPrefix: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    apiPort: z.number().int().min(1).max(65_535).default(32_146),
    requireEncryptedStorage: z.boolean().default(true)
  })
  .strict()
  .superRefine((value, context) => {
    validateDataDirectory(value, context);
    validateRelayUrl(value.relayWebSocketUrl, context);
  });

export type RelayPairingConfig = z.infer<typeof RelayPairingSchema>;
export type DaemonRuntimeConfig = z.infer<typeof RuntimeConfigV2Schema>;

export async function loadDaemonRuntimeConfig(path: string): Promise<DaemonRuntimeConfig> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Daemon config must be a regular file");
  if ((metadata.mode & 0o077) !== 0) throw new Error("Daemon config permissions must be 0600 or stricter");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Daemon config must be owned by the current user");
  }
  if (metadata.size <= 1 || metadata.size > 64 * 1024) throw new Error("Daemon config size is invalid");
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const version = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (version === 1) {
    const legacy = RuntimeConfigV1Schema.parse(raw);
    return {
      version: 2,
      dataDirectory: legacy.dataDirectory,
      secretAccountPrefix: legacy.secretAccountPrefix,
      apiPort: legacy.apiPort,
      requireEncryptedStorage: legacy.requireEncryptedStorage,
      pairing: {
        relayWebSocketUrl: legacy.relayWebSocketUrl,
        routingId: legacy.routingId,
        expectedDevicePeerId: legacy.expectedDevicePeerId
      }
    };
  }
  return RuntimeConfigV2Schema.parse(raw);
}

function validateDataDirectory(value: { dataDirectory: string }, context: z.RefinementCtx): void {
  if (!isAbsolute(value.dataDirectory)) {
    context.addIssue({ code: "custom", path: ["dataDirectory"], message: "must be absolute" });
  }
}

function validateRelayUrl(raw: string, context: z.RefinementCtx): void {
  try {
    const url = new URL(raw);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/v1/relay" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback))
    ) {
      context.addIssue({ code: "custom", path: ["relayWebSocketUrl"], message: "must be exact and TLS-protected" });
    }
  } catch {
    context.addIssue({ code: "custom", path: ["relayWebSocketUrl"], message: "is invalid" });
  }
}
