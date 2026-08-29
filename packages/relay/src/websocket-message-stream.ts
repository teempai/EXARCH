import { defaultLogger } from "@libp2p/logger";
import { AbstractMessageStream, type SendResult } from "@libp2p/utils";
import type { MessageStreamDirection } from "@libp2p/interface";
import type { Uint8ArrayList } from "uint8arraylist";
import WebSocket, { type RawData } from "ws";

const MAX_TRANSPORT_BUFFER_BYTES = 1024 * 1024;

export class WebSocketMessageStream extends AbstractMessageStream {
  constructor(
    private readonly socket: WebSocket,
    direction: MessageStreamDirection
  ) {
    super({
      direction,
      log: defaultLogger().forComponent(`exarch:relay-websocket:${direction}`),
      maxMessageSize: 70 * 1024,
      maxReadBufferLength: MAX_TRANSPORT_BUFFER_BYTES,
      maxWriteBufferLength: MAX_TRANSPORT_BUFFER_BYTES
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const bytes = rawData(data);
      if (bytes.byteLength > 70 * 1024) {
        this.abort(new Error("Relay transport frame exceeded its limit"));
        return;
      }
      this.onData(bytes);
    });
    socket.once("close", () => this.onTransportClosed());
    socket.once("error", (error) => this.onTransportClosed(error));
    socket.once("open", () => this.onMuxerDrain());
  }

  sendData(data: Uint8ArrayList): SendResult {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return { sentBytes: 0, canSendMore: false };
    }
    const bytes = data.subarray();
    this.socket.send(bytes, { binary: true, compress: false }, (error) => {
      // ws invokes successful callbacks with null at runtime even though its
      // declaration models the value as Error | undefined.
      if (error != null) this.onTransportClosed(error);
      else if (this.socket.bufferedAmount < MAX_TRANSPORT_BUFFER_BYTES) this.onMuxerDrain();
    });
    return {
      sentBytes: bytes.byteLength,
      canSendMore: this.socket.bufferedAmount < MAX_TRANSPORT_BUFFER_BYTES
    };
  }

  sendReset(_error: Error): void {
    this.socket.close(1011, "Encrypted stream reset");
  }

  sendPause(): void {
    this.socket.pause();
  }

  sendResume(): void {
    this.socket.resume();
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.onTransportClosed();
      return;
    }
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close(1000, "Encrypted stream closed");
    });
  }
}

function rawData(value: RawData): Uint8Array {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Buffer.concat(value);
  throw new Error("Unsupported WebSocket frame representation");
}
