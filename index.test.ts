import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import openaiLongContext, {
  MAX_CONTEXT_WINDOW,
  createLongContext,
  isTarget,
} from "./index.ts";

let previousAgentDir: string | undefined;
let testAgentDir: string;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  testAgentDir = mkdtempSync(join(tmpdir(), "pi-long-context-test-"));
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(testAgentDir, { recursive: true, force: true });
});

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
  assert.ok(
    isTarget(model({ provider: "openrouter", id: "gpt-6-astra" }), [
      "openrouter",
    ]),
  );
  assert.ok(
    !isTarget(model({ provider: "anthropic", id: "gpt-6-astra" }), [
      "openrouter",
    ]),
  );
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
  const commandHandlers = new Map<string, Handler>();
  const selections: string[] = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  let thinkingLevel = "high";
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
    registerCommand: (name: string, command: { handler: Handler }) => {
      commandHandlers.set(name, command.handler);
    },
    setModel: async (selected: Model<Api>) => {
      ctx.model = selected;
      // Pi reapplies the configured thinking default when setting a model.
      thinkingLevel = "medium";
      return true;
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level: string) => {
      thinkingLevel = level;
    },
  } as unknown as ExtensionAPI);

  const commandHandler = commandHandlers.get("long-context");
  assert.ok(commandHandler);
  return {
    commandHandler,
    commandHandlers,
    ctx,
    handlers,
    selections,
    notifications,
    sol,
    statuses,
    autocompleteFactories,
    getThinkingLevel: () => thinkingLevel,
  };
}

function statusHandler(harness: ReturnType<typeof extensionHarness>): Handler {
  const handler = harness.commandHandlers.get("long-context-status");
  assert.ok(handler);
  return handler;
}

test("status reports a supported model that is disabled", async () => {
  const harness = extensionHarness(undefined);
  await statusHandler(harness)("", harness.ctx);

  assert.deepEqual(JSON.parse(harness.notifications[0]), {
    type: "pi-openai-long-context.status",
    enabled: false,
    supported: true,
    provider: "openai",
    model: "gpt-5.6-sol",
    contextWindow: 272_000,
  });
  assert.match(harness.notifications[1], /Long context is disabled/);
});

test("status reports an enabled supported model", async () => {
  const harness = extensionHarness(undefined);
  await harness.commandHandler("", harness.ctx);
  harness.notifications.length = 0;

  await statusHandler(harness)("", harness.ctx);
  const payload = JSON.parse(harness.notifications[0]);
  assert.equal(payload.enabled, true);
  assert.equal(payload.supported, true);
  assert.equal(payload.contextWindow, MAX_CONTEXT_WINDOW);
});

test("status reports unsupported models as disabled", async () => {
  const harness = extensionHarness(undefined);
  harness.ctx.model = model({ provider: "anthropic", id: "claude-sonnet-4-5" });

  await statusHandler(harness)("request-1", harness.ctx);
  assert.deepEqual(JSON.parse(harness.notifications[0]), {
    type: "pi-openai-long-context.status",
    requestId: "request-1",
    enabled: false,
    supported: false,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    contextWindow: 272_000,
  });
});

test("status reports an already-large context window", async () => {
  const harness = extensionHarness(undefined);
  harness.ctx.model = model({
    provider: "openai",
    id: "gpt-5.6-sol",
    contextWindow: 2_000_000,
  });

  await statusHandler(harness)("request-2", harness.ctx);
  assert.equal(JSON.parse(harness.notifications[0]).contextWindow, 2_000_000);
});

test("both long-context commands are registered", () => {
  const harness = extensionHarness(undefined);
  assert.ok(harness.commandHandlers.has("long-context"));
  assert.ok(harness.commandHandlers.has("long-context-status"));
});

test("model switching clears enabled status", async () => {
  const harness = extensionHarness(undefined);
  await harness.commandHandler("", harness.ctx);
  harness.ctx.model = model({ provider: "openai", id: "gpt-5.6-terra" });
  await harness.handlers.get("model_select")?.({}, harness.ctx);

  await statusHandler(harness)("request-3", harness.ctx);
  assert.equal(JSON.parse(harness.notifications.at(-1)!).enabled, false);
  assert.equal(harness.sol.contextWindow, 272_000);
});

