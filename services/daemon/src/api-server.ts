import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  AuthChallengeRequestSchema,
  ApprovalDecisionRequestSchema,
  ProviderSchema,
  SignedRequestHeadersSchema,
  type SignedRequestHeaders
} from "../../../packages/protocol/src/index.js";
import {
  AuthenticationError,
  DeviceAuthenticator,
  WorkspaceScopeError,
  type DeviceRecord
} from "../../../packages/core/src/index.js";
import {
  ConversationCoordinator,
  ApprovalDeliveryError,
  PolicyRevisionConflictError,
  ProviderUnavailableError,
  ProviderHandoffRequiredError,
  WorkspaceUnavailableError
} from "./coordinator.js";
import type { HistorySyncService } from "./history/history-sync.js";
import { ChallengeRateLimiter } from "./challenge-rate-limiter.js";
import { ProviderCapacityExhaustedError } from "./providers/provider-adapter.js";

const MAX_BODY_BYTES = 1024 * 1024;
class PayloadTooLargeError extends Error {}

export interface PairingRevocationHandler {
  /** Persist the tombstone and revoke local device authority before acknowledgement. */
  prepare(deviceId: string): Promise<void>;
  /** Retire the relay route after the acknowledgement has crossed it. */
  complete(): Promise<void>;
}

const CreateConversationSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    provider: ProviderSchema
  })
  .strict();

const SwitchProviderSchema = z.object({ provider: ProviderSchema }).strict();
const PinConversationSchema = z.object({ pinned: z.boolean() }).strict();
const FallbackRouteSchema = z
  .object({ route: z.array(ProviderSchema).min(1).max(3) })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.route).size !== value.route.length) {
      context.addIssue({ code: "custom", message: "Fallback route cannot repeat a harness" });
    }
  });
const ConversationCursorSchema = z
  .object({
    version: z.literal(2),
    sequence: z.number().int().nonnegative()
  })
  .strict();

const LegacyConversationCursorSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.string().datetime({ offset: true }),
    id: z.string().min(1).max(200)
  })
  .strict();

const ConversationListCursorSchema = z
  .object({
    version: z.literal(1),
    pinned: z.boolean(),
    updatedAt: z.string().datetime({ offset: true }),
    id: z.string().min(1).max(200)
  })
  .strict();

