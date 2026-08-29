import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { ContextResponseSchema, type ContextRequest, type ContextResponse } from "./protocol.js";

const MAX_CAPABILITY_FILE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export async function readCapabilityFile(path: string): Promise<string> {
  const data = await readFile(path);
  if (data.byteLength === 0 || data.byteLength > MAX_CAPABILITY_FILE_BYTES) {
    data.fill(0);
    throw new Error("Capability file has an invalid size");
  }
  const token = data.toString("utf8").trim();
  data.fill(0);
  return token;
}

export async function requestContext(
  socketPath: string,
  request: ContextRequest,
  timeoutMs = 5_000
): Promise<ContextResponse> {
  return new Promise<ContextResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    const finish = (error?: Error, value?: ContextResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(value as ContextResponse);
    };
    const timer = setTimeout(() => finish(new Error("Context request timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
        finish(new Error("Context response exceeds client limit"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline !== -1) {
        try {
          finish(undefined, ContextResponseSchema.parse(JSON.parse(response.slice(0, newline))));
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Invalid context response"));
        }
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("Context service closed without a response"));
    });
  });
}
