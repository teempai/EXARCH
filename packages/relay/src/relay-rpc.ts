import { createId } from "../../protocol/src/index.js";
import type { NoiseChannel } from "./noise-channel.js";
import {
  ApplicationFrameDecoder,
  decodeBody,
  encodeBody,
  sendApplicationFrame,
  type RelayHttpRequestFrame,
  type RelayHttpResponseFrame
} from "./application-protocol.js";

const MAX_PENDING_REQUESTS = 64;

export interface RelayHttpRequest {
  method: "GET" | "POST";
  path: string;
  headers?: RelayHttpRequestFrame["headers"];
  body?: Uint8Array;
}

export interface RelayHttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

interface PendingRequest {
  resolve: (response: RelayHttpResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RelayRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pump: Promise<void>;
  private closed = false;

  constructor(
    private readonly channel: NoiseChannel,
    private readonly timeoutMs = 30_000
  ) {
    this.pump = this.readResponses();
  }

  async request(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    if (this.closed) throw new Error("Relay RPC client is closed");
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw new Error("Relay RPC request limit reached");
    const requestId = createId("request");
    const response = new Promise<RelayHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Relay RPC request timed out"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
    });
    try {
      sendApplicationFrame(this.channel, {
        version: 1,
        type: "http.request",
        requestId,
        method: request.method,
        path: request.path,
        headers: request.headers ?? {},
        body: encodeBody(request.body ?? Buffer.alloc(0))
      });
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
      }
      throw error;
    }
    return response;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.channel.close();
    }
    await this.pump;
  }

  private async readResponses(): Promise<void> {
    const decoder = new ApplicationFrameDecoder();
    try {
      for await (const chunk of this.channel.frames()) {
        for (const frame of decoder.push(chunk)) {
          if (frame.type !== "http.response") throw new Error("RPC client received a request frame");
          const pending = this.pending.get(frame.requestId);
          if (pending === undefined) throw new Error("RPC client received an unknown response ID");
          clearTimeout(pending.timer);
          this.pending.delete(frame.requestId);
          pending.resolve({
            status: frame.status,
            contentType: frame.contentType,
            body: decodeBody(frame.body)
          });
        }
      }
      decoder.finish();
      if (!this.closed) throw new Error("Encrypted relay connection closed unexpectedly");
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Encrypted relay connection failed");
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(failure);
      }
      this.pending.clear();
    }
  }
}

export class RelayRpcServer {
  constructor(
    private readonly channel: NoiseChannel,
    private readonly handler: (request: RelayHttpRequest) => Promise<RelayHttpResponse>
  ) {}

  async serve(): Promise<void> {
    const decoder = new ApplicationFrameDecoder();
    for await (const chunk of this.channel.frames()) {
      for (const frame of decoder.push(chunk)) {
        if (frame.type !== "http.request") throw new Error("RPC server received a response frame");
        await this.respond(frame);
      }
    }
    decoder.finish();
  }

  private async respond(frame: RelayHttpRequestFrame): Promise<void> {
    let response: RelayHttpResponse;
    try {
      response = await this.handler({
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        body: decodeBody(frame.body)
      });
    } catch {
      response = {
        status: 502,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from('{"error":"laptop_bridge_failed"}\n', "utf8")
      };
    }
    const outgoing: RelayHttpResponseFrame = {
      version: 1,
      type: "http.response",
      requestId: frame.requestId,
      status: response.status,
      contentType: response.contentType,
      body: encodeBody(response.body)
    };
    sendApplicationFrame(this.channel, outgoing);
  }
}
