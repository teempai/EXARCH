import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ContextCapabilityIssuer,
  ContextService,
  CanonicalStore
} from "../packages/core/src/index.js";

const execFileAsync = promisify(execFile);

describe("exarch-context CLI end to end", () => {
  let store: CanonicalStore;
  let service: ContextService;
  let socketPath: string;
  let capabilityPath: string;
  let environment: NodeJS.ProcessEnv;

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-cli-e2e-"));
    socketPath = join(directory, "control.sock");
    capabilityPath = join(directory, "capability");
    store = new CanonicalStore(":memory:");
    const project = store.createProject({ name: "CLI test", repoRoot: directory });
    const conversation = store.createConversation({
      projectId: project.id,
      title: "CLI test",
      activeProvider: "codex"
    });
    store.appendEvent({
      conversationId: conversation.id,
      turnId: "turn_cli",
      type: "assistant.message.completed",
      provider: "codex",
      payload: { text: "Launch context is available through the bounded CLI" }
    });
    const issuer = new ContextCapabilityIssuer(Buffer.alloc(32, 4));
    const capability = issuer.issue({
      id: "cap_cli",
      projectId: project.id,
      conversationId: conversation.id,
      turnId: "turn_cli",
      operations: ["current", "search"],
      lifetimeMs: 60_000
    });
    await writeFile(capabilityPath, capability, { mode: 0o600 });
    service = new ContextService(socketPath, store, issuer);
    await service.start();
    environment = {
      ...process.env,
      EXARCH_CONTEXT_SOCKET: socketPath,
      EXARCH_CONVERSATION_ID: conversation.id,
      EXARCH_PROJECT_ID: project.id,
      EXARCH_TURN_ID: "turn_cli",
      EXARCH_CONTEXT_CAPABILITY_FILE: capabilityPath
    };
  });

  afterAll(async () => {
    await service.stop();
    store.close();
  });

  it("retrieves scoped context through the real executable entry point", async () => {
    const { stdout, stderr } = await runCli(["search", "launch"]);
    expect(stderr).toBe("");
    const response = JSON.parse(stdout) as {
      ok: boolean;
      data: Array<{ event: { payload: { text: string } } }>;
    };
    expect(response.ok).toBe(true);
    expect(response.data[0]?.event.payload.text).toContain("bounded CLI");
  });

  it("prints machine-readable help without privileged environment", async () => {
    const { stdout } = await runCli(["help", "--json"], {});
    const help = JSON.parse(stdout) as { version: number; commands: string[] };
    expect(help.version).toBe(1);
    expect(help.commands).toContain("search QUERY [--limit N]");
  });

  it("hides and locally rejects mutation commands in provider read-only mode", async () => {
    const { stdout } = await runCli(["--read-only", "help", "--json"], {});
    const help = JSON.parse(stdout) as { commands: string[] };
    expect(help.commands).toContain("decisions [--status active|superseded|all]");
    expect(help.commands.some((command) => command.startsWith("decision add"))).toBe(false);
    await expect(
      runCli(["--read-only", "decision", "add", "--text", "unsafe", "--source", "event_1"])
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("read-only")
    });
  });

  it("accepts turn scope as global flags without putting the capability itself on argv", async () => {
    const { stdout } = await runCli(
      [
        "--socket", socketPath,
        "--conversation-id", environment.EXARCH_CONVERSATION_ID!,
        "--project-id", environment.EXARCH_PROJECT_ID!,
        "--turn-id", environment.EXARCH_TURN_ID!,
        "--capability-file", capabilityPath,
        "search", "launch"
      ],
      { PATH: process.env.PATH }
    );
    expect((JSON.parse(stdout) as { ok: boolean }).ok).toBe(true);
  });

  it("returns a nonzero status when capability operations deny the command", async () => {
    await expect(runCli(["tasks"], environment)).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("does not permit tasks.list")
    });
  });

  function runCli(args: string[], env: NodeJS.ProcessEnv = environment) {
    return execFileAsync(
      process.execPath,
      [
        join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        join(process.cwd(), "apps/context-cli/src/main.ts"),
        ...args
      ],
      { cwd: process.cwd(), env, timeout: 5_000 }
    );
  }
});
