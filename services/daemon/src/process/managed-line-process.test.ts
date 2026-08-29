import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JsonLineRpcClient } from "./json-line-rpc.js";
import { ManagedLineProcess } from "./managed-line-process.js";

const fixture = fileURLToPath(new URL("../../../../tests/fixtures/line-rpc-provider.mjs", import.meta.url));

function fixtureProcess(mode = "rpc", maxLineBytes = 4096) {
  return new ManagedLineProcess({
    executable: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    env: { ...process.env, FIXTURE_MODE: mode },
    maxLineBytes
  });
}

describe("ManagedLineProcess and JsonLineRpcClient", () => {
  it("round-trips requests and notifications over stdin without a shell", async () => {
    const proc = fixtureProcess();
    const rpc = new JsonLineRpcClient(proc, 2_000);
    await rpc.start();
    const notifications: unknown[] = [];
    rpc.onNotification((notification) => notifications.push(notification));
    await expect(rpc.request("ping", { secretPrompt: "only-on-stdin" })).resolves.toEqual({
      method: "ping",
      params: { secretPrompt: "only-on-stdin" }
    });
    expect(proc.pid).not.toBeNull();
    await rpc.notify("notice", { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications).toEqual([{ method: "echo", params: { ok: true } }]);
    await proc.terminate(50);
  });

  it("surfaces provider-originated requests and can answer them", async () => {
    const proc = fixtureProcess();
    const rpc = new JsonLineRpcClient(proc, 2_000);
    await rpc.start();
    const request = new Promise<{ id: string | number; method: string }>((resolve) => {
      rpc.onServerRequest(resolve);
    });
    await rpc.notify("server/request");
    await expect(request).resolves.toMatchObject({ id: "server-1", method: "approval" });
    await rpc.respond("server-1", { decision: "deny" });
    await proc.terminate(50);
  });

  it("fails closed on malformed or oversized output", async () => {
    for (const [mode, limit] of [["malformed", 4096], ["oversize", 32]] as const) {
      const proc = fixtureProcess(mode, limit);
      const rpc = new JsonLineRpcClient(proc, 1_000);
      const exit = new Promise((resolve) => rpc.onExit(resolve));
      await rpc.start();
      await expect(exit).resolves.toBeDefined();
    }
  });

  it("escalates termination when a child ignores graceful signals", async () => {
    const proc = fixtureProcess("ignore-signals");
    const ready = new Promise<void>((resolve) => proc.onLine(() => resolve()));
    await proc.start();
    await ready;
    const exit = await proc.terminate(20);
    expect(exit.signal).toBe("SIGKILL");
  });

  it("rejects oversized input before writing", async () => {
    const proc = fixtureProcess("rpc", 8);
    await proc.start();
    await expect(proc.writeLine("0123456789")).rejects.toThrow("input exceeded");
    await proc.terminate(50);
  });

  it("clears failed spawn state so a transient launch can be retried", async () => {
    const proc = new ManagedLineProcess({
      executable: "/definitely/missing/exarch-provider",
      cwd: process.cwd()
    });
    await expect(proc.start()).rejects.toThrow();
    expect(proc.pid).toBeNull();
    await expect(proc.terminate()).resolves.toEqual({ code: null, signal: null });
    await expect(proc.start()).rejects.toThrow();
  });
});
