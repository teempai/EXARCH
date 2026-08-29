import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromString } from "@libp2p/peer-id";
import {
  CanonicalStore,
  DeviceAuthenticator,
  encodeP256DevicePublicKey,
  x963P256PublicKey
} from "../packages/core/src/index.js";
import {
  NoiseEndpoint,
  connectEncryptedRelay,
  type PairingPayloadSigner
} from "../packages/relay/src/index.js";
import {
  ConversationCoordinator,
  DeterministicProviderAdapter,
  LaptopApiServer,
  PairingHost,
  RelayHostConnector
} from "../services/daemon/src/index.js";
import {
  OpaqueRelayServer,
  RelayAccessAuthority,
  RelayTicketAuthority
} from "../services/relay/src/index.js";

interface NativeHello {
  deviceID: string;
  transportPeerID: string;
  signingPublicKey: string;
  approvalPublicKey: string;
}

interface NativeResult {
  providerCount: number;
  providers: string[];
}

const executable = fileURLToPath(
  new URL("../native/.build/debug/exarch-native-interop", import.meta.url)
);
const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
let output = "";
let errorOutput = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => { output += chunk; });
child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });

const store = new CanonicalStore(":memory:");
let laptop: LaptopApiServer | undefined;
let relay: OpaqueRelayServer | undefined;
try {
  const hello = await waitForJSONLine<NativeHello>(() => output, () => child.exitCode);
  const coordinator = new ConversationCoordinator(store, [
    new DeterministicProviderAdapter("codex"),
    new DeterministicProviderAdapter("claude"),
    new DeterministicProviderAdapter("hermes")
  ]);
  laptop = new LaptopApiServer(coordinator, new DeviceAuthenticator(store));
  const laptopAddress = await laptop.start();

  const secret = randomBytes(32);
  const tickets = new RelayTicketAuthority(secret);
  const access = new RelayAccessAuthority(secret, tickets);
  const route = access.issueRoute();
  relay = new OpaqueRelayServer(tickets, undefined, {
    adminToken: randomBytes(32).toString("base64url"),
    access
  });
  const relayAddress = await relay.start();
  const hostTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
  const pairingHost = new PairingHost({
    store,
    hostSigningKey: softwareP256Signer(),
    hostTransportPeerId: hostTransport.peerId.toString(),
    confirm: async () => true
  });
  const invitation = pairingHost.createInvitation({
    relayWebSocketUrl: relayAddress.wsUrl,
    routingId: route.routingId,
    deviceTicket: route.deviceTicket,
    deviceAccessToken: route.deviceAccessToken
  });
  const hostPairingConnection = connectEncryptedRelay({
    wsUrl: relayAddress.wsUrl,
    routingId: route.routingId,
    role: "host",
    ticket: route.hostTicket,
    endpoint: hostTransport,
    handshake: "responder",
    expectedRemote: peerIdFromString(hello.transportPeerID)
  });
  child.stdin.write(`${JSON.stringify({ invitation })}\n`);
  const pairingConnection = await hostPairingConnection;
  await pairingHost.accept(pairingConnection.channel);
  await pairingConnection.close();

  const connector = new RelayHostConnector({
    relayWebSocketUrl: relayAddress.wsUrl,
    routingId: route.routingId,
    accessToken: route.hostAccessToken,
    endpoint: hostTransport,
    expectedDevicePeer: peerIdFromString(hello.transportPeerID),
    laptopBaseUrl: laptopAddress.baseUrl
  });
  const serving = connector.serveOnce();
  const result = await waitForJSONLine<NativeResult>(
    () => output.split("\n").slice(1).join("\n"),
    () => child.exitCode
  );
  const exitCode = child.exitCode ?? await new Promise<number | null>((resolve) => child.once("exit", resolve));
  await serving;
  if (exitCode !== 0) throw new Error(`Native process exited ${exitCode}: ${errorOutput}`);
  if (result.providerCount !== 3 || result.providers.join(",") !== "claude,codex,hermes") {
    throw new Error(`Unexpected native result: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`Swift/JavaScript encrypted relay interoperability passed: ${JSON.stringify(result)}\n`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all([laptop?.stop(), relay?.stop()]);
  store.close();
}

function softwareP256Signer(): PairingPayloadSigner {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: encodeP256DevicePublicKey(x963P256PublicKey(pair.publicKey)),
    async sign(payload) {
      return sign("sha256", payload, pair.privateKey).toString("base64url");
    }
  };
}

async function waitForJSONLine<T>(
  current: () => string,
  exitCode: () => number | null,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = current().split("\n").find((candidate) => candidate.trim() !== "");
    if (line !== undefined) return JSON.parse(line) as T;
    if (exitCode() !== null) throw new Error(`Native client exited before producing output: ${errorOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for native client output: ${errorOutput}`);
}
