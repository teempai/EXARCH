import { createConnection } from "node:net";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const socketPath = process.argv[2];
if (typeof socketPath !== "string" || socketPath.length === 0) process.exit(64);

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void handleLine(line);
});

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "exarch-permissions", version: "1.0.0" }
      }
    });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "approval_prompt",
            description: "Relay an unresolved Claude Code permission prompt to the paired device",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["tool_name", "input"],
              properties: {
                tool_name: { type: "string" },
                input: { type: "object", additionalProperties: true }
              }
            }
          }
        ]
      }
    });
    return;
  }
  if (request.method === "tools/call" && request.params?.name === "approval_prompt") {
    try {
      const args = request.params.arguments;
      if (typeof args?.tool_name !== "string" || !isRecord(args.input)) {
        throw new Error("Invalid permission prompt arguments");
      }
      const decision = await relay({
        requestId: randomUUID(),
        toolName: args.tool_name,
        input: args.input
      });
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: JSON.stringify(decision) }] }
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: error instanceof Error ? error.message : "Permission relay failed" }
      });
    }
    return;
  }
  if (request.id !== undefined) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
}

function relay(payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Permission relay timed out"));
    }, 5 * 60_000);
    timeout.unref?.();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        socket.destroy(new Error("Permission response exceeded the size limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!isRecord(response.decision)) throw new Error("Invalid permission response");
        socket.end();
        resolve(response.decision);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
