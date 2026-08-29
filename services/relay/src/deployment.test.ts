import { describe, expect, it } from "vitest";
import { assertRelayDeployment, relayTrustProxy } from "./deployment.js";

describe("relay deployment policy", () => {
  it("allows local development without a proxy", () => {
    expect(() => assertRelayDeployment("127.0.0.1", false)).not.toThrow();
    expect(() => assertRelayDeployment("::1", false)).not.toThrow();
    expect(() => assertRelayDeployment("localhost", false)).not.toThrow();
  });

  it("requires an explicit trusted TLS proxy for a remotely reachable bind", () => {
    expect(() => assertRelayDeployment("0.0.0.0", false)).toThrow(/TRUST_PROXY=1/);
    expect(() => assertRelayDeployment("10.0.0.5", false)).toThrow(/TRUST_PROXY=1/);
    expect(() => assertRelayDeployment("0.0.0.0", true)).not.toThrow();
  });

  it("parses only explicit proxy settings", () => {
    expect(relayTrustProxy(undefined)).toBe(false);
    expect(relayTrustProxy("1")).toBe(true);
    expect(relayTrustProxy("false")).toBe(false);
    expect(() => relayTrustProxy("yes")).toThrow(/must be/);
  });
});
