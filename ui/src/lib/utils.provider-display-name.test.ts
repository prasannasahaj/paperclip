import { describe, expect, it } from "vitest";
import { providerDisplayName } from "./utils";

describe("providerDisplayName", () => {
  it("names the local Ollama provider", () => {
    expect(providerDisplayName("ollama")).toBe("Ollama");
  });

  it("keeps hosted provider names", () => {
    expect(providerDisplayName("openai")).toBe("OpenAI");
    expect(providerDisplayName("openrouter")).toBe("OpenRouter");
  });
});
