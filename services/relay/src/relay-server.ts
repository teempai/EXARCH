import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { RelayTicketAuthority, type RelayRole } from "./relay-ticket.js";
import type { RelayAccessAuthority } from "./relay-access.js";

const MAX_RELAY_FRAME_BYTES = 70 * 1024;
const MAX_REGISTRATION_BYTES = 2 * 1024;
const REGISTRATION_TIMEOUT_MS = 5_000;
const MAX_FRAMES_PER_WINDOW = 200;
const MAX_BYTES_PER_WINDOW = 4 * 1024 * 1024;
const RATE_WINDOW_MS = 10_000;

interface RelayPeer {
  socket: WebSocket;
  role: RelayRole;
  routingId: string;
  windowStartedAt: number;
  frames: number;
  bytes: number;
  queuedBytes: number;
}

interface RelayRoute {
  host?: RelayPeer;
  device?: RelayPeer;
}

export interface RelayFrameMetadata {
  routingId: string;
  from: RelayRole;
  byteLength: number;
  sha256: string;
}

export interface RelayManagementOptions {
  adminToken: string;
  access: RelayAccessAuthority;
}

export interface RelayIngressOptions {
  trustedProxy: boolean;
  /** Peer addresses permitted to assert x-forwarded-proto. Empty accepts any. */
  proxyAddresses?: readonly string[];
}

export interface RelayResourceLimits {
  maxPendingConnections: number;
  maxActiveConnections: number;
  maxUpgradesPerWindow: number;
  maxUpgradesPerSource: number;
  upgradeWindowMs: number;
  maxQueuedBytesPerPeer: number;
  maxQueuedBytesGlobal: number;
}

const DEFAULT_RESOURCE_LIMITS: RelayResourceLimits = {
  maxPendingConnections: 128,
  maxActiveConnections: 2_048,
  maxUpgradesPerWindow: 512,
  maxUpgradesPerSource: 64,
  upgradeWindowMs: 10_000,
  maxQueuedBytesPerPeer: 1024 * 1024,
  maxQueuedBytesGlobal: 16 * 1024 * 1024
};

