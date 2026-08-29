import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.js";

interface Vector {
  name: string;
  value: unknown;
  encoded: string;
}

const vectors = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../tests/fixtures/canonical-json-vectors.json", import.meta.url)),
      "utf8"
    )
  ) as { vectors: Vector[] }
).vectors;

describe("canonicalJson conformance vectors", () => {
  // The Swift client verifies the same fixture. Signature payloads are only
  // interoperable while both encoders agree byte for byte, so these cases pick
  // the places the two standard libraries would otherwise diverge: key case,
  // digit runs, punctuation, slash escaping, and non-ASCII.
  it.each(vectors.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    expect(canonicalJson(vector.value)).toBe(vector.encoded);
  });

  it("refuses values it cannot encode deterministically", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ n: 1n })).toThrow(/bigint/);
  });
});
