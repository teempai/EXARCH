import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCapabilityFile, requestContext } from "./context-client.js";

describe("context client", () => {
  it("reads a bounded capability file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-capability-test-"));
    const path = join(directory, "capability");
    await writeFile(path, "signed-token\n", { mode: 0o600 });
    await expect(readCapabilityFile(path)).resolves.toBe("signed-token");
  });

  it("rejects empty and oversized capability files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-capability-test-"));
    const empty = join(directory, "empty");
    const oversized = join(directory, "oversized");
    await writeFile(empty, Buffer.alloc(0), { mode: 0o600 });
    await writeFile(oversized, Buffer.alloc(64 * 1024 + 1, 1), { mode: 0o600 });
    await expect(readCapabilityFile(empty)).rejects.toThrow(/invalid size/);
    await expect(readCapabilityFile(oversized)).rejects.toThrow(/invalid size/);
  });

  it("surfaces connection failures", async () => {
    await expect(
      requestContext(
        "/tmp/exarch-definitely-missing.sock",
        {
          version: 1,
          requestId: "request",
          capability: "token",
          projectId: "project",
          conversationId: "conversation",
          turnId: "turn",
          operation: "current",
          arguments: {}
        },
        100
      )
    ).rejects.toBeInstanceOf(Error);
  });
});
