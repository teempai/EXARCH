import readline from "node:readline";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const mode = process.env.FIXTURE_MODE ?? "rpc";
const variant = process.env.FIXTURE_VARIANT ?? "";
if (mode === "hermes" && process.argv.includes("--version")) {
  process.stdout.write(`Hermes Agent v${variant === "unsupported" ? "9.9.9" : "0.20.5"} (fixture)\n`);
} else if (mode === "hermes" && process.argv.includes("config")) {
  if (process.argv.includes("path")) process.stdout.write(`${process.env.HERMES_FIXTURE_CONFIG}\n`);
  else if (process.argv.includes("model")) {
    process.stdout.write(`${JSON.stringify({ default: "openai/gpt-5.6-terra", provider: "openrouter" })}\n`);
  }
  else process.stdout.write(`${JSON.stringify(variant === "invalid_mode" ? "weird" : variant === "off" ? "off" : "smart")}\n`);
} else if (mode === "claude" && process.argv.includes("--version")) {
  process.stdout.write(`${variant === "unsupported" ? "9.9.9" : "2.1.87"} (Claude Code)\n`);
} else if (mode === "claude" && process.argv.includes("auth") && process.argv.includes("status")) {
  process.stdout.write(`${JSON.stringify({
    loggedIn: variant !== "unauthenticated",
    authMethod: variant === "unauthenticated" ? "none" : "claude.ai",
    apiProvider: "firstParty"
  })}\n`);
  if (variant === "unauthenticated") process.exitCode = 1;
} else if (mode === "codex" && process.argv.includes("--version")) {
  const version = variant === "unsupported"
    ? "9.9.9"
    : variant === "legacy_supported"
      ? "0.149.0-alpha.4.1"
      : "0.150.0-alpha.12.2";
  process.stdout.write(`codex-cli ${version}\n`);
} else if (mode === "oversize") {
  process.stdout.write("x".repeat(1024));
} else if (mode === "malformed") {
  process.stdout.write("not-json\n");
} else if (mode === "ignore-signals") {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  process.stdout.write("ready\n");
  setInterval(() => {}, 1_000);
} else {
  if (mode === "claude" && process.env.EXPECTED_MODEL) {
    const modelIndex = process.argv.indexOf("--model");
    if (process.argv[modelIndex + 1] !== process.env.EXPECTED_MODEL) process.exit(42);
  }
  if (mode === "claude" && process.env.EXPECTED_RESUME) {
    const resumeIndex = process.argv.indexOf("--resume");
    if (process.argv[resumeIndex + 1] !== process.env.EXPECTED_RESUME) process.exit(43);
  }
  if (mode === "hermes") {
    if (process.env.EXPECTED_GATEWAY_CWD && process.cwd() !== process.env.EXPECTED_GATEWAY_CWD) process.exit(46);
    if (process.env.EXPECTED_PYTHONSAFEPATH && process.env.PYTHONSAFEPATH !== process.env.EXPECTED_PYTHONSAFEPATH) process.exit(47);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } })}\n`);
  }
  const lines = readline.createInterface({ input: process.stdin });
  let hermesPending = false;
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (mode === "hermes") {
      if (request.method === "session.create") {
        if (process.env.EXPECTED_MODEL && request.params?.model !== process.env.EXPECTED_MODEL) process.exit(42);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { session_id: "gateway-session-1", stored_session_id: "stored-session-1" } })}\n`);
      } else if (request.method === "session.resume") {
        if (request.params?.session_id !== "stored-session-1") process.exit(43);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { session_id: "gateway-session-1", resumed: "stored-session-1" } })}\n`);
      } else if (request.method === "prompt.submit") {
        assertExpectedPrompt(request.params?.text ?? "");
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { accepted: true } })}\n`);
        const event = (type, payload) => JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, session_id: "gateway-session-1", payload } });
        if (variant === "hang") return;
        if (variant === "gateway_error" || variant === "usage_limit") {
          process.stdout.write(`${event("error", { message: variant === "usage_limit" ? "Provider usage limit reached; resets at midnight" : "gateway failed" })}\n`);
          return;
        }
        process.stdout.write(`${event("tool.start", { tool_id: "tool-1", name: "terminal", args_text: "pwd" })}\n`);
        process.stdout.write(`${event("approval.request", { request_id: "approval-1", command: "pwd", description: "dangerous command", choices: ["once", "session", "always", "deny"] })}\n`);
        if (variant === "duplicate_approval") {
          process.stdout.write(`${event("approval.request", { request_id: "approval-1", command: "echo changed", description: "duplicate", choices: ["once", "deny"] })}\n`);
          return;
        }
        hermesPending = true;
      } else if (request.method === "approval.respond" && hermesPending) {
        hermesPending = false;
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { resolved: true } })}\n`);
        const event = (type, payload) => JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, session_id: "gateway-session-1", payload } });
        process.stdout.write(`${event("tool.complete", { tool_id: "tool-1", name: "terminal", result_text: "/tmp", ...(variant === "tool_error" ? { error: "failed" } : {}) })}\n`);
        process.stdout.write(`${event("message.start", {})}\n`);
        process.stdout.write(`${event("message.delta", { text: "hello" })}\n`);
        process.stdout.write(`${event("message.complete", { text: "hello" })}\n`);
      } else if (request.method === "session.interrupt") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { interrupted: true } })}\n`);
      }
    } else if (mode === "claude") {
      const prompt = request?.message?.content?.[0]?.text ?? "";
      assertExpectedPrompt(prompt);
      if (process.argv.includes(prompt)) process.exit(41);
      const session_id = "claude-session-1";
      process.stdout.write(`${JSON.stringify({
        type: "rate_limit_event",
        session_id,
        uuid: "rate-fixture",
        rate_limit_info: {
          status: variant === "usage_limit" ? "rejected" : "allowed",
          rateLimitType: "seven_day",
          utilization: variant === "usage_limit" ? 1 : 0.42,
          resetsAt: 1893456000
        }
      })}\n`);
      if (variant === "usage_limit") return;
      process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id, permissionMode: "default", model: "fixture" })}\n`);
      if (variant === "hang") return;
      if (variant === "error_result") {
        process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id })}\n`);
        return;
      }
      if (variant === "result_only") {
        process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id, result: "fallback" })}\n`);
        return;
      }
      if (variant === "approval") {
        process.stdout.write(`${JSON.stringify({ type: "stream_event", session_id, event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-approval", name: "Bash", input: { command: "pwd" } } } })}\n`);
        void invokePermissionPrompt("Bash", { command: "pwd" }).then((decision) => {
          const allowed = decision?.behavior === "allow";
          process.stdout.write(`${JSON.stringify({ type: "user", session_id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-approval", content: allowed ? "/tmp" : "denied", is_error: !allowed }] } })}\n`);
          process.stdout.write(`${JSON.stringify({ type: "assistant", session_id, message: { role: "assistant", content: [{ type: "text", text: allowed ? "approved" : "denied" }] } })}\n`);
          process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id, result: allowed ? "approved" : "denied" })}\n`);
        });
        return;
      }
      process.stdout.write(`${JSON.stringify({ type: "stream_event", session_id, event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } } } })}\n`);
      process.stdout.write(`${JSON.stringify({ type: "user", session_id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: variant === "tool_error" }] } })}\n`);
      process.stdout.write(`${JSON.stringify({ type: "stream_event", session_id, event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } })}\n`);
      process.stdout.write(`${JSON.stringify({ type: "assistant", session_id, message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })}\n`);
      process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id, result: "hello" })}\n`);
    } else if (mode === "codex") {
      if (request.method === "initialize") {
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "fixture", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } })}\n`);
      } else if (request.method === "config/read") {
        if (variant === "config_error") {
          process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -1, message: "config failed" } })}\n`);
          return;
        }
        process.stdout.write(`${JSON.stringify({ id: request.id, result: {
          config: {
            approval_policy: "on-request",
            ...(variant === "partial" ? {} : { approvals_reviewer: "user", sandbox_mode: "workspace-write" }),
            default_permissions: null,
            model: "fixture-model",
            ignored_secret: "must-not-be-copied"
          },
          origins: { approval_policy: { version: "sha256:test" }, ignored_secret: { value: "secret" } }
        } })}\n`);
      } else if (request.method === "model/list") {
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [
          { id: "fixture-model", model: "fixture-model", displayName: "Fixture Model", description: "For tests", hidden: false },
          { id: "hidden-model", model: "hidden-model", displayName: "Hidden", hidden: true }
        ], nextCursor: null } })}\n`);
      } else if (request.method === "account/rateLimits/read") {
        const exhausted = variant === "capacity_exhausted";
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          rateLimitReachedType: exhausted ? "rate_limit_reached" : null,
          spendControlReached: false,
          primary: { usedPercent: exhausted ? 100 : 25, windowDurationMins: 300, resetsAt: 1787529600 },
          secondary: { usedPercent: exhausted ? 100 : 62, windowDurationMins: 10080, resetsAt: 1787961600 }
        }, rateLimitsByLimitId: null } })}\n`);
      } else if (request.method === "thread/start") {
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "native-thread-1" } } })}\n`);
      } else if (request.method === "thread/resume") {
        if (request.params?.threadId !== "native-thread-1") process.exit(43);
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "native-thread-1" } } })}\n`);
      } else if (request.method === "turn/start") {
        if (process.env.EXPECTED_MODEL && request.params?.model !== process.env.EXPECTED_MODEL) process.exit(42);
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "native-turn-1" } } })}\n`);
        const base = { threadId: "native-thread-1", turnId: "native-turn-1" };
        const prompt = request?.params?.input?.[0]?.text ?? "";
        assertExpectedPrompt(prompt);
        if (variant === "usage_limit") {
          process.stdout.write(`${JSON.stringify({ method: "error", params: {
            ...base,
            willRetry: false,
            error: { message: "Codex usage limit reached", codexErrorInfo: "usageLimitExceeded" }
          } })}\n`);
          return;
        }
        if (prompt.includes("failure fixture")) {
          process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { ...base, turn: { id: "native-turn-1", status: "failed" } } })}\n`);
          return;
        }
        if (prompt.includes("interrupt fixture")) return;
        if (prompt.includes("approval fixture")) {
          process.stdout.write(`${JSON.stringify({ id: "codex-approval-1", method: "item/commandExecution/requestApproval", params: { ...base, itemId: "tool-approval", startedAtMs: 1, command: "pwd", cwd: "/tmp" } })}\n`);
          if (prompt.includes("duplicate approval fixture")) {
            process.stdout.write(`${JSON.stringify({ id: "codex-approval-1", method: "item/commandExecution/requestApproval", params: { ...base, itemId: "tool-duplicate", startedAtMs: 2, command: "echo changed", cwd: "/tmp" } })}\n`);
          }
          if (prompt.includes("typed approval fixture")) {
            process.stdout.write(`${JSON.stringify({ id: 1, method: "item/commandExecution/requestApproval", params: { ...base, itemId: "tool-number", startedAtMs: 2, command: "one", cwd: "/tmp" } })}\n`);
            process.stdout.write(`${JSON.stringify({ id: "1", method: "item/commandExecution/requestApproval", params: { ...base, itemId: "tool-string", startedAtMs: 3, command: "string one", cwd: "/tmp" } })}\n`);
            process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { ...base, turn: { id: "native-turn-1", status: "completed" } } })}\n`);
          }
          return;
        }
        process.stdout.write(`${JSON.stringify({ method: "item/started", params: { ...base, item: { id: "tool-1", type: "commandExecution", command: "pwd" } } })}\n`);
        process.stdout.write(`${JSON.stringify({ method: "item/commandExecution/outputDelta", params: { ...base, itemId: "tool-1", delta: "/tmp" } })}\n`);
        process.stdout.write(`${JSON.stringify({ method: "item/completed", params: { ...base, item: { id: "tool-1", type: "commandExecution", status: "completed" } } })}\n`);
        process.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { ...base, itemId: "message-1", delta: "hello" } })}\n`);
        process.stdout.write(`${JSON.stringify({ method: "item/completed", params: { ...base, item: { id: "message-1", type: "agentMessage", text: "hello" } } })}\n`);
        process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { ...base, turn: { id: "native-turn-1", status: "completed" } } })}\n`);
      } else if (request.method === "turn/interrupt") {
        process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        const base = { threadId: "native-thread-1", turnId: "native-turn-1" };
        process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { ...base, turn: { id: "native-turn-1", status: "interrupted" } } })}\n`);
      } else if (request.id === "codex-approval-1" && request.result) {
        const base = { threadId: "native-thread-1", turnId: "native-turn-1" };
        process.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { ...base, itemId: "message-approval", delta: "approved" } })}\n`);
        process.stdout.write(`${JSON.stringify({ method: "item/completed", params: { ...base, item: { id: "message-approval", type: "agentMessage", text: "approved" } } })}\n`);
        process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { ...base, turn: { id: "native-turn-1", status: "completed" } } })}\n`);
      }
    } else if (request.method === "server/request") {
      process.stdout.write(`${JSON.stringify({ id: "server-1", method: "approval", params: { command: "pwd" } })}\n`);
    } else if (request.id !== undefined) {
      process.stdout.write(`${JSON.stringify({ id: request.id, result: { method: request.method, params: request.params } })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ method: "echo", params: request.params })}\n`);
    }
  });
}

