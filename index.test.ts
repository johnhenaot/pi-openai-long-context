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
let previousChildMarker: string | undefined;
let testAgentDir: string;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousChildMarker = process.env.PI_SUBAGENT_CHILD;
  testAgentDir = mkdtempSync(join(tmpdir(), "pi-long-context-test-"));
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
  delete process.env.PI_SUBAGENT_CHILD;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousChildMarker === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = previousChildMarker;
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
});

test("enabling raises the window, resetting restores the real built-in", () => {
  const longContext = createLongContext();
  const alreadyRaisedInUserModelsJson = model({
    provider: "openai",
    id: "gpt-5.6-sol",
    contextWindow: 400_000,
  });

  assert.ok(longContext.enable(alreadyRaisedInUserModelsJson));
  assert.equal(
    alreadyRaisedInUserModelsJson.contextWindow,
    MAX_CONTEXT_WINDOW,
  );
  assert.equal(longContext.armedModel, alreadyRaisedInUserModelsJson);

  assert.ok(longContext.reset());
  assert.equal(alreadyRaisedInUserModelsJson.contextWindow, 400_000);
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

const THINKING_LEVEL_PI_APPLIES_ON_MODEL_CHANGE = "medium";

const REQUESTED_THINKING_LEVEL = "high";

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
  let thinkingLevel = REQUESTED_THINKING_LEVEL;
  const registryModel = model({ provider: "openai", id: "gpt-5.6-sol" });
  const ctx = {
    model: registryModel,
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

  const emitModelSelectEvenThoughPiSkipsItForSameIdModels = async (
    selected: Model<Api>,
  ): Promise<void> => {
    await handlers.get("model_select")?.({ model: selected }, ctx);
  };

  openaiLongContext({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (_name: string, command: { handler: Handler }) => {
      commandHandler = command.handler;
    },
    setModel: async (selected: Model<Api>) => {
      ctx.model = selected;
      thinkingLevel = THINKING_LEVEL_PI_APPLIES_ON_MODEL_CHANGE;
      await emitModelSelectEvenThoughPiSkipsItForSameIdModels(selected);
      return true;
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level: string) => {
      thinkingLevel = level;
    },
  } as unknown as ExtensionAPI);

  assert.ok(commandHandler);
  return {
    commandHandler,
    ctx,
    handlers,
    selections,
    notifications,
    registryModel,
    statuses,
    autocompleteFactories,
    getThinkingLevel: () => thinkingLevel,
  };
}

test("automatic child activation requires an explicit config opt-in", async () => {
  process.env.PI_SUBAGENT_CHILD = "1";
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
    const { ctx, handlers, commandHandler, registryModel } = extensionHarness(
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
    assert.equal(ctx.model, registryModel, "disabled config must not reselect the model");
    await commandHandler("", ctx);
    assert.equal(
      ctx.model.contextWindow,
      1_050_000,
      "manual toggle remains available without opting in",
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  }

  rmSync(path);
  mkdirSync(path);
  const { ctx, handlers } = extensionHarness(undefined, false);
  ctx.mode = "print";
  await handlers.get("session_start")?.({}, ctx);
  assert.equal(ctx.model.contextWindow, 272_000);
});

test("opted-in sessions in a marked runner automatically arm only supported models", async () => {
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "openai-long-context.json"),
    '{"autoEnableSubagents":true}',
  );

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
        REQUESTED_THINKING_LEVEL,
        "preserve the child's requested thinking level",
      );
      assert.deepEqual(selections, []);
      assert.deepEqual(autocompleteFactories, []);
      await handlers.get("session_shutdown")?.({}, ctx);
      assert.equal(ctx.model.contextWindow, 400_000);
    }
  }
});

test("runner child sessions retain independent windows and the usual reset behavior", async () => {
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "openai-long-context.json"),
    '{"autoEnableSubagents":true}',
  );
  process.env.PI_SUBAGENT_CHILD = "1";
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
  const armed = second.ctx.model;
  second.ctx.model = model({
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    contextWindow: 200_000,
  });
  await second.handlers.get("model_select")?.({}, second.ctx);
  assert.equal(armed.contextWindow, 272_000);
});