export class OpaqueRelayServer {
  private http: Server | null = null;
  private readonly webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RELAY_FRAME_BYTES,
    perMessageDeflate: false
  });
  private readonly routes = new Map<string, RelayRoute>();
  private readonly limits: RelayResourceLimits;
  private pendingConnections = 0;
  private queuedBytes = 0;
  private upgradeWindowStartedAt = 0;
  private upgradesInWindow = 0;
  private readonly upgradesBySource = new Map<string, number>();
  private readonly proxyAddresses: ReadonlySet<string>;

  constructor(
    private readonly tickets: RelayTicketAuthority,
    private readonly frameObserver?: (metadata: RelayFrameMetadata, bytes: Buffer) => void,
    private readonly management?: RelayManagementOptions,
    private readonly ingress: RelayIngressOptions = { trustedProxy: false },
    limits: Partial<RelayResourceLimits> = {}
  ) {
    this.limits = { ...DEFAULT_RESOURCE_LIMITS, ...limits };
    this.proxyAddresses = new Set(ingress.proxyAddresses ?? []);
    if (management !== undefined && management.adminToken.length < 32) {
      throw new Error("Relay management admin token must contain at least 32 characters");
    }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Relay resource limit ${name} is invalid`);
    }
  }

  async start(port = 0, host = "127.0.0.1"): Promise<{ baseUrl: string; wsUrl: string }> {
    if (this.http !== null) throw new Error("Relay is already running");
    const http = createServer((request, response) => void this.handleHttp(request, response));
    http.on("upgrade", (request, socket, head) => {
      if (this.ingress.trustedProxy && !forwardedAsHttps(request, this.proxyAddresses)) {
        socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (request.url !== "/v1/relay") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const admission = this.admitUpgrade(request);
      if (admission !== null) {
        socket.write(`HTTP/1.1 ${admission.status} ${admission.reason}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.pendingConnections += 1;
      let released = false;
      const releasePending = () => {
        if (released) return;
        released = true;
        this.pendingConnections = Math.max(0, this.pendingConnections - 1);
      };
      socket.once("close", releasePending);
      try {
        this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
          this.accept(webSocket, releasePending);
        });
      } catch {
        releasePending();
        socket.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, host, () => {
        http.off("error", reject);
        resolve();
      });
    });
    this.http = http;
    const address = http.address() as AddressInfo;
    return {
      baseUrl: `http://${host}:${address.port}`,
      wsUrl: `ws://${host}:${address.port}/v1/relay`
    };
  }

  async stop(): Promise<void> {
    for (const client of this.webSockets.clients) client.terminate();
    this.routes.clear();
    this.pendingConnections = 0;
    this.queuedBytes = 0;
    this.upgradesBySource.clear();
    const http = this.http;
    this.http = null;
    if (http !== null) {
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }

  activeRoutes(): number {
    return this.routes.size;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (
        this.ingress.trustedProxy &&
        (request.url === "/v1/routes" || request.url === "/v1/tickets" || request.url?.startsWith("/v1/routes/")) &&
        !forwardedAsHttps(request, this.proxyAddresses)
      ) {
        sendJson(response, 426, { error: "tls_required" });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/routes" && this.management !== undefined) {
        if (!constantTimeTokenMatch(bearerToken(request), this.management.adminToken)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        sendJson(response, 201, this.management.access.issueRoute());
        return;
      }
      if (request.method === "POST" && request.url === "/v1/tickets" && this.management !== undefined) {
        try {
          sendJson(response, 201, this.management.access.issueTicket(bearerToken(request)));
        } catch (error) {
          if (error instanceof Error && /rate|capacity/i.test(error.message)) {
            sendJson(response, 429, { error: "ticket_rate_limited" });
          } else {
            throw error;
          }
        }
        return;
      }
      const revokeMatch = request.url?.match(/^\/v1\/routes\/([A-Za-z0-9_-]{43})$/);
      if (request.method === "DELETE" && revokeMatch?.[1] !== undefined && this.management !== undefined) {
        await this.management.access.revokeRoute(bearerToken(request), revokeMatch[1]);
        response.statusCode = 204;
        response.end();
        // An authenticated phone can request its own removal through the Mac.
        // Leave the already-authenticated opaque channel alive just long enough
        // for that confirmation response to cross it; new tickets and
        // registrations are rejected immediately.
        const timer = setTimeout(() => this.closeRoute(revokeMatch[1]!), 1_000);
        timer.unref?.();
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch {
      sendJson(response, 401, { error: "unauthorized" });
    }
  }

  private accept(socket: WebSocket, releasePending: () => void): void {
    let peer: RelayPeer | null = null;
    // close() only starts the closing handshake, and `ws` keeps emitting
    // message events until it completes. Without this flag a connection whose
    // registration was rejected could still reach the forwarding path below.
    let rejected = false;
    const registrationTimer = setTimeout(() => {
      rejected = true;
      releasePending();
      socket.terminate();
    }, REGISTRATION_TIMEOUT_MS);
    registrationTimer.unref?.();
    socket.on("message", (data, isBinary) => {
      if (rejected) return;
      if (peer === null) {
        if (isBinary || byteLength(data) > MAX_REGISTRATION_BYTES) {
          rejected = true;
          socket.close(1008, "Invalid registration");
          return;
        }
        try {
          const registration = parseRegistration(data.toString());
          if (this.management?.access.isRouteRevoked(registration.routingId) === true) {
            throw new Error("Relay route is revoked");
          }
          if (this.routes.get(registration.routingId)?.[registration.role] !== undefined) {
            throw new Error("Relay role is already connected");
          }
          this.tickets.consume(registration.ticket, registration.routingId, registration.role);
          const candidate: RelayPeer = {
            socket,
            role: registration.role,
            routingId: registration.routingId,
            windowStartedAt: Date.now(),
            frames: 0,
            bytes: 0,
            queuedBytes: 0
          };
          // Publish the peer only once registration has actually succeeded, so
          // a rejected duplicate never becomes a forwarding source.
          this.register(candidate);
          peer = candidate;
          clearTimeout(registrationTimer);
          releasePending();
        } catch {
          rejected = true;
          releasePending();
          closeThenTerminate(socket, 1008, "Registration rejected");
        }
        return;
      }
      if (!isBinary) {
        socket.close(1003, "Only opaque binary frames are accepted");
        return;
      }
      const bytes = toBuffer(data);
      if (!this.consumeRate(peer, bytes.byteLength)) {
        socket.close(1008, "Relay rate limit exceeded");
        return;
      }
      const route = this.routes.get(peer.routingId);
      const counterpart = peer.role === "host" ? route?.device : route?.host;
      if (counterpart?.socket.readyState !== WebSocket.OPEN) {
        socket.close(1013, "Counterpart offline");
        return;
      }
      this.frameObserver?.(
        {
          routingId: peer.routingId,
          from: peer.role,
          byteLength: bytes.byteLength,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
        },
        bytes
      );
      this.forward(counterpart, bytes);
    });
    socket.once("close", () => {
      clearTimeout(registrationTimer);
      releasePending();
      if (peer !== null) this.unregister(peer);
    });
  }

  private register(peer: RelayPeer): void {
    const route = this.routes.get(peer.routingId) ?? {};
    if (route[peer.role] !== undefined) throw new Error("Relay role is already connected");
    route[peer.role] = peer;
    this.routes.set(peer.routingId, route);
    peer.socket.send(JSON.stringify({ type: "registered", counterpartConnected: false }));
    if (route.host !== undefined && route.device !== undefined) {
      const ready = JSON.stringify({ type: "ready" });
      route.host.socket.send(ready);
      route.device.socket.send(ready);
    }
  }

  private unregister(peer: RelayPeer): void {
    const route = this.routes.get(peer.routingId);
    if (route === undefined || route[peer.role] !== peer) return;
    delete route[peer.role];
    const counterpart = peer.role === "host" ? route.device : route.host;
    if (counterpart?.socket.readyState === WebSocket.OPEN) {
      counterpart.socket.send(JSON.stringify({ type: "counterpart.offline" }));
    }
    if (route.host === undefined && route.device === undefined) this.routes.delete(peer.routingId);
  }

  private closeRoute(routingId: string, code = 1008, reason = "Route revoked"): void {
    const route = this.routes.get(routingId);
    this.routes.delete(routingId);
    if (route?.host !== undefined) closeThenTerminate(route.host.socket, code, reason);
    if (route?.device !== undefined) closeThenTerminate(route.device.socket, code, reason);
  }

  private consumeRate(peer: RelayPeer, bytes: number): boolean {
    const now = Date.now();
    if (now - peer.windowStartedAt >= RATE_WINDOW_MS) {
      peer.windowStartedAt = now;
      peer.frames = 0;
      peer.bytes = 0;
    }
    peer.frames += 1;
    peer.bytes += bytes;
    return peer.frames <= MAX_FRAMES_PER_WINDOW && peer.bytes <= MAX_BYTES_PER_WINDOW;
  }

  private admitUpgrade(request: IncomingMessage): { status: number; reason: string } | null {
    if (this.webSockets.clients.size >= this.limits.maxActiveConnections) {
      return { status: 503, reason: "Service Unavailable" };
    }
    if (this.pendingConnections >= this.limits.maxPendingConnections) {
      return { status: 503, reason: "Service Unavailable" };
    }
    const source = this.clientSource(request);
    if (source === null) return { status: 400, reason: "Bad Request" };
    const now = Date.now();
    if (now - this.upgradeWindowStartedAt >= this.limits.upgradeWindowMs) {
      this.upgradeWindowStartedAt = now;
      this.upgradesInWindow = 0;
      this.upgradesBySource.clear();
    }
    if (this.upgradesInWindow >= this.limits.maxUpgradesPerWindow) {
      return { status: 429, reason: "Too Many Requests" };
    }
    const sourceCount = this.upgradesBySource.get(source) ?? 0;
    if (sourceCount >= this.limits.maxUpgradesPerSource) {
      return { status: 429, reason: "Too Many Requests" };
    }
    this.upgradesInWindow += 1;
    this.upgradesBySource.set(source, sourceCount + 1);
    return null;
  }

  private clientSource(request: IncomingMessage): string | null {
    if (!this.ingress.trustedProxy) return request.socket.remoteAddress ?? null;
    const value = request.headers["fly-client-ip"];
    if (typeof value !== "string" || isIP(value) === 0) return null;
    return value;
  }

  private forward(counterpart: RelayPeer, bytes: Buffer): void {
    const peerQueued = Math.max(counterpart.queuedBytes, counterpart.socket.bufferedAmount);
    if (
      peerQueued + bytes.byteLength > this.limits.maxQueuedBytesPerPeer ||
      this.queuedBytes + bytes.byteLength > this.limits.maxQueuedBytesGlobal
    ) {
      this.closeRoute(counterpart.routingId, 1013, "Relay backpressure limit exceeded");
      return;
    }
    counterpart.queuedBytes += bytes.byteLength;
    this.queuedBytes += bytes.byteLength;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      counterpart.queuedBytes = Math.max(0, counterpart.queuedBytes - bytes.byteLength);
      this.queuedBytes = Math.max(0, this.queuedBytes - bytes.byteLength);
    };
    try {
      counterpart.socket.send(bytes, { binary: true, compress: false }, (error) => {
        release();
        if (error instanceof Error) this.closeRoute(counterpart.routingId, 1013, "Relay forwarding failed");
      });
    } catch {
      release();
      this.closeRoute(counterpart.routingId, 1013, "Relay forwarding failed");
    }
  }
}

function closeThenTerminate(socket: WebSocket, code: number, reason: string): void {
  socket.close(code, reason);
  const timer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, 250);
  timer.unref?.();
}

