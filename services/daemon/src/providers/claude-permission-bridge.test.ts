import { readFile, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudePermissionBridge,
  type ClaudePermissionRequest
} from "./claude-permission-bridge.js";

describe("ClaudePermissionBridge", () => {
  it("uses protected local files and returns only an offered deny decision", async () => {
    let receive!: (request: ClaudePermissionRequest) => void;
    const received = new Promise<ClaudePermissionRequest>((resolve) => {
      receive = resolve;
    });
    const bridge = new ClaudePermissionBridge(receive);
    const started = await bridge.start();
    await expect(bridge.start()).rejects.toThrow(/already running/);
    const definition = await readDefinition(started.configPath);
    expect((await stat(started.configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(definition.socketPath)).mode & 0o777).toBe(0o600);

    const client = send(definition.socketPath, {
      requestId: "permission-1",
      toolName: "Bash",
      input: { command: "pwd" }
    });
    await expect(received).resolves.toMatchObject({
      requestId: "permission-1",
      toolName: "Bash",
      input: { command: "pwd" }
    });
    const request = await received;
    await expect(bridge.respond("missing", "deny", request.actionCommitment)).rejects.toThrow(/not pending/);
    await expect(
      bridge.respond(request.providerRequestId, "always", request.actionCommitment)
    ).rejects.toThrow(/Unsupported/);
    await expect(
      bridge.respond(request.providerRequestId, "allow", `sha256:${"0".repeat(64)}`)
    ).rejects.toThrow(/commitment mismatch/);
    await bridge.respond(request.providerRequestId, "deny", request.actionCommitment);
    await expect(client.response).resolves.toEqual({
      requestId: "permission-1",
      decision: {
        behavior: "deny",
        message: "Permission denied from the paired mobile device"
      }
    });
    await bridge.close();
    await expect(stat(dirname(started.configPath))).rejects.toThrow();
  });

  it("does not report a decision delivered after the permission client disconnects", async () => {
    let receive!: (request: ClaudePermissionRequest) => void;
    const received = new Promise<ClaudePermissionRequest>((resolve) => { receive = resolve; });
    const bridge = new ClaudePermissionBridge(receive);
    const started = await bridge.start();
    const definition = await readDefinition(started.configPath);
    const client = send(definition.socketPath, {
      requestId: "permission-disconnected",
      toolName: "Bash",
      input: { command: "true" }
    });
    const request = await received;
    client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(
      bridge.respond(request.providerRequestId, "allow", request.actionCommitment)
    ).rejects.toThrow(/not pending|disconnected/);
    await bridge.close();
  });

  it("denies pending work during shutdown and rejects malformed bridge input", async () => {
    const requests: ClaudePermissionRequest[] = [];
    const bridge = new ClaudePermissionBridge((request) => requests.push(request));
    const started = await bridge.start();
    const definition = await readDefinition(started.configPath);
    const pending = send(definition.socketPath, {
      requestId: "permission-close",
      toolName: "Write",
      input: { file_path: "README.md" }
    });
    await waitUntil(() => requests.length === 1);
    await bridge.close();
    await expect(pending.response).resolves.toMatchObject({
      decision: { behavior: "deny", message: "Permission bridge closed" }
    });

    const malformedBridge = new ClaudePermissionBridge((request) => requests.push(request));
    const malformedStarted = await malformedBridge.start();
    const malformedDefinition = await readDefinition(malformedStarted.configPath);
    const socket = createConnection(malformedDefinition.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ requestId: "", toolName: 3, input: [] })}\n`);
      });
      socket.once("close", () => resolve());
      socket.once("error", () => resolve());
      setTimeout(() => reject(new Error("Malformed permission socket stayed open")), 1_000).unref();
    });
    expect(requests).toHaveLength(1);
    await malformedBridge.close();
  });
});

async function readDefinition(configPath: string): Promise<{ socketPath: string }> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    mcpServers: { exarch_permissions: { args: string[] } };
  };
  return { socketPath: config.mcpServers.exarch_permissions.args[1] as string };
}

function send(socketPath: string, value: unknown): { socket: Socket; response: Promise<unknown> } {
  const socket = createConnection(socketPath);
  const response = new Promise<unknown>((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      resolve(JSON.parse(buffer.slice(0, newline)) as unknown);
    });
    socket.once("error", reject);
  });
  return { socket, response };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for bridge request");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