test("status propagates request IDs and does not mutate state", async () => {
  const harness = extensionHarness(undefined);
  const beforeWindow = harness.sol.contextWindow;
  const beforeStatusCount = harness.statuses.length;

  await statusHandler(harness)("integration-42", harness.ctx);

  assert.equal(JSON.parse(harness.notifications[0]).requestId, "integration-42");
  assert.equal(harness.sol.contextWindow, beforeWindow);
  assert.equal(harness.statuses.length, beforeStatusCount);
});

test("RPC status emits one stable JSON notification", async () => {
  const harness = extensionHarness(undefined, false);
  harness.ctx.mode = "rpc";

  await statusHandler(harness)("abc123", harness.ctx);

  assert.deepEqual(harness.notifications, [
    JSON.stringify({
      type: "pi-openai-long-context.status",
      requestId: "abc123",
      enabled: false,
      supported: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      contextWindow: 272_000,
    }),
  ]);
});

test("automatic child activation requires an explicit config opt-in", async (t) => {
  const previous = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  });
  const path = join(
    process.env.PI_CODING_AGENT_DIR!,
    "openai-long-context.json",
  );
  for (const contents of [
    undefined,
    "{}",
    '{"autoEnableSubagents":false}',
    '{"autoEnableSubagents":"true"}',
    '{"autoEnableSubagents":1}',
    '{"autoEnableSubagents":null}',
    "null",
    "[]",
    "true",
    "{invalid",
  ]) {
    if (contents !== undefined) writeFileSync(path, contents);
    const { ctx, handlers, commandHandler, sol } = extensionHarness(
      undefined,
      false,
    );
    ctx.mode = "print";
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(
      ctx.model.contextWindow,
      272_000,
      contents ?? "missing config",
    );
    assert.equal(ctx.model, sol, "disabled config must not reselect the model");
    await commandHandler("", ctx);
    assert.equal(
      ctx.model.contextWindow,
      1_050_000,
      "manual toggle remains available without opting in",
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  }

  rmSync(path);
  mkdirSync(path); // An unreadable config path must also leave activation off.
  const { ctx, handlers } = extensionHarness(undefined, false);
  ctx.mode = "print";
  await handlers.get("session_start")?.({}, ctx);
  assert.equal(ctx.model.contextWindow, 272_000);
});

test("additional providers require explicit configuration", async () => {
  writeFileSync(
    join(testAgentDir, "openai-long-context.json"),
    '{"additionalProviders":["openrouter"]}',
  );
  const { ctx, handlers, commandHandler, autocompleteFactories } =
    extensionHarness(undefined);
  ctx.model = model({ provider: "openrouter", id: "gpt-6-astra" });

  await handlers.get("session_start")?.({}, ctx);
  await commandHandler("", ctx);
  assert.equal(ctx.model.contextWindow, MAX_CONTEXT_WINDOW);

  const factory = autocompleteFactories[0];
  assert.ok(factory);
  const provider = factory({
    getSuggestions: async () => ({
      prefix: "/",
      items: [{ value: "long-context", label: "long-context" }],
    }),
    applyCompletion: (lines, cursorLine, cursorCol) => ({
      lines,
      cursorLine,
      cursorCol,
    }),
  });
  assert.deepEqual(
    await provider.getSuggestions(
      ["/"],
      0,
      1,
      { signal: new AbortController().signal },
    ),
    { prefix: "/", items: [{ value: "long-context", label: "long-context" }] },
  );
});

