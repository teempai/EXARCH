import { describe, expect, it, vi } from "vitest";
import { RelayHttpBridge } from "./relay-http-bridge.js";

describe("RelayHttpBridge", () => {
  it("forwards only the validated relative request to loopback", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:43120/api/v1/health");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-exarch-device-id")).toBe("device_1");
      return new Response('{"status":"ok"}\n', {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    });
    const bridge = new RelayHttpBridge("http://127.0.0.1:43120", request);
    const response = await bridge.handle({
      method: "POST",
      path: "/api/v1/health",
      headers: { "x-exarch-device-id": "device_1" },
      body: Buffer.from("{}", "utf8")
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("application/json");
    expect(response.body.toString("utf8")).toBe('{"status":"ok"}\n');
  });

  it("rejects non-loopback targets and oversized responses", async () => {
    expect(() => new RelayHttpBridge("https://example.com")).toThrow(/loopback/);
    expect(() => new RelayHttpBridge("http://127.0.0.1:1234/untrusted")).toThrow(/must not include/);
    const request = vi.fn<typeof fetch>(async () =>
      new Response(Buffer.alloc(1024 * 1024 + 1), { status: 200 })
    );
    const bridge = new RelayHttpBridge("http://[::1]:43120", request);
    await expect(bridge.handle({ method: "GET", path: "/api/v1/health" })).rejects.toThrow(
      /exceeds relay limit/
    );
  });
});
