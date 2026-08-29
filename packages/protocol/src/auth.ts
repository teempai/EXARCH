import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

export const AuthChallengeRequestSchema = z
  .object({ deviceId: z.string().min(1).max(200) })
  .strict();

export const AuthChallengeResponseSchema = z
  .object({
    nonce: z.string().min(32).max(200),
    expiresAt: z.string().datetime({ offset: true })
  })
  .strict();

export const SignedRequestHeadersSchema = z
  .object({
    deviceId: z.string().min(1).max(200),
    nonce: z.string().min(32).max(200),
    counter: z.number().int().positive().safe(),
    timestamp: z.string().datetime({ offset: true }),
    signature: z.string().min(32).max(512)
  })
  .strict();

export type SignedRequestHeaders = z.infer<typeof SignedRequestHeadersSchema>;

export interface RequestSignatureInput {
  method: string;
  path: string;
  body: Uint8Array;
  nonce: string;
  counter: number;
  timestamp: string;
  challengeExpiresAt: string;
}

export function requestBodyHash(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export function requestSignaturePayload(input: RequestSignatureInput): Buffer {
  return Buffer.from(
    canonicalJson({
      version: 1,
      method: input.method.toUpperCase(),
      path: input.path,
      bodyHash: requestBodyHash(input.body),
      nonce: input.nonce,
      counter: input.counter,
      timestamp: input.timestamp,
      challengeExpiresAt: input.challengeExpiresAt
    }),
    "utf8"
  );
}
