import {
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject
} from "node:crypto";
import {
  SignedRequestHeadersSchema,
  approvalDecisionSignaturePayload,
  requestSignaturePayload,
  type ApprovalDecisionSignatureInput,
  type RequestSignatureInput,
  type SignedRequestHeaders
} from "../../../protocol/src/index.js";
import { CanonicalStore, type DeviceRecord } from "../store/canonical-store.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const P256_SPKI_PREFIX = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d030107034200",
  "hex"
);

interface Challenge {
  nonce: string;
  expiresAt: string;
}

const CHALLENGE_RANDOM_BYTES = 12;
const CHALLENGE_TAG_BYTES = 12;
const CHALLENGE_BYTES = 8 + CHALLENGE_RANDOM_BYTES + CHALLENGE_TAG_BYTES;

export class AuthenticationError extends Error {
  readonly code = "unauthenticated";
}

export class DeviceAuthenticator {
  /** Only successfully authenticated nonces are retained until their expiry. */
  private readonly consumedChallenges = new Map<string, number>();

  constructor(
    private readonly store: CanonicalStore,
    private readonly now: () => Date = () => new Date(),
    private readonly challengeLifetimeMs = 30_000,
    private readonly maximumClockSkewMs = 30_000,
    private readonly challengeSecret: Buffer = randomBytes(32)
  ) {
    if (challengeSecret.byteLength < 32) {
      throw new Error("Authentication challenge secret must contain at least 32 bytes");
    }
  }

