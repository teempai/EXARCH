import { describe, expect, it } from "vitest";
import {
  CanonicalStore,
  createTestP256DeviceKeyPair,
  encodeP256DevicePublicKey
} from "../../../packages/core/src/index.js";
import { LOCAL_CLIENT_CAPABILITY, enrollLocalDevice, repairLocalDevice } from "./local-device.js";

function store(): CanonicalStore {
  return new CanonicalStore(":memory:");
}

function keys() {
  const signing = createTestP256DeviceKeyPair();
  const approval = createTestP256DeviceKeyPair();
  // The Mac presents raw X9.63 keys; enrolment adds the p256: prefix itself.
  return {
    signingPublicKey: signing.publicKey.replace(/^p256:/, ""),
    approvalPublicKey: approval.publicKey.replace(/^p256:/, "")
  };
}

describe("local device enrolment", () => {
  it("registers the Mac as an active device it can authenticate with", () => {
    const canonical = store();
    const device = enrollLocalDevice({ store: canonical, ...keys(), displayName: "Teemu's Mac" });

    expect(device.status).toBe("active");
    expect(device.displayName).toBe("Teemu's Mac");
    expect(device.capabilities).toEqual([LOCAL_CLIENT_CAPABILITY]);
    expect(device.signingPublicKey.startsWith("p256:")).toBe(true);
    // The authenticator reads the record back by id on every request.
    expect(canonical.getDevice(device.id).id).toBe(device.id);
    canonical.close();
  });

  it("returns the same device when the Mac relaunches with its stored keys", () => {
    const canonical = store();
    const material = keys();
    const first = enrollLocalDevice({ store: canonical, ...material, displayName: "Teemu's Mac" });
    const second = enrollLocalDevice({ store: canonical, ...material, displayName: "Teemu's Mac" });

    expect(second.id).toBe(first.id);
    expect(canonical.listDevices()).toHaveLength(1);
    canonical.close();
  });

  it("requires explicit repair after the device has been revoked", () => {
    const canonical = store();
    const material = keys();
    const first = enrollLocalDevice({ store: canonical, ...material, displayName: "Teemu's Mac" });
    canonical.revokeDevice(first.id);

    expect(() => enrollLocalDevice({
      store: canonical,
      ...material,
      displayName: "Teemu's Mac"
    })).toThrow(/explicit repair/);
    canonical.close();
  });

  it("refuses a second active Mac identity", () => {
    const canonical = store();
    enrollLocalDevice({ store: canonical, ...keys(), displayName: "Teemu's Mac" });
    expect(() => enrollLocalDevice({
      store: canonical,
      ...keys(),
      displayName: "Other Mac"
    })).toThrow(/different Mac client identity/);
    canonical.close();
  });

  it("explicitly repairs only the Mac identity and preserves phone devices", () => {
    const canonical = store();
    const oldMac = enrollLocalDevice({ store: canonical, ...keys(), displayName: "Old Mac" });
    const phoneKeys = keys();
    const phone = canonical.registerDevice({
      id: "device_phone",
      displayName: "Phone",
      signingPublicKey: encodeP256DevicePublicKey(phoneKeys.signingPublicKey),
      approvalPublicKey: encodeP256DevicePublicKey(phoneKeys.approvalPublicKey),
      capabilities: ["mobile-control"]
    });
    const replacement = keys();
    const repaired = repairLocalDevice({
      store: canonical,
      ...replacement,
      displayName: "Repaired Mac"
    });

    expect(repaired.id).toBe(oldMac.id);
    expect(repaired.status).toBe("active");
    expect(repaired.signingPublicKey).toBe(encodeP256DevicePublicKey(replacement.signingPublicKey));
    expect(canonical.getDevice(phone.id).status).toBe("active");
    canonical.close();
  });

  it("refuses approval-key drift for an enrolled signing key", () => {
    const canonical = store();
    const material = keys();
    enrollLocalDevice({ store: canonical, ...material, displayName: "Teemu's Mac" });
    expect(() => enrollLocalDevice({
      store: canonical,
      signingPublicKey: material.signingPublicKey,
      approvalPublicKey: keys().approvalPublicKey,
      displayName: "Teemu's Mac"
    })).toThrow(/approval key/);
    canonical.close();
  });

  it("refuses a phone signing key as a local Mac identity", () => {
    const canonical = store();
    const material = keys();
    canonical.registerDevice({
      id: "device_phone",
      displayName: "Phone",
      signingPublicKey: encodeP256DevicePublicKey(material.signingPublicKey),
      approvalPublicKey: encodeP256DevicePublicKey(material.approvalPublicKey),
      capabilities: ["mobile-control"]
    });
    expect(() => enrollLocalDevice({
      store: canonical,
      ...material,
      displayName: "Teemu's Mac"
    })).toThrow(/different device role/);
    canonical.close();
  });

  it("refuses malformed keys and empty names", () => {
    const canonical = store();
    const material = keys();
    expect(() => enrollLocalDevice({ store: canonical, ...material, displayName: "  " }))
      .toThrow(/display name/);
    expect(() =>
      enrollLocalDevice({ store: canonical, signingPublicKey: "not-a-key", approvalPublicKey: material.approvalPublicKey, displayName: "Mac" })
    ).toThrow();
    canonical.close();
  });
});
