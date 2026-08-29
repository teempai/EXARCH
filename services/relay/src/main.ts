import { createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpaqueRelayServer } from "./relay-server.js";
import { RelayAccessAuthority } from "./relay-access.js";
import { RelayTicketAuthority } from "./relay-ticket.js";
import { FileRelayRevocationStore } from "./relay-revocation-store.js";
import { assertRelayDeployment, relayTrustProxy } from "./deployment.js";

const rootSecret = requiredSecret("EXARCH_RELAY_SECRET", "MRA_RELAY_SECRET");
const adminToken = requiredText("EXARCH_RELAY_ADMIN_TOKEN", 32, "MRA_RELAY_ADMIN_TOKEN");
const ticketSecret = derive(rootSecret, "ticket-authority");
const accessSecret = derive(rootSecret, "access-authority");
const legacyAccessSecret = deriveLegacy(rootSecret, "access-authority");
const tickets = new RelayTicketAuthority(ticketSecret);
const revocations = await FileRelayRevocationStore.open(
  process.env.EXARCH_RELAY_STATE_PATH ?? join(homedir(), ".exarch", "relay-state.json")
);
const access = new RelayAccessAuthority(accessSecret, tickets, () => new Date(), revocations, [
  { secret: legacyAccessSecret, domain: "mobile-remote-agent/relay-access/1\0" }
]);
const port = parsePort(process.env.EXARCH_RELAY_PORT ?? "8787");
const host = process.env.EXARCH_RELAY_HOST ?? "127.0.0.1";
const trustedProxy = relayTrustProxy(process.env.EXARCH_RELAY_TRUST_PROXY);
assertRelayDeployment(host, trustedProxy);
// Optional: the peer addresses allowed to assert x-forwarded-proto. Set it to
// the proxy's address on the container network and the header stops being a
// claim any client can make. Unset keeps the previous behaviour.
const proxyAddresses = (process.env.EXARCH_RELAY_PROXY_ADDRESSES ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const relay = new OpaqueRelayServer(
  tickets,
  undefined,
  { adminToken, access },
  { trustedProxy, proxyAddresses }
);

const address = await relay.start(port, host);
process.stdout.write(`${JSON.stringify({ event: "relay.started", ...address })}\n`);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${JSON.stringify({ event: "relay.stopping", signal })}\n`);
  await relay.stop();
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

function requiredSecret(name: string, legacyName?: string): Buffer {
  const value = requiredText(name, 43, legacyName);
  const secret = Buffer.from(value, "base64url");
  if (secret.byteLength < 32 || secret.toString("base64url") !== value) {
    throw new Error(`${name} must be canonical base64url encoding of at least 32 random bytes`);
  }
  return secret;
}

function requiredText(name: string, minimumLength: number, legacyName?: string): string {
  const value = process.env[name] ?? (legacyName === undefined ? undefined : process.env[legacyName]);
  if (value === undefined || value.length < minimumLength) throw new Error(`${name} is required`);
  return value;
}

function derive(secret: Buffer, purpose: string): Buffer {
  return createHmac("sha256", secret)
    .update(`exarch/relay/${purpose}/1`, "utf8")
    .digest();
}

function deriveLegacy(secret: Buffer, purpose: string): Buffer {
  return createHmac("sha256", secret)
    .update(`mobile-remote-agent/relay/${purpose}/1`, "utf8")
    .digest();
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("EXARCH_RELAY_PORT is invalid");
  return port;
}