export class LaptopApiServer {
  private server: Server | null = null;
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(
    private readonly coordinator: ConversationCoordinator,
    private readonly authenticator: DeviceAuthenticator,
    private readonly host = "127.0.0.1",
    private readonly history?: HistorySyncService,
    private readonly pairingRevocation?: PairingRevocationHandler,
    private readonly challengeRateLimiter = new ChallengeRateLimiter()
  ) {
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new Error("Laptop API must bind to a loopback address");
    }
  }

  async start(port = 0): Promise<{ host: string; port: number; baseUrl: string }> {
    if (this.server !== null) throw new Error("Laptop API is already running");
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address() as AddressInfo;
    return { host: this.host, port: address.port, baseUrl: `http://${this.host}:${address.port}` };
  }

  async stop(): Promise<void> {
    for (const client of this.webSockets.clients) client.terminate();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setResponseHeaders(response);
    try {
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      const body = await readBody(request);

      if (method === "POST" && path === "/api/v1/auth/challenge") {
        const input = AuthChallengeRequestSchema.parse(parseJson(body));
        if (!this.challengeRateLimiter.consume(input.deviceId)) {
          response.setHeader("retry-after", String(this.challengeRateLimiter.retryAfterSeconds()));
          sendJson(response, 429, { error: "rate_limited" });
          return;
        }
        sendJson(response, 200, this.authenticator.issueChallenge(input.deviceId));
        return;
      }

      const authenticatedDevice = authorizeForRemoteControl(
        this.authenticator.verifyRequest({
          method,
          path,
          body,
          headers: signedHeaders(request)
        })
      );

      const url = new URL(path, "http://loopback.invalid");
      if (method === "GET" && url.pathname === "/api/v1/health") {
        sendJson(response, 200, { status: "ok", version: 1 });
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/providers") {
        sendJson(response, 200, await this.coordinator.providers());
        return;
      }
      if (method === "POST" && url.pathname === "/api/v1/pairing/revoke") {
        if (this.pairingRevocation === undefined) {
          sendJson(response, 503, { error: "pairing_revocation_unavailable" });
          return;
        }
        // This must resolve before the phone is told it can erase its keys.
        // It writes a durable tombstone first and then revokes the local
        // device, so a crash cannot restore authority on the next launch.
        const pairingRevocation = this.pairingRevocation;
        await pairingRevocation.prepare(authenticatedDevice.id);
        response.once("finish", () => {
          // The relay route carrying this response must remain alive long
          // enough for the phone to receive the acknowledgement. Retire it
          // immediately afterwards; the callback owns failure logging.
          const timer = setTimeout(() => {
            // Production callbacks record their own failure details. Keep a
            // rejected cleanup promise from becoming a process-level error.
            void pairingRevocation.complete().catch(() => undefined);
          }, 750);
          timer.unref?.();
        });
        // Relay retirement is still pending, but the phone's laptop-local
        // authorization is already durably withdrawn.
        sendJson(response, 202, {
          accepted: true,
          authorizationRevoked: true,
          contextPreserved: true
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/history-import/status") {
        if (this.history === undefined) {
          sendJson(response, 200, { state: "disabled", startedAt: null, completedAt: null, providers: [] });
        } else {
          sendJson(response, 200, this.history.status());
        }
        return;
      }
      if (method === "POST" && url.pathname === "/api/v1/history-import/refresh") {
        if (this.history === undefined) {
          sendJson(response, 503, { error: "history_import_disabled" });
        } else {
          sendJson(response, 200, await this.history.syncAll());
        }
        return;
      }
      const policyMatch = url.pathname.match(/^\/api\/v1\/providers\/([^/]+)\/effective-policy$/);
      if (method === "GET" && policyMatch?.[1] !== undefined) {
        const provider = ProviderSchema.parse(decodeSegment(policyMatch[1]));
        const conversationId = url.searchParams.get("conversationId") ?? undefined;
        sendJson(response, 200, (await this.coordinator.provider(provider, conversationId)).policy);
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/projects") {
        sendJson(response, 200, this.coordinator.store.listProjects());
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/conversations") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        sendJson(response, 200, this.coordinator.store.listConversations(projectId));
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/conversations/page") {
        this.history?.requestChangeCheckIfStale();
        const cursor = decodeConversationListCursor(url.searchParams.get("cursor"));
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 30);
        if (limit === 0) throw new SyntaxError("Conversation page limit must be positive");
        const page = this.coordinator.store.listConversationPage(cursor, limit);
        sendJson(response, 200, {
          conversations: page.conversations,
          nextCursor: page.nextCursor === null ? null : encodeConversationListCursor(page.nextCursor),
          hasMore: page.hasMore
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/conversations/sync") {
        this.history?.requestChangeCheckIfStale();
        const cursor = decodeConversationCursor(url.searchParams.get("cursor"));
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 200);
        if (limit === 0) throw new SyntaxError("Conversation sync limit must be positive");
        const page = this.coordinator.store.listConversationChanges(cursor, limit);
        sendJson(response, 200, {
          conversations: page.conversations,
          nextCursor: page.nextCursor === null ? null : encodeConversationCursor(page.nextCursor),
          hasMore: page.hasMore
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/approvals") {
        const conversationId = url.searchParams.get("conversationId");
        if (conversationId === null || conversationId.length === 0) {
          throw new SyntaxError("conversationId is required");
        }
        const rawStatus = url.searchParams.get("status");
        const status =
          rawStatus === null
            ? undefined
            : z.enum(["pending", "decided", "expired", "delivery_failed"]).parse(rawStatus);
        sendJson(response, 200, this.coordinator.store.listApprovals(conversationId, status));
        return;
      }
      if (method === "POST" && url.pathname === "/api/v1/conversations") {
        const input = CreateConversationSchema.parse(parseJson(body));
        const project = this.coordinator.store.getProject(input.projectId);
        if (project.allowedPaths.length === 0) {
          throw new SyntaxError("Project must be enrolled from the laptop before creating a conversation");
        }
        sendJson(
          response,
          201,
          this.coordinator.store.createConversation({
            projectId: input.projectId,
            title: input.title,
            activeProvider: input.provider
          })
        );
        return;
      }

      const conversationMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)$/);
      if (method === "GET" && conversationMatch?.[1] !== undefined) {
        sendJson(response, 200, this.coordinator.store.getConversation(decodeSegment(conversationMatch[1])));
        return;
      }

      const messageMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch?.[1] !== undefined) {
        sendJson(
          response,
          201,
          await this.coordinator.submitMessage(decodeSegment(messageMatch[1]), parseJson(body))
        );
        return;
      }
      const providerMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/provider$/);
      if (method === "POST" && providerMatch?.[1] !== undefined) {
        const input = SwitchProviderSchema.parse(parseJson(body));
        sendJson(
          response,
          200,
          await this.coordinator.switchProvider(decodeSegment(providerMatch[1]), input.provider)
        );
        return;
      }
      const pinMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/pin$/);
      if (method === "POST" && pinMatch?.[1] !== undefined) {
        const input = PinConversationSchema.parse(parseJson(body));
        sendJson(
          response,
          200,
          this.coordinator.store.setConversationPinned(decodeSegment(pinMatch[1]), input.pinned)
        );
        return;
      }
      const fallbackRouteMatch = url.pathname.match(
        /^\/api\/v1\/conversations\/([^/]+)\/fallback-route$/
      );
      if (method === "POST" && fallbackRouteMatch?.[1] !== undefined) {
        const input = FallbackRouteSchema.parse(parseJson(body));
        sendJson(
          response,
          200,
          this.coordinator.store.setConversationFallbackRoute(
            decodeSegment(fallbackRouteMatch[1]),
            input.route
          )
        );
        return;
      }
      const interruptMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/interrupt$/);
      if (method === "POST" && interruptMatch?.[1] !== undefined) {
        await this.coordinator.interrupt(decodeSegment(interruptMatch[1]));
        sendJson(response, 202, { accepted: true });
        return;
      }
      const approvalDecisionMatch = url.pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/decision$/);
      if (method === "POST" && approvalDecisionMatch?.[1] !== undefined) {
        const approvalId = decodeSegment(approvalDecisionMatch[1]);
        const decision = ApprovalDecisionRequestSchema.parse(parseJson(body));
        const approval = this.coordinator.store.getApproval(approvalId);
        const approvalDigest = approval.request.approvalDigest;
        if (typeof approvalDigest !== "string") throw new Error("Approval digest is missing");
        this.authenticator.verifyApprovalDecision({
          approvalId,
          approvalDigest,
          choice: decision.choice,
          deviceId: authenticatedDevice.id,
          decidedAt: decision.decidedAt,
          signature: decision.signature
        });
        sendJson(
          response,
          200,
          await this.coordinator.deliverApprovalDecision({
            approvalId,
            choice: decision.choice,
            deviceId: authenticatedDevice.id,
            decidedAt: decision.decidedAt,
            signature: decision.signature
          })
        );
        return;
      }
      const eventsMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/events$/);
      if (method === "GET" && eventsMatch?.[1] !== undefined) {
        const afterValue = url.searchParams.get("after");
        const beforeValue = url.searchParams.get("before");
        if (afterValue !== null && beforeValue !== null) {
          throw new SyntaxError("after and before cannot be combined");
        }
        const view = url.searchParams.get("view");
        if (view !== null && view !== "messages") {
          throw new SyntaxError("Invalid event view");
        }
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 100);
        const conversationId = decodeSegment(eventsMatch[1]);
        const displayOnly = view === "messages";
        const events = beforeValue === null
          ? this.coordinator.store.listEvents(conversationId, {
              after: parsePositiveInteger(afterValue, 0),
              limit,
              displayOnly
            })
          : this.coordinator.store.listRecentEvents(conversationId, {
              before: parsePositiveInteger(beforeValue, 0),
              limit,
              displayOnly
            });
        sendJson(
          response,
          200,
          events
        );
        return;
      }
      const contextSearchMatch = url.pathname.match(
        /^\/api\/v1\/conversations\/([^/]+)\/context\/search$/
      );
      if (method === "GET" && contextSearchMatch?.[1] !== undefined) {
        const conversationId = decodeSegment(contextSearchMatch[1]);
        const conversation = this.coordinator.store.getConversation(conversationId);
        const query = url.searchParams.get("q");
        if (query === null) throw new SyntaxError("q is required");
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 20);
        sendJson(
          response,
          200,
          this.coordinator.store.searchEvents(conversation.projectId, conversationId, query, limit)
        );
        return;
      }
      const changesMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/changes$/);
      if (method === "GET" && changesMatch?.[1] !== undefined) {
        sendJson(response, 200, await this.coordinator.changes(decodeSegment(changesMatch[1])));
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        sendJson(response, 401, { error: "unauthenticated" });
      } else if (error instanceof PolicyRevisionConflictError) {
        sendJson(response, 409, {
          error: "policy_revision_conflict",
          message: error.message,
          policy: error.policy,
          retrySafe: true
        });
      } else if (error instanceof ProviderHandoffRequiredError) {
        sendJson(response, 409, { error: "provider_handoff_required", message: error.message });
      } else if (error instanceof ProviderUnavailableError) {
        sendJson(response, 503, {
          error: "provider_unavailable",
          message: error.message,
          provider: error.health.provider,
          health: error.health
        });
      } else if (error instanceof ProviderCapacityExhaustedError) {
        sendJson(response, 429, {
          error: "provider_capacity_exhausted",
          message: error.message,
          provider: error.provider,
          capacity: error.capacity,
          retrySafe: error.retrySafe
        });
      } else if (error instanceof ApprovalDeliveryError) {
        sendJson(response, 502, { error: "approval_delivery_failed", message: error.message });
      } else if (error instanceof WorkspaceUnavailableError) {
        sendJson(response, 423, { error: "workspace_unavailable", message: error.message });
      } else if (error instanceof PayloadTooLargeError) {
        sendJson(response, 413, { error: "payload_too_large" });
      } else if (error instanceof WorkspaceScopeError) {
        sendJson(response, 400, { error: "invalid_workspace_scope", message: error.message });
      } else if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof URIError ||
        error instanceof RangeError
      ) {
        sendJson(response, 400, { error: "invalid_request" });
      } else {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer
  ): Promise<void> {
    try {
      const path = request.url ?? "/";
      const url = new URL(path, "http://loopback.invalid");
      const match = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/events$/);
      if (match?.[1] === undefined) throw new AuthenticationError("Invalid stream path");
      authorizeForRemoteControl(
        this.authenticator.verifyRequest({
          method: "GET",
          path,
          body: Buffer.alloc(0),
          headers: signedHeaders(request)
        })
      );
      const conversationId = decodeSegment(match[1]);
      const after = parsePositiveInteger(url.searchParams.get("after"), 0);
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.attachEventStream(webSocket, conversationId, after);
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }

  private attachEventStream(webSocket: WebSocket, conversationId: string, after: number): void {
    try {
      const replay = this.coordinator.store.listEvents(conversationId, { after, limit: 500 });
      replay.forEach((event) => webSocket.send(JSON.stringify({ type: "event", event })));
      const unsubscribe = this.coordinator.subscribe(conversationId, (event) => {
        if (webSocket.readyState === webSocket.OPEN) {
          webSocket.send(JSON.stringify({ type: "event", event }));
        }
      });
      webSocket.once("close", unsubscribe);
      webSocket.once("error", unsubscribe);
    } catch {
      webSocket.close(1008, "Conversation unavailable");
    }
  }
}

