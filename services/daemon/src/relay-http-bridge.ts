import {
  MAX_RELAY_HTTP_BODY_BYTES,
  type RelayHttpRequest,
  type RelayHttpResponse
} from "../../../packages/relay/src/index.js";

const ORDINARY_REQUEST_TIMEOUT_MS = 30_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 24 * 60 * 60_000;

export function relayBridgeTimeoutMs(path: string): number {
  return /^\/api\/v1\/conversations\/[^/]+\/messages$/.test(path)
    ? LONG_RUNNING_REQUEST_TIMEOUT_MS
    : ORDINARY_REQUEST_TIMEOUT_MS;
}

export class RelayHttpBridge {
  private readonly baseUrl: URL;

  constructor(baseUrl: string, private readonly request: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "http:" || !loopback || parsed.username !== "" || parsed.password !== "") {
      throw new Error("Relay bridge target must be an unauthenticated loopback HTTP URL");
    }
    if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search !== "" || parsed.hash !== "") {
      throw new Error("Relay bridge target must not include a path, query, or fragment");
    }
    this.baseUrl = parsed;
  }

  async handle(input: RelayHttpRequest): Promise<RelayHttpResponse> {
    const target = new URL(input.path, this.baseUrl);
    if (target.origin !== this.baseUrl.origin || !target.pathname.startsWith("/api/v1/")) {
      throw new Error("Relay request escaped the laptop API boundary");
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (value !== undefined) headers.set(name, value);
    }
    const response = await this.request(target, {
      method: input.method,
      headers,
      ...(input.method === "POST"
        ? { body: Buffer.from(input.body ?? Buffer.alloc(0)) as unknown as BodyInit }
        : {}),
      redirect: "error",
      // Message submission currently stays open until the harness finishes.
      // Keep that request alive just as the native loopback client does;
      // otherwise a healthy Codex/Claude/Hermes turn is misreported as a 502
      // after 30 seconds even though the laptop continues doing the work.
      signal: AbortSignal.timeout(relayBridgeTimeoutMs(input.path))
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      body: await readBounded(response)
    };
  }
}

async function readBounded(response: Response): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_RELAY_HTTP_BODY_BYTES) throw new Error("Laptop API response exceeds relay limit");
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
