import { EventEmitter } from "node:events";
import { ManagedLineProcess, type ProcessExit } from "./managed-line-process.js";

export interface RpcNotification {
  method: string;
  params: unknown;
}

export interface RpcServerRequest extends RpcNotification {
  id: string | number;
}

interface RpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class JsonLineRpcClient {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<string | number, PendingRequest>();
  private nextId = 1;

  constructor(
    readonly process: ManagedLineProcess,
    private readonly requestTimeoutMs = 120_000,
    private readonly includeJsonRpc = false
  ) {
    this.events.setMaxListeners(100);
    process.onLine((line) => this.handleLine(line));
    process.onExit((exit) => this.handleExit(exit));
    process.onTransportError((error) => this.rejectAll(error));
  }

  start(): Promise<void> {
    return this.process.start();
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  onServerRequest(listener: (request: RpcServerRequest) => void): () => void {
    this.events.on("serverRequest", listener);
    return () => this.events.off("serverRequest", listener);
  }

  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  async notify(method: string, params: unknown = {}): Promise<void> {
    await this.process.writeLine(JSON.stringify(this.frame({ method, params })));
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Provider request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timer });
      void this.process.writeLine(JSON.stringify(this.frame({ id, method, params }))).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  respond(id: string | number, result: unknown): Promise<void> {
    return this.process.writeLine(JSON.stringify(this.frame({ id, result })));
  }

  respondError(id: string | number, code: number, message: string): Promise<void> {
    return this.process.writeLine(JSON.stringify(this.frame({ id, error: { code, message } })));
  }

  private frame(value: Record<string, unknown>): Record<string, unknown> {
    return this.includeJsonRpc ? { jsonrpc: "2.0", ...value } : value;
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.rejectAll(new Error("Provider emitted malformed JSON"));
      void this.process.terminate(0);
      return;
    }
    if (!isRecord(value)) return;
    const id = value.id;
    if ((typeof id === "string" || typeof id === "number") && ("result" in value || "error" in value)) {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const response = value as unknown as RpcResponse;
      if (response.error !== undefined) {
        pending.reject(new Error(response.error.message ?? `Provider request failed: ${pending.method}`));
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    if (typeof value.method !== "string") return;
    const notification = { method: value.method, params: value.params };
    if (typeof id === "string" || typeof id === "number") {
      this.events.emit("serverRequest", { ...notification, id });
    } else {
      this.events.emit("notification", notification);
    }
  }

  private handleExit(exit: ProcessExit): void {
    this.rejectAll(new Error(`Provider process exited (${exit.code ?? exit.signal ?? "unknown"})`));
    this.events.emit("exit", exit);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
