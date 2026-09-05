import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import openaiLongContext, {
  MAX_CONTEXT_WINDOW,
  createLongContext,
  isTarget,
} from "./index.ts";

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

test("only GPT-5.6 and GPT-6 models on capped providers are targeted", () => {
  assert.ok(isTarget(model({ provider: "openai", id: "gpt-5.6-sol" })));
  assert.ok(isTarget(model({ provider: "openai", id: "gpt-5.6-terra" })));
  assert.ok(isTarget(model({ provider: "openai-codex", id: "gpt-5.6-sol" })));
  for (const provider of ["openai", "openai-codex"]) {
    for (const id of ["gpt-6-astra", "gpt-6-future-variant"]) {
      assert.ok(isTarget(model({ provider, id })), `${provider}/${id}`);
    }
    for (const id of ["gpt-5.5", "gpt-6", "gpt-60-astra", "gpt-6.1-astra"]) {
      assert.ok(!isTarget(model({ provider, id })), `${provider}/${id}`);
    }
  }
  assert.ok(!isTarget(model({ provider: "openrouter", id: "gpt-6-astra" })));
  assert.ok(
    !isTarget(model({ provider: "openrouter", id: "gpt-5.6-sol" })),
    "routes other than openai and openai-codex already ship 1.05M",
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

test("enabling never reduces an existing context window", () => {
  for (const contextWindow of [1_050_000, 2_000_000, 4_000_000]) {
    const longContext = createLongContext();
    const astra = model({
      provider: "openai-codex",
      id: "gpt-6-astra",
      contextWindow,
    });

    assert.ok(longContext.enable(astra));
    assert.equal(astra.contextWindow, contextWindow);
    assert.ok(longContext.reset());
    assert.equal(astra.contextWindow, contextWindow);
    assert.equal(longContext.armedModel, undefined);
  }
});

test("unsupported models are refused and left untouched", () => {
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

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type AutocompleteFactory = Parameters<
  ExtensionUIContext["addAutocompleteProvider"]
>[0];

function extensionHarness(choice: string | undefined, hasUI = true) {
  const handlers = new Map<string, Handler>();
  const autocompleteFactories: AutocompleteFactory[] = [];
  let commandHandler: Handler | undefined;
  const selections: string[] = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const sol = model({ provider: "openai", id: "gpt-5.6-sol" });
  const ctx = {
    model: sol,
    mode: "tui",
    hasUI,
    ui: {
      addAutocompleteProvider: (factory: AutocompleteFactory) => {
        autocompleteFactories.push(factory);
      },
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_name: string, value: string | undefined) =>
        statuses.push(value),
      notify: (message: string) => notifications.push(message),
      select: async (title: string) => {
        selections.push(title);
        return choice;
      },
    },
  };

  openaiLongContext({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (_name: string, command: { handler: Handler }) => {
      commandHandler = command.handler;
    },
  } as unknown as ExtensionAPI);

  assert.ok(commandHandler);
  return {
    commandHandler,
    ctx,
    handlers,
    selections,
    notifications,
    sol,
    statuses,
    autocompleteFactories,
  };
}

test("the menu shows long context for GPT-6 and hides it for unsupported models", async () => {
  const { ctx, handlers, autocompleteFactories } = extensionHarness(undefined);
  ctx.model = model({ provider: "openai-codex", id: "gpt-6-astra" });
  await handlers.get("session_start")?.({}, ctx);
  const factory = autocompleteFactories[0];
  assert.ok(factory);

  const items = [
    { value: "long-context", label: "long-context" },
    { value: "other", label: "other" },
  ];
  const provider = factory({
    getSuggestions: async () => ({ prefix: "/", items }),
    applyCompletion: (lines, cursorLine, cursorCol) => ({
      lines,
      cursorLine,
      cursorCol,
    }),
  });
  const options = { signal: new AbortController().signal };
  assert.deepEqual(await provider.getSuggestions(["/"], 0, 1, options), {
    prefix: "/",
    items,
  });

  ctx.model = model({ provider: "openrouter", id: "gpt-6-astra" });
  assert.deepEqual(await provider.getSuggestions(["/"], 0, 1, options), {
    prefix: "/",
    items: [items[1]],
  });

  const onlyLongContext = factory({
    ...provider,
    getSuggestions: async () => ({ prefix: "/", items: items.slice(0, 1) }),
  });
  assert.equal(
    await onlyLongContext.getSuggestions(["/"], 0, 1, options),
    null,
    "filtering out the only command must suppress the menu",
  );

  ctx.model = model({ provider: "openai", id: "gpt-6-future-variant" });
  assert.deepEqual(await provider.getSuggestions(["/"], 0, 1, options), {
    prefix: "/",
    items,
  });
});

test("GPT-6 toggles to 1.05M and restores its previous window on toggle, switch, and shutdown", async () => {
  const { commandHandler, ctx, handlers, statuses } =
    extensionHarness(undefined);
  const astra = model({
    provider: "openai-codex",
    id: "gpt-6-astra",
    contextWindow: 400_000,
  });
  ctx.model = astra;

  for (const event of [undefined, "model_select", "session_shutdown"]) {
    await commandHandler("", ctx);
    assert.equal(astra.contextWindow, 1_050_000);
    assert.equal(statuses.at(-1), "⚠");
    if (event) await handlers.get(event)?.({}, ctx);
    else await commandHandler("", ctx);
    assert.equal(astra.contextWindow, 400_000);
    assert.equal(statuses.at(-1), undefined);
  }
});

test("the activation notification reports the preserved larger window", async () => {
  const { commandHandler, ctx, notifications } = extensionHarness(undefined);
  ctx.model = model({
    provider: "openai-codex",
    id: "gpt-6-astra",
    contextWindow: 4_000_000,
  });

  await commandHandler("", ctx);
  assert.match(notifications.at(-1) ?? "", /4,000,000 tokens/);
});

test("keeping long context cancels compaction caused by turning it off", async () => {
  const { commandHandler, ctx, handlers, sol, statuses } =
    extensionHarness("Keep long context");

  await commandHandler("", ctx);
  await commandHandler("", ctx);
  assert.equal(sol.contextWindow, 272_000);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.deepEqual(result, { cancel: true });
  assert.equal(sol.contextWindow, MAX_CONTEXT_WINDOW);
  assert.equal(statuses.at(-1), "⚠");
});

test("compacting after the warning leaves long context off", async () => {
  const { commandHandler, ctx, handlers, sol } =
    extensionHarness("Compact now");

  await commandHandler("", ctx);
  await commandHandler("", ctx);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "overflow" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(sol.contextWindow, 272_000);
});

test("headless mode proceeds with compaction instead of re-enabling long context", async () => {
  const { commandHandler, ctx, handlers, selections, sol } = extensionHarness(
    "Keep long context",
    false,
  );

  await commandHandler("", ctx);
  await commandHandler("", ctx);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(sol.contextWindow, 272_000);
  assert.deepEqual(selections, []);
});

test("dismissing the warning proceeds with compaction", async () => {
  const { commandHandler, ctx, handlers, selections, sol } =
    extensionHarness(undefined);

  await commandHandler("", ctx);
  await commandHandler("", ctx);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(sol.contextWindow, 272_000);
  assert.equal(selections.length, 1);
});

test("later compactions proceed normally when the next turn starts safely", async () => {
  const { commandHandler, ctx, handlers, sol } =
    extensionHarness("Keep long context");

  await commandHandler("", ctx);
  await commandHandler("", ctx);
  await handlers.get("before_agent_start")?.({}, ctx);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(sol.contextWindow, 272_000);
});

test("re-enabling long context clears the pending compaction warning", async () => {
  const { commandHandler, ctx, handlers, selections, sol } =
    extensionHarness("Keep long context");

  await commandHandler("", ctx);
  await commandHandler("", ctx);
  await commandHandler("", ctx);
  assert.equal(sol.contextWindow, MAX_CONTEXT_WINDOW);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.deepEqual(selections, []);
});

test("switching models clears the pending compaction warning", async () => {
  const { commandHandler, ctx, handlers, sol } =
    extensionHarness("Keep long context");

  await commandHandler("", ctx);
  await commandHandler("", ctx);
  ctx.model = model({ provider: "anthropic", id: "claude-sonnet-4-5" });
  await handlers.get("model_select")?.({}, ctx);
  ctx.model = sol;

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(sol.contextWindow, 272_000);
});
