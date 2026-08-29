import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

export const P256DevicePublicKeySchema = z.string().regex(/^p256:[A-Za-z0-9_-]{87}$/);
export const NoisePeerIdSchema = z.string().min(20).max(200);

export const PairingInvitationSchema = z
  .object({
    version: z.literal(1),
    invitationId: z.string().min(1).max(200),
    relayWebSocketUrl: z.string().url().max(2048),
    routingId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    deviceTicket: z.string().min(32).max(4096),
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    hostSigningPublicKey: P256DevicePublicKeySchema,
    hostTransportPeerId: NoisePeerIdSchema,
    expiresAt: z.string().datetime({ offset: true })
  })
  .strict();

export type PairingInvitation = z.infer<typeof PairingInvitationSchema>;

export const PairingRequestFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("pair.request"),
    invitationId: z.string().min(1).max(200),
    deviceId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    signingPublicKey: P256DevicePublicKeySchema,
    approvalPublicKey: P256DevicePublicKeySchema,
    transportPeerId: NoisePeerIdSchema,
    signature: z.string().min(32).max(512)
  })
  .strict();

export const PairingChallengeFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("pair.challenge"),
    transcriptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sas: z.string().regex(/^[0-9]{18}$/),
    hostSignature: z.string().min(32).max(512)
  })
  .strict();

export const PairingConfirmFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("pair.confirm"),
    transcriptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    deviceSignature: z.string().min(32).max(512)
  })
  .strict();

export const PairingCompleteFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("pair.complete"),
    deviceId: z.string().min(1).max(200),
    transcriptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    relayAccessToken: z.string().min(32).max(4096),
    hostSignature: z.string().min(32).max(512)
  })
  .strict();

export const PairingRejectFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("pair.reject"),
    code: z.enum(["invalid", "expired", "mismatch", "declined", "unavailable"])
  })
  .strict();

export const PairingFrameSchema = z.discriminatedUnion("type", [
  PairingRequestFrameSchema,
  PairingChallengeFrameSchema,
  PairingConfirmFrameSchema,
  PairingCompleteFrameSchema,
  PairingRejectFrameSchema
]);

export type PairingRequestFrame = z.infer<typeof PairingRequestFrameSchema>;
export type PairingChallengeFrame = z.infer<typeof PairingChallengeFrameSchema>;
export type PairingConfirmFrame = z.infer<typeof PairingConfirmFrameSchema>;
export type PairingCompleteFrame = z.infer<typeof PairingCompleteFrameSchema>;
export type PairingRejectFrame = z.infer<typeof PairingRejectFrameSchema>;
export type PairingFrame = z.infer<typeof PairingFrameSchema>;

export function pairingRequestSignaturePayload(
  invitation: PairingInvitation,
  request: Omit<PairingRequestFrame, "signature">
): Buffer {
  return Buffer.from(
    canonicalJson({
      domain: "exarch/pairing-request/1",
      invitation: pairingInvitationTranscriptFields(invitation),
      request
    }),
    "utf8"
  );
}

export function pairingTranscriptHash(
  invitation: PairingInvitation,
  request: Omit<PairingRequestFrame, "signature">
): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        domain: "exarch/pairing-transcript/1",
        invitation: pairingInvitationTranscriptFields(invitation),
        request
      })
    )
    .digest("hex")}`;
}

export function pairingSas(transcriptHash: string): string {
  const digest = Buffer.from(transcriptHash.replace(/^sha256:/, ""), "hex");
  if (digest.byteLength !== 32) throw new Error("Pairing transcript hash is invalid");
  const prefix = digest.readBigUInt64BE(0);
  return (prefix % 1_000_000_000_000_000_000n).toString().padStart(18, "0");
}

export function pairingHostChallengePayload(transcriptHash: string, sas: string): Buffer {
  return Buffer.from(
    canonicalJson({ domain: "exarch/pairing-host-challenge/1", transcriptHash, sas }),
    "utf8"
  );
}

export function pairingDeviceConfirmationPayload(transcriptHash: string): Buffer {
  return Buffer.from(
    canonicalJson({ domain: "exarch/pairing-device-confirmation/1", transcriptHash }),
    "utf8"
  );
}

export function pairingCompletePayload(
  deviceId: string,
  transcriptHash: string,
  relayAccessToken: string
): Buffer {
  return Buffer.from(
    canonicalJson({
      domain: "exarch/pairing-complete/1",
      deviceId,
      transcriptHash,
      relayAccessToken
    }),
    "utf8"
  );
}

function pairingInvitationTranscriptFields(invitation: PairingInvitation): Omit<PairingInvitation, "deviceTicket"> {
  const { deviceTicket: _deviceTicket, ...fields } = invitation;
  return fields;
}