const REMOTE_CONTROL_CAPABILITIES = new Set(["mobile-control", "mac-client"]);

/**
 * Authentication proves which device is calling. This decides whether that
 * device may drive the laptop at all.
 *
 * Both entry points call it. They did not always: the WebSocket upgrade
 * authenticated and then discarded the record, so a device enrolled for
 * something other than remote control would have been refused every request
 * and handed the live event stream. Nothing exercised that gap, because the
 * only two capabilities that exist are the two named here — which is exactly
 * why it would have survived until a third was added.
 */
function authorizeForRemoteControl(device: DeviceRecord): DeviceRecord {
  if (!device.capabilities.some((capability) => REMOTE_CONTROL_CAPABILITIES.has(capability))) {
    throw new AuthenticationError("Device is not authorized for remote control");
  }
  return device;
}

function signedHeaders(request: IncomingMessage): SignedRequestHeaders {
  return SignedRequestHeadersSchema.parse({
    deviceId: singleHeader(request, "x-exarch-device-id"),
    nonce: singleHeader(request, "x-exarch-nonce"),
    counter: Number(singleHeader(request, "x-exarch-counter")),
    timestamp: singleHeader(request, "x-exarch-timestamp"),
    signature: singleHeader(request, "x-exarch-signature")
  });
}

function singleHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string") throw new AuthenticationError("Missing authentication header");
  return value;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError("Request body exceeds limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(body: Buffer): unknown {
  if (body.byteLength === 0) return {};
  return JSON.parse(body.toString("utf8")) as unknown;
}

function encodeConversationCursor(cursor: { sequence: number }): string {
  return Buffer.from(JSON.stringify({ version: 2, ...cursor }), "utf8").toString("base64url");
}

function decodeConversationCursor(value: string | null): { sequence: number } | null {
  if (value === null) return null;
  if (value.length === 0 || value.length > 1_000 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SyntaxError("Invalid conversation cursor");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const current = ConversationCursorSchema.safeParse(decoded);
    if (current.success) return { sequence: current.data.sequence };
    // Version-one cursors were ordered by provider-history timestamps. Those
    // timestamps can precede the cursor even when a conversation was imported
    // later, so force one complete metadata resync during this upgrade.
    if (LegacyConversationCursorSchema.safeParse(decoded).success) return null;
    throw new Error("unsupported cursor");
  } catch {
    throw new SyntaxError("Invalid conversation cursor");
  }
}

function encodeConversationListCursor(cursor: {
  pinned: boolean;
  updatedAt: string;
  id: string;
}): string {
  return Buffer.from(JSON.stringify({ version: 1, ...cursor }), "utf8").toString("base64url");
}

function decodeConversationListCursor(value: string | null): {
  pinned: boolean;
  updatedAt: string;
  id: string;
} | null {
  if (value === null) return null;
  if (value.length === 0 || value.length > 1_000 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SyntaxError("Invalid conversation list cursor");
  }
  try {
    const decoded = ConversationListCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown
    );
    return { pinned: decoded.pinned, updatedAt: decoded.updatedAt, id: decoded.id };
  } catch {
    throw new SyntaxError("Invalid conversation list cursor");
  }
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new SyntaxError("Invalid integer query");
  return parsed;
}

/**
 * A path segment that is not valid percent-encoding is a client mistake, so it
 * has to surface as 400. decodeURIComponent throws URIError, which used to fall
 * through to internal_error and muddy the audit log.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new SyntaxError("Path segment is not valid percent-encoding");
  }
}

function setResponseHeaders(response: ServerResponse): void {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.end(`${JSON.stringify(value)}\n`);
}