  issueChallenge(deviceId: string): Challenge {
    // Challenge fetch is deliberately uniform for active, revoked, and unknown
    // identifiers. The nonce authenticates its device ID and expiry, so issuing
    // it requires no per-device state and reveals no enrollment membership.
    const expiresAtMs = this.now().getTime() + this.challengeLifetimeMs;
    const unsigned = Buffer.alloc(8 + CHALLENGE_RANDOM_BYTES);
    unsigned.writeBigUInt64BE(BigInt(expiresAtMs), 0);
    randomBytes(CHALLENGE_RANDOM_BYTES).copy(unsigned, 8);
    const tag = this.challengeTag(deviceId, unsigned);
    return {
      nonce: Buffer.concat([unsigned, tag]).toString("base64url"),
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  private sweepConsumed(): void {
    const now = this.now().getTime();
    for (const [nonce, expiresAt] of this.consumedChallenges) {
      if (expiresAt <= now) this.consumedChallenges.delete(nonce);
    }
  }

  verifyRequest(input: {
    method: string;
    path: string;
    body: Uint8Array;
    headers: SignedRequestHeaders;
  }): DeviceRecord {
    const headers = SignedRequestHeadersSchema.parse(input.headers);
    const challenge = this.readChallenge(headers.deviceId, headers.nonce);
    if (challenge === null) {
      return this.reject(headers.deviceId, "challenge_missing_or_mismatch");
    }
    this.sweepConsumed();
    if (this.consumedChallenges.has(headers.nonce)) {
      return this.reject(headers.deviceId, "challenge_replayed");
    }
    const now = this.now().getTime();
    if (Date.parse(challenge.expiresAt) <= now) {
      return this.reject(headers.deviceId, "challenge_expired");
    }
    const signedAt = Date.parse(headers.timestamp);
    if (!Number.isFinite(signedAt) || Math.abs(now - signedAt) > this.maximumClockSkewMs) {
      return this.reject(headers.deviceId, "timestamp_outside_window");
    }
    let device: DeviceRecord;
    try {
      device = this.store.getDevice(headers.deviceId);
    } catch {
      return this.reject(headers.deviceId, "device_missing");
    }
    if (device.status !== "active" || headers.counter <= device.lastCounter) {
      return this.reject(headers.deviceId, "device_revoked_or_counter_replayed");
    }
    const payload = requestSignaturePayload({
      method: input.method,
      path: input.path,
      body: input.body,
      nonce: headers.nonce,
      counter: headers.counter,
      timestamp: headers.timestamp,
      challengeExpiresAt: challenge.expiresAt
    });
    let valid = false;
    try {
      valid = verifyDeviceSignature(
        payload,
        device.signingPublicKey,
        Buffer.from(headers.signature, "base64url")
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      return this.reject(headers.deviceId, "signature_invalid");
    }
    try {
      this.store.advanceDeviceCounter(headers.deviceId, headers.counter);
    } catch {
      return this.reject(headers.deviceId, "counter_race_or_revocation");
    }
    // Consume only after signature and counter verification. An unauthenticated
    // request that happens to learn a nonce cannot invalidate it for the phone.
    this.consumedChallenges.set(headers.nonce, Date.parse(challenge.expiresAt));
    this.sweepConsumed();
    this.store.writeAudit("request.authenticated", headers.deviceId, "success", {
      method: input.method.toUpperCase(),
      path: input.path,
      counter: headers.counter
    });
    return this.store.getDevice(headers.deviceId);
  }

  private readChallenge(deviceId: string, nonce: string): Challenge | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
    const encoded = Buffer.from(nonce, "base64url");
    if (encoded.byteLength !== CHALLENGE_BYTES) return null;
    const unsigned = encoded.subarray(0, 8 + CHALLENGE_RANDOM_BYTES);
    const actualTag = encoded.subarray(8 + CHALLENGE_RANDOM_BYTES);
    const expectedTag = this.challengeTag(deviceId, unsigned);
    if (!timingSafeEqual(actualTag, expectedTag)) return null;
    const expiresAtMs = Number(unsigned.readBigUInt64BE(0));
    if (!Number.isSafeInteger(expiresAtMs)) return null;
    return { nonce, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private challengeTag(deviceId: string, unsigned: Buffer): Buffer {
    return createHmac("sha256", this.challengeSecret)
      .update("exarch/auth-challenge/1\0")
      .update(deviceId, "utf8")
      .update("\0")
      .update(unsigned)
      .digest()
      .subarray(0, CHALLENGE_TAG_BYTES);
  }

  verifyApprovalDecision(input: ApprovalDecisionSignatureInput & { signature: string }): DeviceRecord {
    const { signature, ...signedInput } = input;
    const now = this.now().getTime();
    const decidedAt = Date.parse(input.decidedAt);
    if (!Number.isFinite(decidedAt) || Math.abs(now - decidedAt) > this.maximumClockSkewMs) {
      return this.reject(input.deviceId, "approval_timestamp_outside_window");
    }
    let device: DeviceRecord;
    try {
      device = this.store.getDevice(input.deviceId);
    } catch {
      return this.reject(input.deviceId, "approval_device_missing");
    }
    if (device.status !== "active") return this.reject(input.deviceId, "approval_device_revoked");
    let valid = false;
    try {
      valid = verifyDeviceSignature(
        approvalDecisionSignaturePayload(signedInput),
        device.approvalPublicKey,
        Buffer.from(signature, "base64url")
      );
    } catch {
      valid = false;
    }
    if (!valid) return this.reject(input.deviceId, "approval_signature_invalid");
    this.store.writeAudit("approval.signature_verified", input.deviceId, "success", {
      approvalId: input.approvalId,
      approvalDigest: input.approvalDigest,
      choice: input.choice,
      decidedAt: input.decidedAt
    });
    return device;
  }

  private reject(deviceId: string, reason: string): never {
    this.store.writeAudit("request.authentication_failed", deviceId, "denied", { reason });
    throw new AuthenticationError("Request authentication failed");
  }
}

export function ed25519PublicKeyFromRaw(rawBase64Url: string): KeyObject {
  const raw = Buffer.from(rawBase64Url, "base64url");
  if (raw.byteLength !== 32) throw new Error("Ed25519 public key must contain 32 bytes");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki"
  });
}

export function p256PublicKeyFromX963(rawBase64Url: string): KeyObject {
  const raw = Buffer.from(rawBase64Url, "base64url");
  if (raw.byteLength !== 65 || raw[0] !== 4) {
    throw new Error("P-256 public key must be a 65-byte uncompressed X9.63 point");
  }
  return createPublicKey({
    key: Buffer.concat([P256_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki"
  });
}

export function x963P256PublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(der) || der.byteLength !== P256_SPKI_PREFIX.byteLength + 65) {
    throw new Error("Unexpected P-256 public-key encoding");
  }
  if (!der.subarray(0, P256_SPKI_PREFIX.byteLength).equals(P256_SPKI_PREFIX)) {
    throw new Error("Public key is not P-256");
  }
  return der.subarray(P256_SPKI_PREFIX.byteLength).toString("base64url");
}

export function encodeP256DevicePublicKey(rawBase64Url: string): string {
  p256PublicKeyFromX963(rawBase64Url);
  return `p256:${rawBase64Url}`;
}

export function verifyDeviceSignature(payload: Uint8Array, encodedKey: string, signature: Uint8Array): boolean {
  if (encodedKey.startsWith("p256:")) {
    return verify(
      "sha256",
      payload,
      p256PublicKeyFromX963(encodedKey.slice("p256:".length)),
      signature
    );
  }
  const raw = encodedKey.startsWith("ed25519:")
    ? encodedKey.slice("ed25519:".length)
    : encodedKey;
  return verify(null, payload, ed25519PublicKeyFromRaw(raw), signature);
}

export function rawEd25519PublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(der) || der.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32) {
    throw new Error("Unexpected Ed25519 public-key encoding");
  }
  if (!der.subarray(0, ED25519_SPKI_PREFIX.byteLength).equals(ED25519_SPKI_PREFIX)) {
    throw new Error("Public key is not Ed25519");
  }
  return der.subarray(ED25519_SPKI_PREFIX.byteLength).toString("base64url");
}

export function createTestDeviceKeyPair(): {
  publicKey: string;
  signRequest(input: RequestSignatureInput): string;
  signApproval(input: ApprovalDecisionSignatureInput): string;
} {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: rawEd25519PublicKey(pair.publicKey),
    signRequest(input) {
      return sign(null, requestSignaturePayload(input), pair.privateKey).toString("base64url");
    },
    signApproval(input) {
      return sign(null, approvalDecisionSignaturePayload(input), pair.privateKey).toString("base64url");
    }
  };
}

export function createTestP256DeviceKeyPair(): {
  publicKey: string;
  signRequest(input: RequestSignatureInput): string;
  signApproval(input: ApprovalDecisionSignatureInput): string;
} {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = encodeP256DevicePublicKey(x963P256PublicKey(pair.publicKey));
  return {
    publicKey,
    signRequest(input) {
      return sign("sha256", requestSignaturePayload(input), pair.privateKey).toString("base64url");
    },
    signApproval(input) {
      return sign("sha256", approvalDecisionSignaturePayload(input), pair.privateKey).toString(
        "base64url"
      );
    }
  };
}