/**
 * x-forwarded-proto is a client-supplied string, so the TLS requirement it
 * carries is only worth something if the proxy is the sole route to the port.
 * In the supported deployment that is a container network the proxy alone can
 * enter, which the relay cannot verify from inside.
 *
 * `proxyAddresses` lets an operator say which peer is the proxy, and is the
 * only thing here that turns the header from a claim into a check. It is
 * optional because a relay bound to loopback, or reachable only over a private
 * container network, already has the guarantee by topology. Where neither
 * holds, anyone who can reach the port can assert https.
 */
function forwardedAsHttps(request: IncomingMessage, proxyAddresses: ReadonlySet<string>): boolean {
  if (request.headers["x-forwarded-proto"] !== "https") return false;
  if (proxyAddresses.size === 0) return true;
  const peer = request.socket.remoteAddress;
  if (peer === undefined) return false;
  // Node reports an IPv4 peer on a dual-stack socket as ::ffff:127.0.0.1.
  return proxyAddresses.has(peer) || proxyAddresses.has(peer.replace(/^::ffff:/, ""));
}

function bearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ") || value.length > 8192) {
    throw new Error("Bearer token is missing");
  }
  const token = value.slice("Bearer ".length);
  if (token.length === 0) throw new Error("Bearer token is missing");
  return token;
}

function constantTimeTokenMatch(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(`${JSON.stringify(value)}\n`);
}

function parseRegistration(raw: string): { routingId: string; role: RelayRole; ticket: string } {
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Registration must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.type !== "register" ||
    typeof record.routingId !== "string" ||
    (record.role !== "host" && record.role !== "device") ||
    typeof record.ticket !== "string" ||
    Object.keys(record).length !== 4
  ) {
    throw new Error("Registration fields are invalid");
  }
  return { routingId: record.routingId, role: record.role, ticket: record.ticket };
}

function byteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0);
  return data.byteLength;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error("Unsupported WebSocket frame representation");
}
