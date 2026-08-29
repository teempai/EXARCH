import { describe, expect, it } from "vitest";
import { assertRelayUrl } from "./relay-url.js";

describe("assertRelayUrl", () => {
  it("accepts TLS relays and loopback development relays", () => {
    expect(assertRelayUrl("wss://relay.example/v1/relay").protocol).toBe("wss:");
    expect(assertRelayUrl("ws://127.0.0.1:8787/v1/relay").hostname).toBe("127.0.0.1");
    expect(assertRelayUrl("ws://localhost:8787/v1/relay").hostname).toBe("localhost");
  });

  it("refuses a plaintext relay on any other host", () => {
    // This is the validator that guards the request carrying the long-lived
    // access token, so ws: to a remote host must not be reachable through it.
    expect(() => assertRelayUrl("ws://relay.example/v1/relay")).toThrow(/wss/);
    expect(() => assertRelayUrl("ws://10.0.0.5:8787/v1/relay")).toThrow(/wss/);
  });

  it("refuses credentials, other paths, queries, and fragments", () => {
    expect(() => assertRelayUrl("wss://user:pass@relay.example/v1/relay")).toThrow(/credentials/);
    expect(() => assertRelayUrl("wss://relay.example/v1/other")).toThrow(/exact/);
    expect(() => assertRelayUrl("wss://relay.example/v1/relay?a=1")).toThrow(/exact/);
    expect(() => assertRelayUrl("wss://relay.example/v1/relay#x")).toThrow(/exact/);
    expect(() => assertRelayUrl("not a url")).toThrow(/valid URL/);
  });
});
