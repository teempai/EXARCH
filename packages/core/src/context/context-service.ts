import { createServer, type Server, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { createId } from "../../../protocol/src/index.js";
import { ContextCapabilityIssuer } from "./capability.js";
import {
  ContextRequestSchema,
  ContextResponseSchema,
  type ContextRequest,
  type ContextResponse
} from "./protocol.js";
import { CanonicalStore } from "../store/canonical-store.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class ContextService {
  private server: Server | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly store: CanonicalStore,
    private readonly capabilities: ContextCapabilityIssuer
  ) {}

  async start(): Promise<void> {
    if (this.server !== null) {
      throw new Error("Context service is already running");
    }
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    const server = createServer((socket) => this.accept(socket));
    // listen() creates the socket node, so the permissive window between
    // creation and chmod is closed by setting the umask around the call rather
    // than by relying on whatever the host process happened to configure.
    const previousUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } finally {
      process.umask(previousUmask);
    }
    this.server = server;
    await chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let finished = false;
    const finish = (response: ContextResponse): void => {
      if (finished) return;
      finished = true;
      let encoded = `${JSON.stringify(ContextResponseSchema.parse(response))}\n`;
      if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
        encoded = `${JSON.stringify(
          ContextResponseSchema.parse({
            version: 1,
            requestId: response.requestId,
            ok: false,
            error: { code: "response_too_large", message: "Response exceeds server limit" },
            truncated: true,
            continuation: null
          })
        )}\n`;
      }
      socket.end(encoded);
    };

    socket.on("data", (chunk: string) => {
      if (finished) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        finish(errorResponse("unknown", "request_too_large", "Request exceeds server limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      const trailing = buffer.slice(newline + 1).trim();
      if (trailing.length > 0) {
        finish(errorResponse("unknown", "multiple_requests", "One request is allowed per connection"));
        return;
      }
      try {
        const request = ContextRequestSchema.parse(JSON.parse(line) as unknown);
        finish(this.handle(request));
      } catch (error) {
        finish(
          errorResponse(
            "unknown",
            "invalid_request",
            error instanceof Error ? error.message : "Invalid request"
          )
        );
      }
    });
    socket.on("error", () => {
      finished = true;
    });
  }

  private handle(request: ContextRequest): ContextResponse {
    try {
      this.capabilities.verify(request.capability, {
        projectId: request.projectId,
        conversationId: request.conversationId,
        turnId: request.turnId,
        operation: request.operation
      });
      const conversation = this.store.getConversation(request.conversationId);
      if (conversation.projectId !== request.projectId) {
        throw new Error("Conversation does not belong to capability project");
      }
      const data = this.execute(request);
      return {
        version: 1,
        requestId: request.requestId,
        ok: true,
        data,
        truncated: false,
        continuation: null
      };
    } catch (error) {
      return errorResponse(
        request.requestId,
        "forbidden_or_invalid",
        error instanceof Error ? error.message : "Request failed"
      );
    }
  }

  private execute(request: ContextRequest): unknown {
    switch (request.operation) {
      case "current": {
        const conversation = this.store.getConversation(request.conversationId);
        const events = this.store.listRecentEvents(request.conversationId, {
          limit: 50,
          activeImportsOnly: true
        });
        return {
          conversation,
          sourceRange: {
            from: events[0]?.sequence ?? null,
            to: events.at(-1)?.sequence ?? null
          },
          recentEvents: events
        };
      }
      case "recent": {
        const before = optionalPositiveInteger(request.arguments.before);
        return this.store.listRecentEvents(request.conversationId, {
          ...(before === undefined ? {} : { before }),
          limit: optionalPositiveInteger(request.arguments.limit) ?? 50,
          activeImportsOnly: true
        });
      }
      case "search": {
        const query = requiredString(request.arguments.query, "query");
        return this.store.searchEvents(
          request.projectId,
          request.conversationId,
          query,
          optionalPositiveInteger(request.arguments.limit) ?? 20
        );
      }
      case "event.show":
        return this.store.getEvent(
          requiredString(request.arguments.eventId, "eventId"),
          request.conversationId
        );
      case "events.range": {
        const from = requiredPositiveInteger(request.arguments.from, "from");
        const to = requiredPositiveInteger(request.arguments.to, "to");
        if (to < from || to - from > 499) {
          throw new Error("Event range must be ordered and contain at most 500 events");
        }
        return this.store
          .listEvents(request.conversationId, {
            after: from - 1,
            limit: to - from + 1,
            activeImportsOnly: true
          })
          .filter((event) => event.sequence <= to);
      }
      case "decisions.list":
        return this.store.listDecisions(
          request.conversationId,
          optionalDecisionStatus(request.arguments.status)
        );
      case "decisions.add":
        return this.store.addDecision({
          id: createId("decision"),
          conversationId: request.conversationId,
          text: requiredString(request.arguments.text, "text"),
          sourceEventIds: requiredStringArray(request.arguments.sourceEventIds, "sourceEventIds"),
          provider: null,
          turnId: request.turnId
        });
      case "decisions.supersede":
        return this.store.supersedeDecision({
          conversationId: request.conversationId,
          decisionId: requiredString(request.arguments.decisionId, "decisionId"),
          replacementId: createId("decision"),
          text: requiredString(request.arguments.text, "text"),
          sourceEventIds: requiredStringArray(request.arguments.sourceEventIds, "sourceEventIds"),
          turnId: request.turnId
        });
      case "tasks.list":
        return this.store.listTasks(request.conversationId, optionalTaskStatus(request.arguments.status));
      case "tasks.add":
        return this.store.addTask({
          id: createId("task"),
          conversationId: request.conversationId,
          text: requiredString(request.arguments.text, "text"),
          sourceEventIds: requiredStringArray(request.arguments.sourceEventIds, "sourceEventIds"),
          turnId: request.turnId
        });
      case "tasks.complete":
        return this.store.completeTask({
          conversationId: request.conversationId,
          taskId: requiredString(request.arguments.taskId, "taskId"),
          sourceEventIds: requiredStringArray(request.arguments.sourceEventIds, "sourceEventIds"),
          turnId: request.turnId
        });
      case "repo-state":
        return this.store.latestEventByType(request.conversationId, "repository.checkpointed");
      case "handoffs":
        return this.store.listRecentEvents(request.conversationId, {
          limit: optionalPositiveInteger(request.arguments.limit) ?? 20,
          activeImportsOnly: true
        }).filter((event) => event.type.startsWith("provider.handoff."));
    }
  }
}

function errorResponse(requestId: string, code: string, message: string): ContextResponse {
  return {
    version: 1,
    requestId,
    ok: false,
    error: { code, message },
    truncated: false,
    continuation: null
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200_000) {
    throw new Error(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(`${name} must be a non-empty bounded string array`);
  }
  return value.map((entry) => requiredString(entry, name));
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return requiredPositiveInteger(value, "value");
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

function optionalDecisionStatus(value: unknown): "active" | "superseded" | "all" {
  if (value === undefined) return "all";
  if (!["active", "superseded", "all"].includes(String(value))) {
    throw new Error("Invalid decision status");
  }
  return value as "active" | "superseded" | "all";
}

function optionalTaskStatus(value: unknown): "open" | "completed" | "all" {
  if (value === undefined) return "all";
  if (!["open", "completed", "all"].includes(String(value))) {
    throw new Error("Invalid task status");
  }
  return value as "open" | "completed" | "all";
}
