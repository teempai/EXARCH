import { describe, expect, it } from "vitest";
import { redactPayload, redactText } from "./redaction.js";

describe("redactPayload", () => {
  it("redacts sensitive keys and known secret shapes recursively", () => {
    const result = redactPayload({
      command: "curl -H 'Authorization: Bearer abc.def.ghi'",
      nested: { apiKey: "sk-abcdefghijklmnop", safe: "visible" },
      list: ["github_pat_abcdefghijklmnopqrstuvwxyz"]
    });

    expect(result.redacted).toBe(true);
    expect(result.value).toEqual({
      command: "curl -H 'Authorization: [REDACTED:BEARER_CREDENTIAL]'",
      nested: { apiKey: "[REDACTED:APIKEY]", safe: "visible" },
      list: ["[REDACTED:GITHUB_TOKEN]"]
    });
    expect(result.markers).toContain("key:apikey");
  });

  it("does not change ordinary data", () => {
    const input = { text: "tests passed", values: [1, true, null] };
    expect(redactPayload(input)).toEqual({ value: input, redacted: false, markers: [] });
  });

  it("redacts the cloud and service credential shapes a repository patch can carry", () => {
    const stripeKey = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");
    const cases: Array<[string, string]> = [
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key-id"],
      ["ASIAY34FZKBOKMUTVV7A", "aws-access-key-id"],
      ["AIzaSyD-abcdefghijklmnopqrstuvwxyz01234", "google-api-key"],
      ["xoxb-123456789012-abcdefghijkl", "slack-token"],
      [stripeKey, "stripe-key"],
      ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm-token"],
      ["ghp_abcdefghijklmnopqrstuvwxyz01234567", "github-token"],
      ["gho_abcdefghijklmnopqrstuvwxyz01234567", "github-token"],
      ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "openai-style-key"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk", "jwt"]
    ];
    for (const [secret, expectedMarker] of cases) {
      const result = redactText(`value is ${secret} here`);
      expect(result.value, secret).not.toContain(secret);
      expect(result.markers, secret).toContain(`pattern:${expectedMarker}`);
    }
  });

  it("removes a whole private-key block rather than a line of it", () => {
    const key = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB",
      "AAAAMwAAAAtzc2gtZWQyNTUxOQAAACBw0mHhU0N0YnAqYzEyMzQ1",
      "-----END OPENSSH PRIVATE KEY-----"
    ].join("\n");
    const result = redactText(`before\n${key}\nafter`);
    expect(result.value).toBe("before\n[REDACTED:PRIVATE_KEY_BLOCK]\nafter");
    expect(result.markers).toEqual(["pattern:private-key-block"]);
  });

  it("keeps the name that leaked when redacting an assignment or a URL", () => {
    const assigned = redactText('DATABASE_PASSWORD="s3cret-value-here"');
    expect(assigned.value).toBe('DATABASE_PASSWORD="[REDACTED:ASSIGNED_CREDENTIAL]"');

    const url = redactText("postgres://appuser:hunter2hunter2@db.internal:5432/app");
    expect(url.value).toBe("postgres://appuser:[REDACTED:URL_CREDENTIAL]@db.internal:5432/app");
    expect(url.markers).toContain("pattern:url-credential");
  });

  it("redacts every secret in a multi-line .env style dump", () => {
    const stripeKey = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");
    const dump = [
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      `STRIPE_KEY=${stripeKey}`,
      "HARMLESS=just-a-value"
    ].join("\n");
    const result = redactText(dump);
    expect(result.value).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.value).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(result.value).not.toContain(stripeKey);
    expect(result.value).toContain("HARMLESS=just-a-value");
  });

  it("leaves ordinary prose, paths, and hashes alone", () => {
    const benign = [
      "Refactored the authentication flow in src/auth/session.ts",
      "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "https://github.com/example/repo/pull/12",
      "Bearer is a word that appears in prose about tokens."
    ].join("\n");
    const result = redactText(benign);
    expect(result.value).toContain("src/auth/session.ts");
    expect(result.value).toContain("https://github.com/example/repo/pull/12");
    expect(result.value).toContain("sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });
});

describe("redaction cost", () => {
  /**
   * The PEM pattern used to pair a lazy `[\s\S]*?` with a required END
   * terminator, so every unterminated BEGIN marker scanned to the end of the
   * input. A megabyte of markers took seven seconds, on the only thread the
   * daemon has. Provider output is admitted up to four megabytes.
   */
  it("stays linear on unterminated private-key markers", () => {
    const markers = "-----BEGIN PRIVATE KEY-----\n".repeat(40_000);
    expect(markers.length).toBeGreaterThan(1024 * 1024);

    const startedAt = process.hrtime.bigint();
    const result = redactText(markers);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    // Nothing here is a key, so nothing should be redacted.
    expect(result.redacted).toBe(false);
    // The old pattern needed about seven seconds for this input. The bound is
    // deliberately loose: it is asserting the absence of a quadratic, not a
    // throughput target that a slower machine would fail.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("still redacts a complete key block", () => {
    const key = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAx3Kj8vQ2mN4pLtRfYbWcE1uHgZa7OdVxSnKpTiUyBmLrQwXe",
      "9AfCdGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyzAB",
      "-----END RSA PRIVATE KEY-----"
    ].join("\n");
    const result = redactText(`before\n${key}\nafter`);
    expect(result.value).toBe("before\n[REDACTED:PRIVATE_KEY_BLOCK]\nafter");
    expect(result.markers).toContain("pattern:private-key-block");
  });
});