test("default activation requires its own explicit config opt-in", async () => {
  const path = join(testAgentDir, "openai-long-context.json");

  for (const contents of [
    undefined,
    "{}",
    '{"autoEnable":false}',
    '{"autoEnable":"true"}',
    '{"autoEnable":1}',
    '{"autoEnableSubagents":true}',
    "true",
    "{invalid",
  ]) {
    if (contents !== undefined) writeFileSync(path, contents);
    const { ctx, handlers, registryModel } = extensionHarness(undefined);
    const label = contents ?? "missing config";
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(ctx.model, registryModel, label);
    assert.equal(registryModel.contextWindow, 272_000, label);
    await handlers.get("model_select")?.({}, ctx);
    assert.equal(ctx.model, registryModel, label);
    assert.equal(registryModel.contextWindow, 272_000, label);
    await handlers.get("session_shutdown")?.({}, ctx);
  }
});

test("opting in by default arms at startup and follows model switches", async () => {
  writeFileSync(
    join(testAgentDir, "openai-long-context.json"),
    '{"autoEnable":true}',
  );
  const { commandHandler, ctx, handlers, registryModel, statuses } =
    extensionHarness(undefined);

  await handlers.get("session_start")?.({}, ctx);
  assert.equal(ctx.model.contextWindow, MAX_CONTEXT_WINDOW);
  assert.notEqual(ctx.model, registryModel, "arm a private copy, not the registry");
  assert.equal(registryModel.contextWindow, 272_000);
  assert.equal(statuses.at(-1), "⚠");
  const armedSol = ctx.model;

  const claude = model({
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    contextWindow: 200_000,
  });
  ctx.model = claude;
  await handlers.get("model_select")?.({}, ctx);
  assert.equal(armedSol.contextWindow, 272_000);
  assert.equal(claude.contextWindow, 200_000, "unsupported models stay put");
  assert.equal(ctx.model, claude);
  assert.equal(statuses.at(-1), undefined);

  ctx.model = registryModel;
  await handlers.get("model_select")?.({}, ctx);
  assert.equal(
    ctx.model.contextWindow,
    MAX_CONTEXT_WINDOW,
    "switching back to a supported model re-arms",
  );
  assert.equal(registryModel.contextWindow, 272_000);

  const terra = model({ provider: "openai", id: "gpt-5.6-terra" });
  const armedAgain = ctx.model;
  ctx.model = terra;
  await handlers.get("model_select")?.({}, ctx);
  assert.equal(armedAgain.contextWindow, 272_000, "release the old copy");
  assert.equal(ctx.model.contextWindow, MAX_CONTEXT_WINDOW);
  assert.notEqual(ctx.model, terra, "a fresh copy per supported model");
  assert.equal(terra.contextWindow, 272_000);

  await commandHandler("", ctx);
  assert.equal(
    ctx.model.contextWindow,
    272_000,
    "the manual toggle still wins",
  );

  await handlers.get("session_shutdown")?.({}, ctx);
  assert.equal(ctx.model.contextWindow, 272_000);
});

