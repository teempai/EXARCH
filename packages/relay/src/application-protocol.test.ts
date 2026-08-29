import { describe, expect, it } from "vitest";
import {
  ApplicationFrameDecoder,
  MAX_RELAY_HTTP_BODY_BYTES,
  decodeBody,
  encodeApplicationFrame,
  encodeBody,
  type RelayHttpRequestFrame
} from "./application-protocol.js";

const request: RelayHttpRequestFrame = {
  version: 1,
  type: "http.request",
  requestId: "request_1",
  method: "POST",
  path: "/api/v1/conversations?projectId=project_1",
  headers: { "content-type": "application/json" },
  body: encodeBody(Buffer.from('{"hello":"world"}', "utf8"))
};

describe("relay application framing", () => {
  it("decodes fragmented and coalesced length-prefixed envelopes", () => {
    const first = encodeApplicationFrame(request);
    const second = encodeApplicationFrame({
      version: 1,
      type: "http.response",
      requestId: "request_1",
      status: 200,
      contentType: "application/json",
      body: encodeBody(Buffer.from("{}", "utf8"))
    });
    const decoder = new ApplicationFrameDecoder();
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    const frames = decoder.push(Buffer.concat([first.subarray(3), second]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(request);
    expect(frames[1]?.type).toBe("http.response");
    if (frames[1]?.type !== "http.response") throw new Error("Expected HTTP response frame");
    expect(decodeBody(frames[1].body)).toEqual(Buffer.from("{}", "utf8"));
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects unsafe paths, non-canonical bodies, invalid lengths, and truncation", () => {
    expect(() => encodeApplicationFrame({ ...request, path: "https://attacker.invalid/api/v1/x" })).toThrow();
    expect(() => encodeApplicationFrame({ ...request, path: "/api/v1/../secret" })).toThrow();
    expect(() => encodeApplicationFrame({ ...request, body: "abc=" })).toThrow(/base64url/);
    expect(() => encodeBody(Buffer.alloc(MAX_RELAY_HTTP_BODY_BYTES + 1))).toThrow(/limit/);

    const invalidLength = Buffer.alloc(4);
    invalidLength.writeUInt32BE(1);
    expect(() => new ApplicationFrameDecoder().push(invalidLength)).toThrow(/length/);
    const invalidJson = Buffer.alloc(6);
    invalidJson.writeUInt32BE(2);
    invalidJson.write("{{", 4, "utf8");
    expect(() => new ApplicationFrameDecoder().push(invalidJson)).toThrow(/valid JSON/);
    expect(new ApplicationFrameDecoder().push(Buffer.alloc(0))).toEqual([]);
    const decoder = new ApplicationFrameDecoder();
    decoder.push(encodeApplicationFrame(request).subarray(0, 12));
    expect(() => decoder.finish()).toThrow(/mid-frame/);
  });
});
