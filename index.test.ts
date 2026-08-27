import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { MAX_CONTEXT_WINDOW, createToggle, isTarget } from "./index.ts";

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
  assert.ok(!isTarget(model({ provider: "openai", id: "gpt-4o" })));
  assert.ok(
    !isTarget(model({ provider: "openrouter", id: "gpt-5.6-sol" })),
    "an OpenAI-compatible route is not direct OpenAI and has its own pricing",
  );
  assert.ok(!isTarget(undefined));
});

test("toggle raises then restores the built-in window, leaving others alone", () => {
  const toggle = createToggle();
  const sol = model({ provider: "openai", id: "gpt-5.6-sol" });
  const claude = model({
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    api: "anthropic-messages",
    contextWindow: 200_000,
  });

  toggle.apply(sol);
  assert.equal(sol.contextWindow, 272_000, "off by default");

  toggle.flip();
  toggle.apply(sol);
  toggle.apply(claude);
  assert.equal(sol.contextWindow, MAX_CONTEXT_WINDOW);
  assert.equal(claude.contextWindow, 200_000, "non-openai model untouched");

  toggle.flip();
  toggle.apply(sol);
  assert.equal(
    sol.contextWindow,
    272_000,
    "restores the real built-in, not a hardcoded default",
  );
});

test("a non-default built-in window survives a toggle cycle", () => {
  const toggle = createToggle();
  // A user who already set their own modelOverrides in models.json.
  const custom = model({
    provider: "openai",
    id: "gpt-5.6-luna",
    contextWindow: 400_000,
  });

  toggle.flip();
  toggle.apply(custom);
  assert.equal(custom.contextWindow, MAX_CONTEXT_WINDOW);

  toggle.flip();
  toggle.apply(custom);
  assert.equal(custom.contextWindow, 400_000);
});
