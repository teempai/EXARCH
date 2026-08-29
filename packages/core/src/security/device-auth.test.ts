import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requestSignaturePayload, type RequestSignatureInput } from "../../../protocol/src/index.js";
import { CanonicalStore } from "../store/canonical-store.js";
import {
  AuthenticationError,
  DeviceAuthenticator,
  createTestDeviceKeyPair,
  createTestP256DeviceKeyPair,
  ed25519PublicKeyFromRaw,
  p256PublicKeyFromX963
} from "./device-auth.js";

describe("DeviceAuthenticator", () => {
  it("authenticates a signed request and advances its replay counter", () => {
    const now = new Date("2026-08-23T12:00:00Z");
    const fixture = setup(() => now);
    const challenge = fixture.authenticator.issueChallenge("device_1");
    const signatureInput = requestInput(challenge, now, 1);
    const device = fixture.authenticator.verifyRequest({
      method: signatureInput.method,
      path: signatureInput.path,
      body: signatureInput.body,
      headers: {
        deviceId: "device_1",
        nonce: challenge.nonce,
        counter: 1,
        timestamp: now.toISOString(),
        signature: fixture.keys.signRequest(signatureInput)
      }
    });
    expect(device.lastCounter).toBe(1);
    expect(fixture.store.getDevice("device_1").lastCounter).toBe(1);
    fixture.store.close();
  });

  it("authenticates native P-256 request and approval signatures", () => {
    const now = new Date("2026-08-23T12:00:00Z");
    const store = new CanonicalStore(":memory:", { now: () => now });
    const signing = createTestP256DeviceKeyPair();
    const approval = createTestP256DeviceKeyPair();
    store.registerDevice({
      id: "device_p256",
      displayName: "Secure Enclave phone",
      signingPublicKey: signing.publicKey,
      approvalPublicKey: approval.publicKey
    });
    const authenticator = new DeviceAuthenticator(store, () => now);
    const challenge = authenticator.issueChallenge("device_p256");
    const signedRequest = requestInput(challenge, now, 1);
    expect(
      authenticator.verifyRequest({
        method: signedRequest.method,
        path: signedRequest.path,
        body: signedRequest.body,
        headers: {
          deviceId: "device_p256",
          nonce: challenge.nonce,
          counter: 1,
          timestamp: now.toISOString(),
          signature: signing.signRequest(signedRequest)
        }
      }).lastCounter
    ).toBe(1);
    const decision = {
      approvalId: "approval_p256",
      approvalDigest: `sha256:${"b".repeat(64)}`,
      choice: "accept",
      deviceId: "device_p256",
      decidedAt: now.toISOString()
    };
    expect(
      authenticator.verifyApprovalDecision({ ...decision, signature: approval.signApproval(decision) }).id
    ).toBe("device_p256");
    expect(() => p256PublicKeyFromX963(Buffer.alloc(64).toString("base64url"))).toThrow(/65-byte/);
    store.close();
  });

  it("rejects replay, body modification, and a stale timestamp", () => {
    let now = new Date("2026-08-23T12:00:00Z");
    const fixture = setup(() => now);
    const first = fixture.authenticator.issueChallenge("device_1");
    const firstInput = requestInput(first, now, 1);
    const headers = {
      deviceId: "device_1",
      nonce: first.nonce,
      counter: 1,
      timestamp: now.toISOString(),
      signature: fixture.keys.signRequest(firstInput)
    };
    fixture.authenticator.verifyRequest({
      method: firstInput.method,
      path: firstInput.path,
      body: firstInput.body,
      headers
    });
    expect(() =>
      fixture.authenticator.verifyRequest({
        method: firstInput.method,
        path: firstInput.path,
        body: firstInput.body,
        headers
      })
    ).toThrow(AuthenticationError);

    const second = fixture.authenticator.issueChallenge("device_1");
    const secondInput = requestInput(second, now, 2);
    expect(() =>
      fixture.authenticator.verifyRequest({
        method: secondInput.method,
        path: secondInput.path,
        body: Buffer.from("modified"),
        headers: {
          deviceId: "device_1",
          nonce: second.nonce,
          counter: 2,
          timestamp: now.toISOString(),
          signature: fixture.keys.signRequest(secondInput)
        }
      })
    ).toThrow(AuthenticationError);
    // A bad signature/body does not consume somebody else's challenge.
    expect(
      fixture.authenticator.verifyRequest({
        method: secondInput.method,
        path: secondInput.path,
        body: secondInput.body,
        headers: {
          deviceId: "device_1",
          nonce: second.nonce,
          counter: 2,
          timestamp: now.toISOString(),
          signature: fixture.keys.signRequest(secondInput)
        }
      }).lastCounter
    ).toBe(2);

    const third = fixture.authenticator.issueChallenge("device_1");
    const signedAt = now;
    now = new Date("2026-08-23T12:02:00Z");
    const thirdInput = requestInput(third, signedAt, 3);
    expect(() =>
      fixture.authenticator.verifyRequest({
        method: thirdInput.method,
        path: thirdInput.path,
        body: thirdInput.body,
        headers: {
          deviceId: "device_1",
          nonce: third.nonce,
          counter: 3,
          timestamp: signedAt.toISOString(),
          signature: fixture.keys.signRequest(thirdInput)
        }
      })
    ).toThrow(AuthenticationError);
    fixture.store.close();
  });

  it("issues indistinguishable stateless challenges for active, revoked, and missing devices", () => {
    const now = new Date("2026-08-23T12:00:00Z");
    const fixture = setup(() => now);
    const active = fixture.authenticator.issueChallenge("device_1");
    fixture.store.revokeDevice("device_1");
    const revoked = fixture.authenticator.issueChallenge("device_1");
    const missing = fixture.authenticator.issueChallenge("missing");
    for (const challenge of [active, revoked, missing]) {
      expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge.expiresAt).toBe("2026-08-23T12:00:30.000Z");
    }
    expect(() => ed25519PublicKeyFromRaw(Buffer.alloc(31).toString("base64url"))).toThrow(
      /32 bytes/
    );
    fixture.store.close();
  });

  it("observes laptop-local revocation from a separate database connection immediately", () => {
    const directory = mkdtempSync(join(tmpdir(), "exarch-device-revoke-"));
    const path = join(directory, "context.sqlite");
    const now = new Date("2026-08-23T12:00:00Z");
    const keys = createTestDeviceKeyPair();
    const daemonStore = new CanonicalStore(path, { now: () => now });
    try {
      daemonStore.registerDevice({
        id: "device_local_admin",
        displayName: "Lost phone",
        signingPublicKey: keys.publicKey,
        approvalPublicKey: keys.publicKey
      });
      const authenticator = new DeviceAuthenticator(daemonStore, () => now);
      const challenge = authenticator.issueChallenge("device_local_admin");
      const signedRequest = requestInput(challenge, now, 1);

      const adminStore = new CanonicalStore(path, { now: () => now });
      try {
        expect(adminStore.listDevices()).toHaveLength(1);
        expect(adminStore.revokeDevice("device_local_admin").status).toBe("revoked");
      } finally {
        adminStore.close();
      }

      expect(() =>
        authenticator.verifyRequest({
          method: signedRequest.method,
          path: signedRequest.path,
          body: signedRequest.body,
          headers: {
            deviceId: "device_local_admin",
            nonce: challenge.nonce,
            counter: 1,
            timestamp: now.toISOString(),
            signature: keys.signRequest(signedRequest)
          }
        })
      ).toThrow(AuthenticationError);
      expect(authenticator.issueChallenge("device_local_admin")).toMatchObject({
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
      });
    } finally {
      daemonStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("verifies a fresh decision with the separate approval key", () => {
    const now = new Date("2026-08-23T12:00:00Z");
    const store = new CanonicalStore(":memory:", { now: () => now });
    const signing = createTestDeviceKeyPair();
    const approval = createTestDeviceKeyPair();
    store.registerDevice({
      id: "device_approval",
      displayName: "Approval phone",
      signingPublicKey: signing.publicKey,
      approvalPublicKey: approval.publicKey
    });
    const authenticator = new DeviceAuthenticator(store, () => now);
    const input = {
      approvalId: "approval_1",
      approvalDigest: `sha256:${"a".repeat(64)}`,
      choice: "accept",
      deviceId: "device_approval",
      decidedAt: now.toISOString()
    };
    const signature = approval.signApproval(input);
    expect(authenticator.verifyApprovalDecision({ ...input, signature })).toMatchObject({
      id: "device_approval"
    });
    expect(() =>
      authenticator.verifyApprovalDecision({ ...input, choice: "decline", signature })
    ).toThrow(AuthenticationError);
    expect(() =>
      authenticator.verifyApprovalDecision({
        ...input,
        decidedAt: "2026-08-23T11:00:00Z",
        signature: approval.signApproval({ ...input, decidedAt: "2026-08-23T11:00:00Z" })
      })
    ).toThrow(AuthenticationError);
    store.revokeDevice("device_approval");
    expect(() =>
      authenticator.verifyApprovalDecision({ ...input, signature: approval.signApproval(input) })
    ).toThrow(AuthenticationError);
    store.close();
  });

  it("rejects an expired challenge and a replayed counter on a fresh challenge", () => {
    let now = new Date("2026-08-23T12:00:00Z");
    const fixture = setup(() => now);
    const expired = fixture.authenticator.issueChallenge("device_1");
    const signedAt = now;
    now = new Date("2026-08-23T12:00:31Z");
    const expiredInput = requestInput(expired, signedAt, 1);
    expect(() =>
      fixture.authenticator.verifyRequest({
        method: expiredInput.method,
        path: expiredInput.path,
        body: expiredInput.body,
        headers: {
          deviceId: "device_1",
          nonce: expired.nonce,
          counter: 1,
          timestamp: signedAt.toISOString(),
          signature: fixture.keys.signRequest(expiredInput)
        }
      })
    ).toThrow(AuthenticationError);

    now = new Date("2026-08-23T12:01:00Z");
    const first = fixture.authenticator.issueChallenge("device_1");
    const firstInput = requestInput(first, now, 2);
    fixture.authenticator.verifyRequest({
      method: firstInput.method,
      path: firstInput.path,
      body: firstInput.body,
      headers: {
        deviceId: "device_1",
        nonce: first.nonce,
        counter: 2,
        timestamp: now.toISOString(),
        signature: fixture.keys.signRequest(firstInput)
      }
    });
    const replay = fixture.authenticator.issueChallenge("device_1");
    const replayInput = requestInput(replay, now, 2);
    expect(() =>
      fixture.authenticator.verifyRequest({
        method: replayInput.method,
        path: replayInput.path,
        body: replayInput.body,
        headers: {
          deviceId: "device_1",
          nonce: replay.nonce,
          counter: 2,
          timestamp: now.toISOString(),
          signature: fixture.keys.signRequest(replayInput)
        }
      })
    ).toThrow(AuthenticationError);
    fixture.store.close();
  });

  it("keeps an outstanding challenge usable under an anonymous issuance flood", () => {
    const now = new Date("2026-08-23T12:00:00Z");
    const fixture = setup(() => now);
    const inFlight = fixture.authenticator.issueChallenge("device_1");
    // The challenge endpoint is unauthenticated, so anyone can call it. Issuing
    // more challenges must not invalidate the one a paired device is already
    // signing against.
    for (let index = 0; index < 1_000; index += 1) {
      fixture.authenticator.issueChallenge(index % 2 === 0 ? "device_1" : `unknown_${index}`);
    }

    const signatureInput = requestInput(inFlight, now, 1);
    const headers = {
      deviceId: "device_1",
      nonce: inFlight.nonce,
      counter: 1,
      timestamp: now.toISOString(),
      signature: fixture.keys.signRequest(signatureInput)
    };
    const verify = () =>
      fixture.authenticator.verifyRequest({
        method: signatureInput.method,
        path: signatureInput.path,
        body: signatureInput.body,
        headers
      });
    expect(verify().id).toBe("device_1");
    // Still single use.
    expect(verify).toThrow(AuthenticationError);
    fixture.store.close();
  });
});

function setup(now: () => Date) {
  const store = new CanonicalStore(":memory:", { now });
  const keys = createTestDeviceKeyPair();
  store.registerDevice({
    id: "device_1",
    displayName: "Test phone",
    signingPublicKey: keys.publicKey,
    approvalPublicKey: keys.publicKey,
    capabilities: ["mobile-control"]
  });
  return { store, keys, authenticator: new DeviceAuthenticator(store, now) };
}

function requestInput(
  challenge: { nonce: string; expiresAt: string },
  timestamp: Date,
  counter: number
): RequestSignatureInput {
  return {
    method: "POST",
    path: "/api/v1/conversations/conv_1/messages",
    body: Buffer.from('{"text":"hello"}'),
    nonce: challenge.nonce,
    counter,
    timestamp: timestamp.toISOString(),
    challengeExpiresAt: challenge.expiresAt
  };
}
