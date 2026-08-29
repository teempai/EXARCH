import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  providerApprovalActionCommitment,
  providerApprovalHandle,
  PROVIDER_PENDING_APPROVAL_LIMIT
} from "./provider-adapter.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export interface ClaudePermissionRequest {
  requestId: string;
  providerRequestId: string;
  toolName: string;
  input: Record<string, unknown>;
  actionCommitment: string;
}

interface PendingRequest extends ClaudePermissionRequest {
  socket: Socket;
  timer: NodeJS.Timeout;
}

export class ClaudePermissionBridge {
  private server: Server | null = null;
  private directory: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly onRequest: (request: ClaudePermissionRequest) => void) {}

  async start(): Promise<{ configPath: string; toolName: string }> {
    if (this.server !== null) throw new Error("Claude permission bridge is already running");
    const directory = await mkdtemp(join(tmpdir(), "exarch-claude-permission-"));
    const socketPath = join(directory, "permission.sock");
    const configPath = join(directory, "mcp.json");
    const scriptPath = fileURLToPath(new URL("./claude-permission-mcp.mjs", import.meta.url));
    const server = createServer((socket) => this.accept(socket));
    // As in ContextService: narrow the umask across listen() so the socket is
    // never briefly group- or world-reachable, independent of the host process.
    const previousUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } finally {
      process.umask(previousUmask);
    }
    await chmod(socketPath, 0o600);
    await writeFile(
      configPath,
      `${JSON.stringify({
        mcpServers: {
          exarch_permissions: {
            type: "stdio",
            command: process.execPath,
            args: [scriptPath, socketPath]
          }
        }
      })}\n`,
      { mode: 0o600 }
    );
    this.directory = directory;
    this.server = server;
    return { configPath, toolName: "mcp__exarch_permissions__approval_prompt" };
  }

  async respond(requestId: string, choice: string, actionCommitment: string): Promise<void> {
    const request = this.pending.get(requestId);
    if (request === undefined) throw new Error("Claude approval request is not pending");
    if (choice !== "allow" && choice !== "deny") throw new Error("Unsupported Claude approval choice");
    const currentCommitment = providerApprovalActionCommitment(claudeApprovalAction(request));
    if (actionCommitment !== request.actionCommitment || actionCommitment !== currentCommitment) {
      throw new Error("Claude approval action commitment mismatch");
    }
    const decision =
      choice === "allow"
        ? { behavior: "allow", updatedInput: request.input }
        : { behavior: "deny", message: "Permission denied from the paired mobile device" };
    await writeDecision(request.socket, `${JSON.stringify({ requestId: request.requestId, decision })}\n`);
    this.pending.delete(requestId);
    clearTimeout(request.timer);
  }

  async close(): Promise<void> {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.socket.end(
        `${JSON.stringify({
          requestId: request.requestId,
          decision: { behavior: "deny", message: "Permission bridge closed" }
        })}\n`
      );
    }
    this.pending.clear();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const directory = this.directory;
    this.directory = null;
    if (directory !== null) await rm(directory, { recursive: true, force: true });
  }

  private accept(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.on("error", () => {
      // Invalid or disconnected local MCP clients are denied by closing the socket.
    });
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_REQUEST_BYTES) {
        handled = true;
        socket.destroy(new Error("Claude permission request exceeded the size limit"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      try {
        const parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as unknown;
        const request = parseRequest(parsed);
        if ([...this.pending.values()].some((pending) => pending.requestId === request.requestId)) {
          throw new Error("Duplicate Claude approval request ID");
        }
        if (this.pending.size >= PROVIDER_PENDING_APPROVAL_LIMIT) {
          throw new Error("Claude pending approval limit exceeded");
        }
        const providerRequestId = providerApprovalHandle({ provider: "claude", requestId: request.requestId });
        const actionCommitment = providerApprovalActionCommitment({
          provider: "claude",
          nativeRequestId: request.requestId,
          toolName: request.toolName,
          input: request.input,
          choices: ["allow", "deny"]
        });
        const timer = setTimeout(() => {
          const pending = this.pending.get(providerRequestId);
          if (pending === undefined) return;
          this.pending.delete(providerRequestId);
          pending.socket.end(
            `${JSON.stringify({
              requestId: request.requestId,
              decision: { behavior: "deny", message: "Permission request expired" }
            })}\n`
          );
        }, APPROVAL_TIMEOUT_MS);
        timer.unref?.();
        this.pending.set(providerRequestId, {
          ...request,
          providerRequestId,
          actionCommitment,
          socket,
          timer
        });
        socket.once("close", () => {
          const pending = this.pending.get(providerRequestId);
          if (pending?.socket !== socket) return;
          this.pending.delete(providerRequestId);
          clearTimeout(pending.timer);
        });
        this.onRequest({ ...request, providerRequestId, actionCommitment });
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error("Invalid Claude permission request"));
      }
    });
  }
}

function claudeApprovalAction(request: PendingRequest): Record<string, unknown> {
  return {
    provider: "claude",
    nativeRequestId: request.requestId,
    toolName: request.toolName,
    input: request.input,
    choices: ["allow", "deny"]
  };
}

function writeDecision(socket: Socket, payload: string): Promise<void> {
  if (socket.destroyed || !socket.writable) {
    return Promise.reject(new Error("Claude permission client disconnected before the decision"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Claude permission client disconnected before the decision"));
    };
    socket.once("error", fail);
    socket.once("close", fail);
    socket.end(payload, () => {
      if (settled) return;
      settled = true;
      socket.off("error", fail);
      socket.off("close", fail);
      resolve();
    });
  });
}

function parseRequest(value: unknown): Omit<ClaudePermissionRequest, "providerRequestId" | "actionCommitment"> {
  if (!isRecord(value)) throw new Error("Claude permission request must be an object");
  const requestId = value.requestId;
  const toolName = value.toolName;
  const input = value.input;
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 200) {
    throw new Error("Claude permission request has an invalid ID");
  }
  if (typeof toolName !== "string" || toolName.length === 0 || toolName.length > 500) {
    throw new Error("Claude permission request has an invalid tool name");
  }
  if (!isRecord(input)) throw new Error("Claude permission request input must be an object");
  return { requestId, toolName, input };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
