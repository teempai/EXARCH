import type { PeerId } from "@libp2p/interface";
import WebSocket from "ws";
import { assertRelayUrl } from "./relay-url.js";
import { NoiseEndpoint, type NoiseChannel } from "./noise-channel.js";
import { WebSocketMessageStream } from "./websocket-message-stream.js";

const CONNECT_TIMEOUT_MS = 10_000;

export interface EncryptedRelayConnectionOptions {
  wsUrl: string;
  routingId: string;
  role: "host" | "device";
  ticket: string;
  endpoint: NoiseEndpoint;
  handshake: "initiator" | "responder";
  expectedRemote?: PeerId;
  signal?: AbortSignal;
  counterpartTimeoutMs?: number;
}

export interface EncryptedRelayConnection {
  socket: WebSocket;
  channel: NoiseChannel;
  close(): Promise<void>;
}

export async function connectEncryptedRelay(
  options: EncryptedRelayConnectionOptions
): Promise<EncryptedRelayConnection> {
  const counterpartTimeoutMs = options.counterpartTimeoutMs ?? CONNECT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(counterpartTimeoutMs) ||
    counterpartTimeoutMs < 1_000 ||
    counterpartTimeoutMs > 10 * 60_000
  ) {
    throw new Error("Relay counterpart timeout is outside the allowed range");
  }
  const relayUrl = validateRelayUrl(options.wsUrl);
  const socket = new WebSocket(relayUrl, {
    perMessageDeflate: false,
    maxPayload: 70 * 1024,
    handshakeTimeout: CONNECT_TIMEOUT_MS
  });
  try {
    await waitForOpen(socket, options.signal);
    const transport = new WebSocketMessageStream(
      socket,
      options.handshake === "initiator" ? "outbound" : "inbound"
    );
    const ready = waitForReady(socket, counterpartTimeoutMs, options.signal);
    socket.send(
      JSON.stringify({
        type: "register",
        routingId: options.routingId,
        role: options.role,
        ticket: options.ticket
      })
    );
    await ready;
    const handshakeSignal = combineWithTimeout(options.signal, CONNECT_TIMEOUT_MS);
    const channel =
      options.handshake === "initiator"
        ? await options.endpoint.connect(transport, options.expectedRemote, handshakeSignal)
        : await options.endpoint.accept(transport, options.expectedRemote, handshakeSignal);
    const onControlMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const value = JSON.parse(data.toString()) as { type?: unknown };
        if (value.type === "counterpart.offline") transport.onTransportClosed();
      } catch {
        transport.onTransportClosed(new Error("Relay returned an invalid control message"));
      }
    };
    socket.on("message", onControlMessage);
    socket.once("close", () => socket.off("message", onControlMessage));
    return {
      socket,
      channel,
      async close() {
        await channel.close();
      }
    };
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

function validateRelayUrl(raw: string): URL {
  return assertRelayUrl(raw);
}

async function waitForOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Relay connection timed out")), CONNECT_TIMEOUT_MS);
    timeout.unref?.();
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(signal?.reason ?? new Error("Relay connection aborted"));
    const finish = (error?: unknown) => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForReady(
  socket: WebSocket,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Relay counterpart did not connect")), timeoutMs);
    timeout.unref?.();
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const value = JSON.parse(data.toString()) as { type?: unknown };
        if (value.type === "ready") finish();
        else if (value.type === "counterpart.offline") finish(new Error("Relay counterpart disconnected"));
      } catch {
        finish(new Error("Relay returned an invalid control message"));
      }
    };
    const onClose = (code: number, reason: Buffer) =>
      finish(new Error(`Relay closed registration (${code}): ${reason.toString("utf8")}`));
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(signal?.reason ?? new Error("Relay registration aborted"));
    const finish = (error?: unknown) => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combineWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
