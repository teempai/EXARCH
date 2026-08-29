#!/usr/bin/env node
import { createId } from "../../../packages/protocol/src/index.js";
import {
  ContextRequestSchema,
  readCapabilityFile,
  requestContext,
  type ContextOperation
} from "../../../packages/core/src/index.js";

interface Invocation {
  operation: ContextOperation;
  arguments: Record<string, unknown>;
}

const READ_COMMANDS = [
  "current [--format json|text]",
  "recent [--limit N] [--before SEQUENCE]",
  "search QUERY [--limit N]",
  "event show EVENT_ID",
  "events range FROM TO",
  "decisions [--status active|superseded|all]",
  "tasks [--status open|completed|all]",
  "repo-state",
  "handoffs [--limit N]",
  "help --json"
] as const;

const WRITE_COMMANDS = [
  "decision add --text TEXT --source EVENT_ID...",
  "decision supersede DECISION_ID --with TEXT --source EVENT_ID...",
  "task add --text TEXT --source EVENT_ID...",
  "task complete TASK_ID --source EVENT_ID..."
] as const;

const HELP = {
  version: 1,
  commands: [...READ_COMMANDS, ...WRITE_COMMANDS]
};

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  const readOnly = rawArguments.includes("--read-only");
  const arguments_ = stripGlobalOptions(rawArguments);
  if (arguments_[0] === "help" || arguments_.includes("--help") || arguments_.length === 0) {
    const help = readOnly ? { ...HELP, commands: [...READ_COMMANDS] } : HELP;
    process.stdout.write(`${JSON.stringify(help, null, arguments_.includes("--json") ? 2 : 0)}\n`);
    return;
  }
  const socketPath = setting(rawArguments, "--socket", "EXARCH_CONTEXT_SOCKET");
  const conversationId = setting(rawArguments, "--conversation-id", "EXARCH_CONVERSATION_ID");
  const projectId = setting(rawArguments, "--project-id", "EXARCH_PROJECT_ID");
  const turnId = setting(rawArguments, "--turn-id", "EXARCH_TURN_ID");
  const capabilityPath = setting(rawArguments, "--capability-file", "EXARCH_CONTEXT_CAPABILITY_FILE");
  const capability = await readCapabilityFile(capabilityPath);
  const invocation = parseInvocation(arguments_);
  if (readOnly && isMutation(invocation.operation)) {
    throw new Error("This context capability is read-only");
  }
  const request = ContextRequestSchema.parse({
    version: 1,
    requestId: createId("audit"),
    capability,
    conversationId,
    projectId,
    turnId,
    operation: invocation.operation,
    arguments: invocation.arguments
  });
  const response = await requestContext(socketPath, request);
  if (!response.ok) {
    process.stderr.write(`${response.error?.code ?? "error"}: ${response.error?.message ?? "Request failed"}\n`);
    process.exitCode = 2;
    return;
  }
  const format = option(arguments_, "--format") ?? "json";
  if (format === "text") {
    process.stdout.write(`${formatText(response.data)}\n`);
  } else if (format === "json") {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } else {
    throw new Error("--format must be json or text");
  }
}

const GLOBAL_OPTIONS = [
  "--socket",
  "--conversation-id",
  "--project-id",
  "--turn-id",
  "--capability-file"
] as const;

const GLOBAL_FLAGS = ["--read-only"] as const;

function setting(args: string[], optionName: string, environmentName: string): string {
  const fromArgument = option(args, optionName);
  if (fromArgument !== undefined) return fromArgument;
  return requiredEnvironment(environmentName);
}

function stripGlobalOptions(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value !== undefined && (GLOBAL_OPTIONS as readonly string[]).includes(value)) {
      requiredPositional(args, index + 1, value);
      index += 1;
    } else if (value !== undefined && !(GLOBAL_FLAGS as readonly string[]).includes(value)) {
      result.push(value);
    }
  }
  return result;
}

function isMutation(operation: ContextOperation): boolean {
  return operation === "decisions.add" || operation === "decisions.supersede" ||
    operation === "tasks.add" || operation === "tasks.complete";
}

function parseInvocation(args: string[]): Invocation {
  switch (args[0]) {
    case "current":
      return { operation: "current", arguments: {} };
    case "recent":
      return {
        operation: "recent",
        arguments: compact({ limit: numberOption(args, "--limit"), before: numberOption(args, "--before") })
      };
    case "search":
      return {
        operation: "search",
        arguments: compact({ query: requiredPositional(args, 1, "QUERY"), limit: numberOption(args, "--limit") })
      };
    case "event":
      requireLiteral(args[1], "show");
      return { operation: "event.show", arguments: { eventId: requiredPositional(args, 2, "EVENT_ID") } };
    case "events":
      requireLiteral(args[1], "range");
      return {
        operation: "events.range",
        arguments: {
          from: positiveInteger(requiredPositional(args, 2, "FROM"), "FROM"),
          to: positiveInteger(requiredPositional(args, 3, "TO"), "TO")
        }
      };
    case "decisions":
      return { operation: "decisions.list", arguments: compact({ status: option(args, "--status") }) };
    case "decision":
      return parseDecision(args);
    case "tasks":
      return { operation: "tasks.list", arguments: compact({ status: option(args, "--status") }) };
    case "task":
      return parseTask(args);
    case "repo-state":
      return { operation: "repo-state", arguments: {} };
    case "handoffs":
      return { operation: "handoffs", arguments: compact({ limit: numberOption(args, "--limit") }) };
    default:
      throw new Error(`Unknown command: ${args[0] ?? ""}`);
  }
}

function parseDecision(args: string[]): Invocation {
  if (args[1] === "add") {
    return {
      operation: "decisions.add",
      arguments: {
        text: requiredOption(args, "--text"),
        sourceEventIds: repeatedOption(args, "--source")
      }
    };
  }
  if (args[1] === "supersede") {
    return {
      operation: "decisions.supersede",
      arguments: {
        decisionId: requiredPositional(args, 2, "DECISION_ID"),
        text: requiredOption(args, "--with"),
        sourceEventIds: repeatedOption(args, "--source")
      }
    };
  }
  throw new Error("decision requires add or supersede");
}

function parseTask(args: string[]): Invocation {
  if (args[1] === "add") {
    return {
      operation: "tasks.add",
      arguments: {
        text: requiredOption(args, "--text"),
        sourceEventIds: repeatedOption(args, "--source")
      }
    };
  }
  if (args[1] === "complete") {
    return {
      operation: "tasks.complete",
      arguments: {
        taskId: requiredPositional(args, 2, "TASK_ID"),
        sourceEventIds: repeatedOption(args, "--source")
      }
    };
  }
  throw new Error("task requires add or complete");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return requiredPositional(args, index + 1, name);
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}

function repeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      values.push(requiredPositional(args, index + 1, name));
    }
  }
  if (values.length === 0) throw new Error(`Missing ${name}`);
  return values;
}

function numberOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  return value === undefined ? undefined : positiveInteger(value, name);
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requiredPositional(args: string[], index: number, name: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

function requireLiteral(value: string | undefined, expected: string): void {
  if (value !== expected) throw new Error(`Expected ${expected}`);
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function formatText(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
});