test("re-selecting the current model re-arms instead of orphaning the copy", async () => {
  writeFileSync(
    join(testAgentDir, "openai-long-context.json"),
    '{"autoEnable":true}',
  );
  const { commandHandler, ctx, handlers, registryModel, statuses } =
    extensionHarness(undefined);

  await handlers.get("session_start")?.({}, ctx);
  const orphaned = ctx.model;
  assert.equal(orphaned.contextWindow, MAX_CONTEXT_WINDOW);

  ctx.model = registryModel;
  await handlers.get("input")?.({ streamingBehavior: "steer" }, ctx);
  assert.equal(
    orphaned.contextWindow,
    MAX_CONTEXT_WINDOW,
    "mid-stream input leaves the running turn alone",
  );
  assert.equal(ctx.model, registryModel);

  await handlers.get("input")?.({}, ctx);

  assert.equal(orphaned.contextWindow, 272_000, "release the orphaned copy");
  assert.equal(ctx.model.contextWindow, MAX_CONTEXT_WINDOW);
  assert.notEqual(ctx.model, registryModel);
  assert.equal(registryModel.contextWindow, 272_000);
  assert.equal(statuses.at(-1), "⚠");

  await commandHandler("", ctx);
  await handlers.get("input")?.({}, ctx);
  await handlers.get("before_agent_start")?.({}, ctx);
  assert.equal(
    ctx.model.contextWindow,
    272_000,
    "turning it off by hand survives the next turn",
  );
  assert.equal(statuses.at(-1), undefined);

  const healed = ctx.model;
  await handlers.get("model_select")?.({}, ctx);
  assert.equal(ctx.model.contextWindow, MAX_CONTEXT_WINDOW);
  ctx.model = healed;
  await handlers.get("before_agent_start")?.({}, ctx);
  assert.equal(
    ctx.model.contextWindow,
    MAX_CONTEXT_WINDOW,
    "before_agent_start repairs turns that do not come from input",
  );
  assert.notEqual(ctx.model, healed);
});

test("an automatic compaction repairs a detached copy and is cancelled", async () => {
  writeFileSync(
    join(testAgentDir, "openai-long-context.json"),
    '{"autoEnable":true}',
  );
  const { ctx, handlers, registryModel, statuses } =
    extensionHarness(undefined);

  await handlers.get("session_start")?.({}, ctx);
  const detached = ctx.model;
  ctx.model = registryModel;

  const manual = await handlers.get("session_before_compact")?.(
    { reason: "manual" },
    ctx,
  );
  assert.equal(manual, undefined, "manual compaction is never intercepted");
  assert.equal(ctx.model, registryModel);

  const automatic = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.deepEqual(automatic, { cancel: true });
  assert.equal(detached.contextWindow, 272_000);
  assert.equal(ctx.model.contextWindow, MAX_CONTEXT_WINDOW);
  assert.equal(registryModel.contextWindow, 272_000);
  assert.equal(statuses.at(-1), "⚠");
});

test("the two opt-ins are independent: each covers only its own sessions", async () => {
  const path = join(testAgentDir, "openai-long-context.json");

  for (const [contents, mainArmed, childArmed] of [
    ['{"autoEnable":true}', true, false],
    ['{"autoEnableSubagents":true}', false, true],
    ['{"autoEnable":true,"autoEnableSubagents":true}', true, true],
  ] as const) {
    writeFileSync(path, contents);
    for (const [child, armed] of [
      [false, mainArmed],
      [true, childArmed],
    ] as const) {
      if (child) process.env.PI_SUBAGENT_CHILD = "1";
      else delete process.env.PI_SUBAGENT_CHILD;

      const { ctx, handlers, registryModel, getThinkingLevel } = extensionHarness(
        undefined,
        false,
      );
      ctx.mode = "print";
      await handlers.get("session_start")?.({}, ctx);

      const label = `${contents} in a ${child ? "child" : "main"} session`;
      assert.equal(
        ctx.model.contextWindow,
        armed ? MAX_CONTEXT_WINDOW : 272_000,
        label,
      );
      assert.equal(ctx.model !== registryModel, armed, label);
      assert.equal(registryModel.contextWindow, 272_000, label);
      assert.equal(getThinkingLevel(), "high", label);
      await handlers.get("session_shutdown")?.({}, ctx);
    }
  }
});

