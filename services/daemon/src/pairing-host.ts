import { randomBytes } from "node:crypto";
import {
  PairingInvitationSchema,
  pairingCompletePayload,
  pairingDeviceConfirmationPayload,
  pairingHostChallengePayload,
  pairingRequestSignaturePayload,
  pairingSas,
  pairingTranscriptHash,
  createId,
  type PairingInvitation,
  type PairingRequestFrame
} from "../../../packages/protocol/src/index.js";
import {
  PairingWire,
  type NoiseChannel,
  type PairingPayloadSigner
} from "../../../packages/relay/src/index.js";
import {
  CanonicalStore,
  verifyDeviceSignature,
  type DeviceRecord
} from "../../../packages/core/src/index.js";

interface StoredInvitation {
  invitation: PairingInvitation;
  deviceAccessToken: string;
  state: "available" | "pending" | "consumed";
}

export interface PendingPairingConfirmation {
  invitationId: string;
  deviceId: string;
  displayName: string;
  sas: string;
  transcriptHash: string;
  transportPeerId: string;
}

export interface PairingHostOptions {
  store: CanonicalStore;
  hostSigningKey: PairingPayloadSigner;
  hostTransportPeerId: string;
  confirm: (pairing: PendingPairingConfirmation) => Promise<boolean>;
  now?: () => Date;
}

export class PairingHost {
  private readonly invitations = new Map<string, StoredInvitation>();
  private readonly now: () => Date;

  constructor(private readonly options: PairingHostOptions) {
    this.now = options.now ?? (() => new Date());
  }

  createInvitation(input: {
    relayWebSocketUrl: string;
    routingId: string;
    deviceTicket: string;
    deviceAccessToken: string;
    lifetimeMs?: number;
  }): PairingInvitation {
    const lifetimeMs = input.lifetimeMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 30_000 || lifetimeMs > 10 * 60_000) {
      throw new Error("Pairing invitation lifetime is outside the allowed range");
    }
    const invitation = PairingInvitationSchema.parse({
      version: 1,
      invitationId: createId("invitation"),
      relayWebSocketUrl: input.relayWebSocketUrl,
      routingId: input.routingId,
      deviceTicket: input.deviceTicket,
      challenge: randomBytes(32).toString("base64url"),
      hostSigningPublicKey: this.options.hostSigningKey.publicKey,
      hostTransportPeerId: this.options.hostTransportPeerId,
      expiresAt: new Date(this.now().getTime() + lifetimeMs).toISOString()
    });
    if (input.deviceAccessToken.length < 32 || input.deviceAccessToken.length > 4096) {
      throw new Error("Device relay access token is invalid");
    }
    this.invitations.set(invitation.invitationId, {
      invitation,
      deviceAccessToken: input.deviceAccessToken,
      state: "available"
    });
    this.options.store.writeAudit("pairing.invitation_created", invitation.invitationId, "success", {
      expiresAt: invitation.expiresAt
    });
    return invitation;
  }

  async accept(channel: NoiseChannel): Promise<DeviceRecord> {
    const wire = new PairingWire(channel);
    let stored: StoredInvitation | undefined;
    try {
      const first = await wire.receive();
      if (first.type !== "pair.request") throw new PairingFailure("invalid", "Expected pairing request");
      stored = this.invitations.get(first.invitationId);
      if (stored === undefined || stored.state !== "available") {
        throw new PairingFailure("unavailable", "Pairing invitation is unavailable");
      }
      stored.state = "pending";
      const invitation = stored.invitation;
      if (Date.parse(invitation.expiresAt) <= this.now().getTime()) {
        throw new PairingFailure("expired", "Pairing invitation expired");
      }
      if (first.transportPeerId !== channel.remotePeer.toString()) {
        throw new PairingFailure("mismatch", "Pairing transport identity did not match");
      }
      const unsigned = withoutSignature(first);
      if (
        !verifyDeviceSignature(
          pairingRequestSignaturePayload(invitation, unsigned),
          first.signingPublicKey,
          Buffer.from(first.signature, "base64url")
        )
      ) {
        throw new PairingFailure("invalid", "Pairing request signature is invalid");
      }
      const transcriptHash = pairingTranscriptHash(invitation, unsigned);
      const sas = pairingSas(transcriptHash);
      wire.send({
        version: 1,
        type: "pair.challenge",
        transcriptHash,
        sas,
        hostSignature: await this.options.hostSigningKey.sign(
          pairingHostChallengePayload(transcriptHash, sas)
        )
      });
      const accepted = await this.options.confirm({
        invitationId: invitation.invitationId,
        deviceId: first.deviceId,
        displayName: first.displayName,
        sas,
        transcriptHash,
        transportPeerId: first.transportPeerId
      });
      if (!accepted) throw new PairingFailure("declined", "Pairing was declined on the laptop");
      const confirmation = await wire.receive();
      if (
        confirmation.type !== "pair.confirm" ||
        confirmation.transcriptHash !== transcriptHash ||
        !verifyDeviceSignature(
          pairingDeviceConfirmationPayload(transcriptHash),
          first.signingPublicKey,
          Buffer.from(
            confirmation.type === "pair.confirm" ? confirmation.deviceSignature : "",
            "base64url"
          )
        )
      ) {
        throw new PairingFailure("mismatch", "Device pairing confirmation is invalid");
      }
      const device = this.options.store.registerDevice({
        id: first.deviceId,
        displayName: first.displayName,
        signingPublicKey: first.signingPublicKey,
        approvalPublicKey: first.approvalPublicKey,
        capabilities: ["mobile-control"],
        attestation: {
          transportPeerId: first.transportPeerId,
          pairingTranscriptHash: transcriptHash
        }
      });
      stored.state = "consumed";
      wire.send({
        version: 1,
        type: "pair.complete",
        deviceId: first.deviceId,
        transcriptHash,
        relayAccessToken: stored.deviceAccessToken,
        hostSignature: await this.options.hostSigningKey.sign(
          pairingCompletePayload(first.deviceId, transcriptHash, stored.deviceAccessToken)
        )
      });
      this.options.store.writeAudit("pairing.completed", first.deviceId, "success", {
        invitationId: invitation.invitationId,
        transcriptHash,
        transportPeerId: first.transportPeerId
      });
      return device;
    } catch (error) {
      if (stored !== undefined) stored.state = "consumed";
      const failure = error instanceof PairingFailure ? error : new PairingFailure("invalid", "Pairing failed");
      try {
        wire.send({ version: 1, type: "pair.reject", code: failure.code });
      } catch {
        // The encrypted transport may already be unavailable.
      }
      this.options.store.writeAudit("pairing.failed", stored?.invitation.invitationId ?? null, "denied", {
        code: failure.code
      });
      throw failure;
    }
  }
}

class PairingFailure extends Error {
  constructor(readonly code: "invalid" | "expired" | "mismatch" | "declined" | "unavailable", message: string) {
    super(message);
  }
}

function withoutSignature(request: PairingRequestFrame): Omit<PairingRequestFrame, "signature"> {
  const { signature: _signature, ...unsigned } = request;
  return unsigned;
}
