import { describe, expect, it } from "vitest";
import { AsyncQueue } from "./async-queue.js";

describe("AsyncQueue", () => {
  it("fails closed and releases buffered values at its item limit", async () => {
    const queue = new AsyncQueue<string>({ maxItems: 2 });
    queue.push("one");
    queue.push("two");
    queue.push("overflow");

    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow("buffer limit");
  });

  it("bounds buffered bytes independently of item count", async () => {
    const queue = new AsyncQueue<string>({ maxItems: 10, maxBytes: 4, sizeOf: Buffer.byteLength });
    queue.push("1234");
    queue.push("5");

    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow("buffer limit");
  });
});
