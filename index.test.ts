import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { MAX_CONTEXT_WINDOW, createLongContext, isTarget } from "./index.ts";

function model(
  overrides: Partial<Model<Api>> & Pick<Model<Api>, "id" | "provider">,
): Model<Api> {
  return {
    name: overrides.id,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    ...overrides,
  };
}

test("only openai gpt-5.6 models are targeted", () => {
  assert.ok(isTarget(model({ provider: "openai", id: "gpt-5.6-sol" })));
  assert.ok(isTarget(model({ provider: "openai", id: "gpt-5.6-terra" })));
  assert.ok(!isTarget(model({ provider: "openai", id: "gpt-5.5" })));
  assert.ok(
    !isTarget(model({ provider: "openrouter", id: "gpt-5.6-sol" })),
    "an OpenAI-compatible route is not direct OpenAI and has its own pricing",
  );
  assert.ok(!isTarget(undefined));
});

test("enabling raises the window, resetting restores the real built-in", () => {
  const longContext = createLongContext();
  // A user who already raised this model in their own models.json.
  const sol = model({
    provider: "openai",
    id: "gpt-5.6-sol",
    contextWindow: 400_000,
  });

  assert.ok(longContext.enable(sol));
  assert.equal(sol.contextWindow, MAX_CONTEXT_WINDOW);
  assert.equal(longContext.armedModel, sol);

  assert.ok(longContext.reset());
  assert.equal(sol.contextWindow, 400_000);
  assert.equal(longContext.armedModel, undefined);
  assert.ok(!longContext.reset(), "resetting twice is a no-op");
});

test("non-GPT-5.6 models are refused and left untouched", () => {
  const longContext = createLongContext();
  const claude = model({
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    api: "anthropic-messages",
    contextWindow: 200_000,
  });

  assert.ok(!longContext.enable(claude));
  assert.ok(!longContext.enable(undefined));
  assert.equal(claude.contextWindow, 200_000);
  assert.equal(longContext.armedModel, undefined);
});

test("only one model is armed at a time", () => {
  const longContext = createLongContext();
  const sol = model({ provider: "openai", id: "gpt-5.6-sol" });
  const terra = model({ provider: "openai", id: "gpt-5.6-terra" });

  assert.ok(longContext.enable(sol));
  assert.ok(
    !longContext.enable(terra),
    "a model switch resets first, so arming twice cannot happen",
  );
  assert.equal(terra.contextWindow, 272_000);
});
