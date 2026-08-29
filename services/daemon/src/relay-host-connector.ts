import type { PeerId } from "@libp2p/interface";
import {
  NoiseEndpoint,
  RelayRpcServer,
  connectEncryptedRelay,
  requestRelayTicket
} from "../../../packages/relay/src/index.js";
import { RelayHttpBridge } from "./relay-http-bridge.js";

export type RelayConnectorState =
  | "stopped"
  | "requesting-ticket"
  | "connecting"
  | "online"
  | "reconnecting";

export interface RelayHostConnectorOptions {
  relayWebSocketUrl: string;
  routingId: string;
  accessToken: string;
  endpoint: NoiseEndpoint;
  expectedDevicePeer: PeerId;
  laptopBaseUrl: string;
  onState?: (state: RelayConnectorState, detail?: string) => void;
  requestTicket?: typeof requestRelayTicket;
  connect?: typeof connectEncryptedRelay;
  bridge?: RelayHttpBridge;
}

export class RelayHostConnector {
  private readonly bridge: RelayHttpBridge;
  private readonly ticketRequest: typeof requestRelayTicket;
  private readonly connect: typeof connectEncryptedRelay;

  constructor(private readonly options: RelayHostConnectorOptions) {
    this.bridge = options.bridge ?? new RelayHttpBridge(options.laptopBaseUrl);
    this.ticketRequest = options.requestTicket ?? requestRelayTicket;
    this.connect = options.connect ?? connectEncryptedRelay;
  }

  async serveOnce(signal?: AbortSignal): Promise<void> {
    this.options.onState?.("requesting-ticket");
    const credential = await this.ticketRequest(
      this.options.relayWebSocketUrl,
      this.options.accessToken,
      { routingId: this.options.routingId, role: "host" }
    );
    this.options.onState?.("connecting");
    const connection = await this.connect({
      wsUrl: this.options.relayWebSocketUrl,
      routingId: this.options.routingId,
      role: "host",
      ticket: credential.ticket,
      endpoint: this.options.endpoint,
      handshake: "responder",
      expectedRemote: this.options.expectedDevicePeer,
      ...(signal === undefined ? {} : { signal })
    });
    try {
      this.options.onState?.("online");
      await new RelayRpcServer(connection.channel, (request) => this.bridge.handle(request)).serve();
    } finally {
      await connection.close();
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.serveOnce(signal);
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        this.options.onState?.(
          "reconnecting",
          error instanceof Error ? error.message : "Relay connection failed"
        );
      }
      if (signal.aborted) break;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
      await waitForRetry(delay, signal);
    }
    this.options.onState?.("stopped");
  }
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
