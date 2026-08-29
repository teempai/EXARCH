import { describe, expect, it } from "vitest";
import { requestBodyHash, requestSignaturePayload } from "./auth.js";

describe("request authentication protocol", () => {
  it("hashes exact body bytes and canonicalizes method", () => {
    const body = Buffer.from("hello");
    expect(requestBodyHash(body)).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    const lower = requestSignaturePayload({
      method: "post",
      path: "/api/v1/test",
      body,
      nonce: "nonce",
      counter: 1,
      timestamp: "2026-08-23T12:00:00.000Z",
      challengeExpiresAt: "2026-08-23T12:00:30.000Z"
    });
    const upper = requestSignaturePayload({
      method: "POST",
      path: "/api/v1/test",
      body,
      nonce: "nonce",
      counter: 1,
      timestamp: "2026-08-23T12:00:00.000Z",
      challengeExpiresAt: "2026-08-23T12:00:30.000Z"
    });
    expect(lower).toEqual(upper);
  });
});