test("opted-in sessions in a marked runner automatically arm only supported models", async (t) => {
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "openai-long-context.json"),
    '{"autoEnableSubagents":true}',
  );
  const previous = process.env.PI_SUBAGENT_CHILD;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  });

  for (const marker of [undefined, "", "0", "true", "1"]) {
    if (marker === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = marker;

    for (const [provider, id, supported] of [
      ["openai", "gpt-5.6-sol", true],
      ["openai-codex", "gpt-6-astra", true],
      ["openai", "gpt-5.5", false],
      ["openrouter", "gpt-6-astra", false],
    ] as const) {
      const {
        ctx,
        handlers,
        selections,
        autocompleteFactories,
        getThinkingLevel,
      } = extensionHarness(undefined, false);
      ctx.mode = "print";
      const original = model({ provider, id, contextWindow: 400_000 });
      ctx.model = original;
      await handlers.get("session_start")?.({ reason: "startup" }, ctx);

      const enabled = marker === "1" && supported;
      assert.equal(
        ctx.model.contextWindow,
        enabled ? 1_050_000 : 400_000,
        `${marker}: ${provider}/${id}`,
      );
      assert.equal(
        original.contextWindow,
        400_000,
        "do not mutate the model registry shared by children",
      );
      assert.equal(
        getThinkingLevel(),
        "high",
        "preserve the child's requested thinking level",
      );
      assert.deepEqual(selections, []);
      assert.deepEqual(autocompleteFactories, []);
      await handlers.get("session_shutdown")?.({}, ctx);
      assert.equal(ctx.model.contextWindow, 400_000);
    }
  }
});

test("runner child sessions retain independent windows and the usual reset behavior", async (t) => {
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "openai-long-context.json"),
    '{"autoEnableSubagents":true}',
  );
  const previous = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  });
  const first = extensionHarness(undefined, false);
  const second = extensionHarness(undefined, false);
  first.ctx.mode = second.ctx.mode = "print";
  second.ctx.model = first.ctx.model;
  await first.handlers.get("session_start")?.({}, first.ctx);
  await second.handlers.get("session_start")?.({}, second.ctx);
  await first.handlers.get("session_start")?.({}, first.ctx);
  await first.handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    first.ctx,
  );
  assert.equal(first.ctx.model.contextWindow, 1_050_000);
  await first.commandHandler("", first.ctx);
  await first.handlers.get("before_agent_start")?.({}, first.ctx);
  assert.equal(
    first.ctx.model.contextWindow,
    272_000,
    "turning it off is not undone next turn",
  );
  assert.equal(
    second.ctx.model.contextWindow,
    1_050_000,
    "one child's reset must not reset another",
  );
  await second.handlers.get("model_select")?.({}, second.ctx);
  assert.equal(second.ctx.model.contextWindow, 272_000);
});

test("nested foreground sessions with an explicit extension inherit the runner opt-in", async (t) => {
  const previous = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  });
  writeFileSync(
    join(testAgentDir, "openai-long-context.json"),
    '{"autoEnableSubagents":true}',
  );
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("openai", "isolated-test-key");
  const sharedModel = modelRuntime.getModel("openai", "gpt-5.6-sol");
  assert.ok(sharedModel);
  initTheme("dark");

  async function createChildSession() {
    const settingsManager = SettingsManager.inMemory({
      defaultThinkingLevel: "minimal",
    });
    // pi-subagents host: "parent": same process, no ambient extensions, explicit paths still load.
    const resourceLoader = new DefaultResourceLoader({
      cwd: testAgentDir,
      agentDir: testAgentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("./index.ts", import.meta.url)),
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: testAgentDir,
      agentDir: testAgentDir,
      model: sharedModel,
      thinkingLevel: "high",
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(testAgentDir),
      tools: [],
    });
    t.after(async () => {
      try {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        session.dispose();
      }
    });
    const errors: unknown[] = [];
    await session.bindExtensions({
      mode: "print",
      onError: (error) => { errors.push(error); },
    });
    assert.deepEqual(errors, []);
    return session;
  }

  const parent = await createChildSession();
  const nested = await createChildSession();
  for (const session of [parent, nested]) {
    assert.equal(session.model?.contextWindow, 1_050_000);
    assert.equal(session.model?.provider, "openai");
    assert.equal(session.model?.id, "gpt-5.6-sol");
    assert.equal(session.thinkingLevel, "high");
  }
  assert.equal(sharedModel.contextWindow, 272_000);
  assert.notEqual(parent.model, nested.model);
  await nested.prompt("/long-context");
  assert.equal(nested.model?.contextWindow, 272_000);
  assert.equal(parent.model?.contextWindow, 1_050_000);
});

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
