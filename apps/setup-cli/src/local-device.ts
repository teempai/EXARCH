import { createId } from "../../../packages/protocol/src/index.js";
import {
  encodeP256DevicePublicKey,
  type CanonicalStore,
  type DeviceRecord
} from "../../../packages/core/src/index.js";

/** Marks a device as this Mac talking to its own daemon over loopback. */
export const LOCAL_CLIENT_CAPABILITY = "mac-client";

export interface EnrollLocalDeviceInput {
  store: CanonicalStore;
  /** Raw X9.63 P-256 public key, base64url, as the Secure Enclave exports it. */
  signingPublicKey: string;
  approvalPublicKey: string;
  displayName: string;
}

/**
 * Registers the Mac application itself as a device.
 *
 * The loopback API authenticates every caller as a registered device, so the
 * Mac client needs an identity of its own. Unlike a phone it does not pair: it
 * already holds the configuration and the Keychain secrets, so it enrols
 * directly against the store.
 *
 * Enrolment is idempotent on the complete key pair. The Mac generates its keys
 * once and keeps them in its Keychain, so a relaunch presents the same keys and
 * gets the same device back rather than accumulating authority per launch.
 * A changed or revoked identity requires an explicit repair instead of being
 * silently granted fresh access.
 */
export function enrollLocalDevice(input: EnrollLocalDeviceInput): DeviceRecord {
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 200) {
    throw new Error("Local device display name must be between 1 and 200 characters");
  }
  // Validates the encoding and throws on anything that is not a P-256 point.
  const signingPublicKey = encodeP256DevicePublicKey(input.signingPublicKey);
  const approvalPublicKey = encodeP256DevicePublicKey(input.approvalPublicKey);

  const devices = input.store.listDevices();
  const existing = devices.find((device) => device.signingPublicKey === signingPublicKey);
  if (existing !== undefined) {
    if (existing.approvalPublicKey !== approvalPublicKey) {
      throw new Error("Local device approval key does not match its enrolled identity");
    }
    if (existing.status !== "active") {
      throw new Error("Local device identity was revoked; run the explicit repair flow");
    }
    if (!existing.capabilities.includes(LOCAL_CLIENT_CAPABILITY)) {
      throw new Error("Signing key is already enrolled for a different device role");
    }
    return existing;
  }

  if (devices.some((device) =>
    device.status === "active" && device.capabilities.includes(LOCAL_CLIENT_CAPABILITY)
  )) {
    throw new Error("A different Mac client identity is already active; run the explicit repair flow");
  }

  return input.store.registerDevice({
    id: createId("device"),
    displayName,
    signingPublicKey,
    approvalPublicKey,
    capabilities: [LOCAL_CLIENT_CAPABILITY],
    attestation: { transport: "loopback" }
  });
}

/**
 * Rotates the one loopback Mac-client identity after explicit local-owner
 * authentication in the native app. Phone pairings and all canonical context
 * are deliberately untouched.
 */
export function repairLocalDevice(input: EnrollLocalDeviceInput): DeviceRecord {
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 200) {
    throw new Error("Local device display name must be between 1 and 200 characters");
  }
  const signingPublicKey = encodeP256DevicePublicKey(input.signingPublicKey);
  const approvalPublicKey = encodeP256DevicePublicKey(input.approvalPublicKey);
  const localDevices = input.store.listDevices().filter((device) =>
    device.capabilities.includes(LOCAL_CLIENT_CAPABILITY)
  );
  const matching = localDevices.find((device) => device.signingPublicKey === signingPublicKey);
  if (matching?.status === "active" && matching.approvalPublicKey === approvalPublicKey) {
    return matching;
  }

  for (const device of localDevices) {
    if (device.status === "active") input.store.revokeDevice(device.id);
  }
  return input.store.registerDevice({
    id: matching?.id ?? localDevices[0]?.id ?? createId("device"),
    displayName,
    signingPublicKey,
    approvalPublicKey,
    capabilities: [LOCAL_CLIENT_CAPABILITY],
    attestation: { transport: "loopback", repaired: true }
  });
}
