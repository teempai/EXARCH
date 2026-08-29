import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextCapabilityIssuer } from "../../../packages/core/src/index.js";
import { ContextAccessManager } from "./context-access.js";

describe("turn-scoped context access", () => {
  it("places the bearer capability only in a mode-0600 file and removes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-context-access-"));
    const manager = new ContextAccessManager({
      issuer: new ContextCapabilityIssuer(Buffer.alloc(32, 9)),
      socketPath: join(directory, "context.sock"),
      capabilityDirectory: join(directory, "capabilities"),
      nodeExecutable: "/usr/bin/node",
      cliPath: "/opt/exarch/exarch-context.js"
    });
    const access = await manager.create({
      projectId: "project_one",
      conversationId: "conv_one",
      turnId: "turn_one"
    });
    expect(access.command).toContain("'/opt/exarch/exarch-context.js'");
    expect(access.command).toContain("'--read-only'");
    expect(access.command).not.toContain("exarch/context-capability");
    const match = access.command.match(/--capability-file' '([^']+)'/);
    expect(match?.[1]).toBeDefined();
    const capabilityPath = match![1]!;
    expect((await lstat(capabilityPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(capabilityPath, "utf8")).split(".")).toHaveLength(2);
    await access.dispose();
    await expect(lstat(capabilityPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access.dispose()).resolves.toBeUndefined();
  });

  it("revokes the capability when the turn disposes it, not merely the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-context-revoke-"));
    const issuer = new ContextCapabilityIssuer(Buffer.alloc(32, 4));
    const manager = new ContextAccessManager({
      issuer,
      socketPath: join(directory, "context.sock"),
      capabilityDirectory: join(directory, "capabilities"),
      nodeExecutable: "/usr/bin/node",
      cliPath: "/opt/exarch/exarch-context.js"
    });
    const access = await manager.create({
      projectId: "project_two",
      conversationId: "conv_two",
      turnId: "turn_two"
    });
    const capabilityPath = access.command.match(/--capability-file' '([^']+)'/)![1]!;
    // Stand in for anything that copied the token out while the turn ran.
    const leaked = (await readFile(capabilityPath, "utf8")).trim();
    const expected = {
      projectId: "project_two",
      conversationId: "conv_two",
      turnId: "turn_two",
      operation: "decisions.list" as const
    };
    expect(issuer.verify(leaked, expected).turnId).toBe("turn_two");
    expect(() => issuer.verify(leaked, { ...expected, operation: "decisions.add" })).toThrow(
      /does not permit/
    );

    await access.dispose();
    expect(() => issuer.verify(leaked, expected)).toThrow(/Revoked/);
  });

  it("uses the issuer clock for the revocation lifetime", async () => {
    let now = new Date("2026-08-23T12:00:00.000Z");
    const issuer = new ContextCapabilityIssuer(Buffer.alloc(32, 6), () => now);
    const directory = await mkdtemp(join(tmpdir(), "exarch-context-clock-"));
    const manager = new ContextAccessManager({
      issuer,
      socketPath: join(directory, "context.sock"),
      capabilityDirectory: join(directory, "capabilities"),
      nodeExecutable: "/usr/bin/node",
      cliPath: "/opt/exarch/exarch-context.js",
      capabilityLifetimeMs: 60_000
    });
    const access = await manager.create({
      projectId: "project_clock",
      conversationId: "conv_clock",
      turnId: "turn_clock"
    });
    const capabilityPath = access.command.match(/--capability-file' '([^']+)'/)![1]!;
    const token = (await readFile(capabilityPath, "utf8")).trim();
    const capabilityId = issuer.verify(token, {
      projectId: "project_clock",
      conversationId: "conv_clock",
      turnId: "turn_clock",
      operation: "current"
    }).id;
    await access.dispose();
    expect(issuer.isRevoked(capabilityId)).toBe(true);
    now = new Date("2026-08-23T12:01:01.000Z");
    expect(issuer.isRevoked(capabilityId)).toBe(false);
  });
});
