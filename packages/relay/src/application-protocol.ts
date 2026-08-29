import { z } from "zod";
import { PairingFrameSchema } from "../../protocol/src/index.js";
import { MAX_ENCRYPTED_APPLICATION_FRAME_BYTES, type NoiseChannel } from "./noise-channel.js";

export const RELAY_APPLICATION_PROTOCOL_VERSION = 1;
export const MAX_RELAY_HTTP_BODY_BYTES = 1024 * 1024;
export const MAX_RELAY_ENVELOPE_BYTES = 1536 * 1024;

const RequestHeadersSchema = z
  .object({
    "content-type": z.literal("application/json").optional(),
    "x-exarch-device-id": z.string().min(1).max(200).optional(),
    "x-exarch-nonce": z.string().min(32).max(200).optional(),
    "x-exarch-counter": z.string().regex(/^[1-9][0-9]{0,15}$/).optional(),
    "x-exarch-timestamp": z.string().datetime({ offset: true }).optional(),
    "x-exarch-signature": z.string().min(32).max(512).optional()
  })
  .strict();

const RelativeApiPathSchema = z
  .string()
  .min(8)
  .max(4096)
  .refine((value) => {
    if (!value.startsWith("/api/v1/") || value.includes("#") || value.includes("\\")) return false;
    try {
      const parsed = new URL(value, "http://loopback.invalid");
      return parsed.origin === "http://loopback.invalid" && `${parsed.pathname}${parsed.search}` === value;
    } catch {
      return false;
    }
  }, "Path must be a canonical relative /api/v1 URL");

const EncodedBodySchema = z.string().max(Math.ceil((MAX_RELAY_HTTP_BODY_BYTES * 4) / 3) + 4);

export const RelayHttpRequestFrameSchema = z
  .object({
    version: z.literal(RELAY_APPLICATION_PROTOCOL_VERSION),
    type: z.literal("http.request"),
    requestId: z.string().min(1).max(200),
    method: z.enum(["GET", "POST"]),
    path: RelativeApiPathSchema,
    headers: RequestHeadersSchema,
    body: EncodedBodySchema
  })
  .strict()
  .superRefine((value, context) => validateEncodedBody(value.body, context));

export const RelayHttpResponseFrameSchema = z
  .object({
    version: z.literal(RELAY_APPLICATION_PROTOCOL_VERSION),
    type: z.literal("http.response"),
    requestId: z.string().min(1).max(200),
    status: z.number().int().min(100).max(599),
    contentType: z.string().min(1).max(200),
    body: EncodedBodySchema
  })
  .strict()
  .superRefine((value, context) => validateEncodedBody(value.body, context));

export const RelayApplicationFrameSchema = z.discriminatedUnion("type", [
  RelayHttpRequestFrameSchema,
  RelayHttpResponseFrameSchema,
  ...PairingFrameSchema.options
]);

export type RelayHttpRequestFrame = z.infer<typeof RelayHttpRequestFrameSchema>;
export type RelayHttpResponseFrame = z.infer<typeof RelayHttpResponseFrameSchema>;
export type RelayApplicationFrame = z.infer<typeof RelayApplicationFrameSchema>;

export function encodeBody(body: Uint8Array): string {
  if (body.byteLength > MAX_RELAY_HTTP_BODY_BYTES) throw new Error("Relay HTTP body exceeds its limit");
  return Buffer.from(body).toString("base64url");
}

export function decodeBody(body: string): Buffer {
  const decoded = Buffer.from(body, "base64url");
  if (decoded.byteLength > MAX_RELAY_HTTP_BODY_BYTES) throw new Error("Relay HTTP body exceeds its limit");
  if (decoded.toString("base64url") !== body) throw new Error("Relay HTTP body is not canonical base64url");
  return decoded;
}

export function encodeApplicationFrame(frame: RelayApplicationFrame): Buffer {
  const validated = RelayApplicationFrameSchema.parse(frame);
  const payload = Buffer.from(JSON.stringify(validated), "utf8");
  if (payload.byteLength > MAX_RELAY_ENVELOPE_BYTES) {
    throw new Error("Relay application envelope exceeds its limit");
  }
  const encoded = Buffer.allocUnsafe(payload.byteLength + 4);
  encoded.writeUInt32BE(payload.byteLength, 0);
  payload.copy(encoded, 4);
  return encoded;
}

export function sendApplicationFrame(channel: NoiseChannel, frame: RelayApplicationFrame): void {
  const encoded = encodeApplicationFrame(frame);
  for (let offset = 0; offset < encoded.byteLength; offset += MAX_ENCRYPTED_APPLICATION_FRAME_BYTES) {
    channel.send(encoded.subarray(offset, offset + MAX_ENCRYPTED_APPLICATION_FRAME_BYTES));
  }
}

export class ApplicationFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): RelayApplicationFrame[] {
    if (chunk.byteLength === 0) return [];
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const frames: RelayApplicationFrame[] = [];
    while (this.buffered.byteLength >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length < 2 || length > MAX_RELAY_ENVELOPE_BYTES) {
        throw new Error("Relay application envelope length is invalid");
      }
      if (this.buffered.byteLength < length + 4) break;
      const payload = this.buffered.subarray(4, length + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString("utf8")) as unknown;
      } catch {
        throw new Error("Relay application envelope is not valid JSON");
      }
      frames.push(RelayApplicationFrameSchema.parse(parsed));
      this.buffered = this.buffered.subarray(length + 4);
    }
    if (this.buffered.byteLength > MAX_RELAY_ENVELOPE_BYTES + 4) {
      throw new Error("Relay application buffer exceeds its limit");
    }
    return frames;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0) throw new Error("Relay application stream ended mid-frame");
  }
}

function validateEncodedBody(body: string, context: z.RefinementCtx): void {
  try {
    decodeBody(body);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Relay HTTP body is invalid"
    });
  }
}
