import { describe, expect, it } from "vitest";
import { ContextResponseSchema } from "./protocol.js";

describe("ContextResponseSchema", () => {
  it("accepts one unambiguous success or error shape", () => {
    expect(
      ContextResponseSchema.parse({
        version: 1,
        requestId: "request_1",
        ok: true,
        data: { answer: 42 },
        truncated: false,
        continuation: null
      }).ok
    ).toBe(true);
    expect(
      ContextResponseSchema.parse({
        version: 1,
        requestId: "request_2",
        ok: false,
        error: { code: "denied", message: "Denied" },
        truncated: false,
        continuation: null
      }).ok
    ).toBe(false);
  });

  it("rejects contradictory response shapes", () => {
    expect(() =>
      ContextResponseSchema.parse({
        version: 1,
        requestId: "request_1",
        ok: true,
        error: { code: "unexpected", message: "No" },
        truncated: false,
        continuation: null
      })
    ).toThrow(/Successful response/);
    expect(() =>
      ContextResponseSchema.parse({
        version: 1,
        requestId: "request_2",
        ok: false,
        truncated: false,
        continuation: null
      })
    ).toThrow(/Failed response/);
  });
});