test("nested foreground sessions with an explicit extension inherit the runner opt-in", async (t) => {
  process.env.PI_SUBAGENT_CHILD = "1";
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

  function loadThisExtensionTheWayASubagentHostDoes(
    settingsManager: SettingsManager,
  ) {
    return new DefaultResourceLoader({
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
  }

  async function createChildSession() {
    const settingsManager = SettingsManager.inMemory({
      defaultThinkingLevel: "minimal",
    });
    const resourceLoader =
      loadThisExtensionTheWayASubagentHostDoes(settingsManager);
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
      onError: (error) => {
        errors.push(error);
      },
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
    const raised = ctx.model;
    assert.equal(raised.contextWindow, 1_050_000);
    assert.equal(statuses.at(-1), "⚠");
    if (event) await handlers.get(event)?.({}, ctx);
    else await commandHandler("", ctx);
    assert.equal(raised.contextWindow, 400_000);
    assert.equal(astra.contextWindow, 400_000);
    assert.equal(statuses.at(-1), undefined);
  }
});

test("the manual toggle raises a private copy, never the model other sessions share", async () => {
  const { commandHandler, ctx, registryModel } = extensionHarness(undefined);

  await commandHandler("", ctx);
  const raised = ctx.model;
  assert.notEqual(raised, registryModel);
  assert.equal(raised.contextWindow, MAX_CONTEXT_WINDOW);
  assert.equal(registryModel.contextWindow, 272_000);

  await commandHandler("", ctx);
  assert.equal(raised.contextWindow, 272_000);
  assert.equal(registryModel.contextWindow, 272_000);
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
  const { commandHandler, ctx, handlers, registryModel, statuses } =
    extensionHarness("Keep long context");

  await commandHandler("", ctx);
  await commandHandler("", ctx);
  assert.equal(ctx.model.contextWindow, 272_000);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.deepEqual(result, { cancel: true });
  assert.equal(ctx.model.contextWindow, MAX_CONTEXT_WINDOW);
  assert.equal(registryModel.contextWindow, 272_000);
  assert.equal(statuses.at(-1), "⚠");
});

test("compacting after the warning leaves long context off", async () => {
  const { commandHandler, ctx, handlers, registryModel } =
    extensionHarness("Compact now");

  await commandHandler("", ctx);
  await commandHandler("", ctx);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "overflow" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(ctx.model.contextWindow, 272_000);
  assert.equal(registryModel.contextWindow, 272_000);
});

test("headless mode proceeds with compaction instead of re-enabling long context", async () => {
  const { commandHandler, ctx, handlers, selections } = extensionHarness(
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
  assert.equal(ctx.model.contextWindow, 272_000);
  assert.deepEqual(selections, []);
});

test("dismissing the warning proceeds with compaction", async () => {
  const { commandHandler, ctx, handlers, selections } =
    extensionHarness(undefined);

  await commandHandler("", ctx);
  await commandHandler("", ctx);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(ctx.model.contextWindow, 272_000);
  assert.equal(selections.length, 1);
});

test("later compactions proceed normally when the next turn starts safely", async () => {
  const { commandHandler, ctx, handlers } =
    extensionHarness("Keep long context");

  await commandHandler("", ctx);
  await commandHandler("", ctx);
  await handlers.get("before_agent_start")?.({}, ctx);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(ctx.model.contextWindow, 272_000);
});

test("re-enabling long context clears the pending compaction warning", async () => {
  const { commandHandler, ctx, handlers, selections } =
    extensionHarness("Keep long context");

  await commandHandler("", ctx);
  await commandHandler("", ctx);
  await commandHandler("", ctx);
  assert.equal(ctx.model.contextWindow, MAX_CONTEXT_WINDOW);

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.deepEqual(selections, []);
});

test("switching models clears the pending compaction warning", async () => {
  const { commandHandler, ctx, handlers, registryModel } =
    extensionHarness("Keep long context");

  await commandHandler("", ctx);
  await commandHandler("", ctx);
  ctx.model = model({ provider: "anthropic", id: "claude-sonnet-4-5" });
  await handlers.get("model_select")?.({}, ctx);
  ctx.model = registryModel;

  const result = await handlers.get("session_before_compact")?.(
    { reason: "threshold" },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(registryModel.contextWindow, 272_000);
});
