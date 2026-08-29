import {
  PairingInvitationSchema,
  pairingCompletePayload,
  pairingDeviceConfirmationPayload,
  pairingHostChallengePayload,
  pairingRequestSignaturePayload,
  pairingSas,
  pairingTranscriptHash,
  type PairingInvitation,
  type PairingRequestFrame
} from "../../protocol/src/index.js";
import { verifyDeviceSignature } from "../../core/src/index.js";
import type { NoiseChannel } from "./noise-channel.js";
import { PairingWire } from "./pairing-wire.js";

export interface PairingPayloadSigner {
  publicKey: string;
  sign(payload: Uint8Array): Promise<string> | string;
}

export interface PairingDeviceInput {
  deviceId: string;
  displayName: string;
  signingKey: PairingPayloadSigner;
  approvalPublicKey: string;
}

export interface PairingClientResult {
  deviceId: string;
  transcriptHash: string;
  sas: string;
  relayAccessToken: string;
}

export async function pairDevice(
  channel: NoiseChannel,
  rawInvitation: PairingInvitation,
  input: PairingDeviceInput,
  confirmSas: (sas: string) => Promise<boolean>
): Promise<PairingClientResult> {
  const invitation = PairingInvitationSchema.parse(rawInvitation);
  if (Date.parse(invitation.expiresAt) <= Date.now()) throw new Error("Pairing invitation expired");
  if (channel.remotePeer.toString() !== invitation.hostTransportPeerId) {
    throw new Error("Pairing transport does not match the invited laptop");
  }
  const unsigned: Omit<PairingRequestFrame, "signature"> = {
    version: 1,
    type: "pair.request",
    invitationId: invitation.invitationId,
    deviceId: input.deviceId,
    displayName: input.displayName,
    signingPublicKey: input.signingKey.publicKey,
    approvalPublicKey: input.approvalPublicKey,
    transportPeerId: channel.localPeer.toString()
  };
  const request: PairingRequestFrame = {
    ...unsigned,
    signature: await input.signingKey.sign(pairingRequestSignaturePayload(invitation, unsigned))
  };
  const wire = new PairingWire(channel);
  wire.send(request);
  const challenge = await wire.receive();
  if (challenge.type === "pair.reject") throw new Error(`Pairing rejected: ${challenge.code}`);
  if (challenge.type !== "pair.challenge") throw new Error("Laptop sent an unexpected pairing message");
  const transcriptHash = pairingTranscriptHash(invitation, unsigned);
  const sas = pairingSas(transcriptHash);
  if (challenge.transcriptHash !== transcriptHash || challenge.sas !== sas) {
    throw new Error("Pairing transcript or authentication string did not match");
  }
  if (
    !verifyDeviceSignature(
      pairingHostChallengePayload(transcriptHash, sas),
      invitation.hostSigningPublicKey,
      Buffer.from(challenge.hostSignature, "base64url")
    )
  ) {
    throw new Error("Laptop pairing signature is invalid");
  }
  if (!(await confirmSas(sas))) {
    wire.send({ version: 1, type: "pair.reject", code: "declined" });
    throw new Error("Pairing was declined on the device");
  }
  wire.send({
    version: 1,
    type: "pair.confirm",
    transcriptHash,
    deviceSignature: await input.signingKey.sign(pairingDeviceConfirmationPayload(transcriptHash))
  });
  const complete = await wire.receive();
  if (complete.type === "pair.reject") throw new Error(`Pairing rejected: ${complete.code}`);
  if (complete.type !== "pair.complete" || complete.deviceId !== input.deviceId) {
    throw new Error("Laptop sent an unexpected pairing completion");
  }
  if (
    complete.transcriptHash !== transcriptHash ||
    !verifyDeviceSignature(
      pairingCompletePayload(input.deviceId, transcriptHash, complete.relayAccessToken),
      invitation.hostSigningPublicKey,
      Buffer.from(complete.hostSignature, "base64url")
    )
  ) {
    throw new Error("Laptop pairing completion signature is invalid");
  }
  return {
    deviceId: input.deviceId,
    transcriptHash,
    sas,
    relayAccessToken: complete.relayAccessToken
  };
}