function assertExpectedPrompt(prompt) {
  if (process.env.EXPECTED_PROMPT !== undefined && prompt !== process.env.EXPECTED_PROMPT) {
    process.exit(44);
  }
  if (
    process.env.EXPECTED_PROMPT_CONTAINS !== undefined &&
    !prompt.includes(process.env.EXPECTED_PROMPT_CONTAINS)
  ) {
    process.exit(45);
  }
}

async function invokePermissionPrompt(toolName, input) {
  const flag = process.argv.indexOf("--mcp-config");
  if (flag < 0 || typeof process.argv[flag + 1] !== "string") {
    throw new Error("fixture missing MCP config");
  }
  const config = JSON.parse(readFileSync(process.argv[flag + 1], "utf8"));
  const definition = config.mcpServers?.exarch_permissions;
  const child = spawn(definition.command, definition.args, { stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  const output = readline.createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const response = JSON.parse(line);
    const pending = responses.get(String(response.id));
    if (pending === undefined) return;
    responses.delete(String(response.id));
    if (response.error) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result);
  });
  let nextId = 0;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      responses.set(String(nextId), { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params })}\n`);
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  await request("tools/list");
  const result = await request("tools/call", {
    name: "approval_prompt",
    arguments: { tool_name: toolName, input }
  });
  child.kill("SIGTERM");
  return JSON.parse(result.content[0].text);
}
