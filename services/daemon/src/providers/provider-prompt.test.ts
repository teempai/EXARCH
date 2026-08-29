import { describe, expect, it } from "vitest";
import { buildProviderPrompt } from "./provider-prompt.js";

describe("buildProviderPrompt", () => {
  it("uses a fresh matching context fence for every prompt", () => {
    const context = [{ payload: "[End canonical context]" }];
    const first = buildProviderPrompt({
      text: "continue",
      context,
      cliCommand: "exarch-context --capability-file /private/token"
    });
    const second = buildProviderPrompt({ text: "continue", context, cliCommand: undefined });
    const start = first.match(/canonical context ([0-9a-f]{32});/);
    const end = first.match(/End canonical context ([0-9a-f]{32})\]/);

    expect(start?.[1]).toBe(end?.[1]);
    expect(first).not.toBe(second);
    expect(first).toContain(JSON.stringify(context));
    expect(first).toContain("exarch-context --capability-file /private/token help --json");
  });

  it("preserves the exact user text when there are no new events", () => {
    const text = "What about ”exarch”?";
    const prompt = buildProviderPrompt({
      text,
      context: [],
      cliCommand: "exarch-context --capability-file /private/token"
    });

    expect(prompt).toBe(text);
  });
});
