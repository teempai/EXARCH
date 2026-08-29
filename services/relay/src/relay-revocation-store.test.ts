import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileRelayRevocationStore } from "./relay-revocation-store.js";

describe("FileRelayRevocationStore", () => {
  it("persists revoked route IDs across relay restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-relay-state-"));
    const path = join(directory, "revocations.json");
    const routingId = "r".repeat(43);
    const first = await FileRelayRevocationStore.open(path);
    await first.add(routingId);
    const reopened = await FileRelayRevocationStore.open(path);
    expect(reopened.has(routingId)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      revokedRoutingIds: [routingId]
    });
  });
});
