import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MAX_CONTEXT_WINDOW = 1_050_000;

export const COMMAND_NAME = "long-context";

const KEEP_LONG_CONTEXT = "Keep long context";

// Snapshot reported by https://github.com/earendil-works/pi/pull/11173.
// Keep Codex limits model-specific: this is not an API or future-model guarantee.
const CODEX_CONTEXT_WINDOWS = new Map([
  ["gpt-5.6-sol", 872_000],
  ["gpt-5.6-terra", 872_000],
  ["gpt-5.6-luna", 872_000],
  ["gpt-6-sol", 872_000],
  ["gpt-6-luna", 872_000],
  ["gpt-6-astra", 872_000],
  ["gpt-6.1-sol", 872_000],
]);

export function contextWindowFor(
  model: Model<Api>,
  overrides?: unknown,
): number | undefined {
  const key = `${model.provider}/${model.id}`;
  if (
    overrides &&
    typeof overrides === "object" &&
    !Array.isArray(overrides) &&
    Object.hasOwn(overrides, key)
  ) {
    const value = (overrides as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
      return value;
  }
  if (
    model.provider === "openai-codex" ||
    model.provider.startsWith("openai-codex@") ||
    model.api === "openai-codex-responses"
  ) {
    return CODEX_CONTEXT_WINDOWS.get(model.id.replace(/^[^/]+\//, ""));
  }
  return MAX_CONTEXT_WINDOW;
}

// Preserve the existing GPT-5.6+ eligibility rule.
const GPT_VERSION = /^(?:[^/]+\/)?gpt-(\d+)(?:\.(\d+))?(?:-|$)/;

function isSupportedModelId(id: string): boolean {
  const [, major, minor = "0"] = GPT_VERSION.exec(id) ?? [];
  return +major > 5 || (+major === 5 && +minor >= 6);
}

const CAPPED_PROVIDERS = new Set(["openai", "openai-codex"]);

export function isTarget(
  model: Model<Api> | undefined,
  additionalProviders: readonly string[] = [],
  contextWindows?: unknown,
): model is Model<Api> {
  return (
    model !== undefined &&
    (CAPPED_PROVIDERS.has(model.provider) ||
      additionalProviders.includes(model.provider)) &&
    isSupportedModelId(model.id) &&
    contextWindowFor(model, contextWindows) !== undefined
  );
}

export function createLongContext() {
  let armed: { model: Model<Api>; previousContextWindow: number } | undefined;

  return {
    get armedModel(): Model<Api> | undefined {
      return armed?.model;
    },

    enable(
      model: Model<Api>,
      contextWindow = contextWindowFor(model),
    ): boolean {
      if (armed !== undefined || contextWindow === undefined) return false;

      armed = { model, previousContextWindow: model.contextWindow };
      model.contextWindow = Math.max(model.contextWindow, contextWindow);
      return true;
    },

    reset(): boolean {
      if (armed === undefined) return false;

      armed.model.contextWindow = armed.previousContextWindow;
      armed = undefined;
      return true;
    },
  };
}

type LongContextConfig = {
  autoEnable?: boolean;
  autoEnableSubagents?: boolean;
  additionalProviders?: unknown;
  contextWindows?: unknown;
};

async function readConfig(): Promise<LongContextConfig> {
  try {
    return (
      JSON.parse(
        await readFile(join(getAgentDir(), "openai-long-context.json"), "utf8"),
      ) ?? {}
    );
  } catch {
    return {};
  }
}

export default function openaiLongContext(pi: ExtensionAPI): void {
  let additionalProviders: string[] = [];
  let contextWindows: unknown;
  const longContext = createLongContext();
  let hiddenFromMenu = false;
  let warnBeforeAutoCompaction: Model<Api> | undefined;
  let autoEnabled = false;
  let modelBeingSet: Model<Api> | undefined;
  let raiseInterruptedBy: Model<Api> | undefined;
  let raiseCancelled = false;

  const setMarker = (ui: ExtensionUIContext, on: boolean): void => {
    ui.setStatus(COMMAND_NAME, on ? ui.theme.fg("warning", "⚠") : undefined);
  };

  const releaseRaisedWindow = (ctx: ExtensionContext): boolean => {
    if (!longContext.reset()) return false;
    setMarker(ctx.ui, false);
    return true;
  };

  const raiseWindowOnPrivateCopy = async (
    ctx: ExtensionContext,
  ): Promise<Model<Api> | undefined> => {
    if (
      modelBeingSet !== undefined ||
      !isTarget(ctx.model, additionalProviders, contextWindows)
    )
      return undefined;

    modelBeingSet = ctx.model;
    raiseCancelled = false;
    const privateCopy = { ...ctx.model };
    const requestedThinkingLevel = pi.getThinkingLevel();
    let interrupted = false;
    try {
      let next: Model<Api> | undefined = privateCopy;
      while (next !== undefined) {
        modelBeingSet = next;
        raiseInterruptedBy = undefined;
        if (!(await pi.setModel(next))) return undefined;
        next = raiseInterruptedBy;
      }
      interrupted = modelBeingSet !== privateCopy || raiseCancelled;
      if (interrupted) return undefined;
      pi.setThinkingLevel(requestedThinkingLevel);
      if (
        !longContext.enable(
          privateCopy,
          contextWindowFor(privateCopy, contextWindows),
        )
      )
        return undefined;
      setMarker(ctx.ui, true);
      return privateCopy;
    } finally {
      modelBeingSet = undefined;
      raiseInterruptedBy = undefined;
      if (interrupted && !raiseCancelled) await raiseWindowWhenAutoEnabled(ctx);
    }
  };

  const reattachRaisedWindow = async (
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    if (
      longContext.armedModel === undefined ||
      longContext.armedModel === ctx.model
    )
      return false;
    releaseRaisedWindow(ctx);
    return (await raiseWindowOnPrivateCopy(ctx)) !== undefined;
  };

  const raiseWindowWhenAutoEnabled = async (
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (!autoEnabled || longContext.armedModel) return;
    await raiseWindowOnPrivateCopy(ctx);
  };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const config = await readConfig();
    contextWindows = config.contextWindows;
    additionalProviders = Array.isArray(config.additionalProviders)
      ? config.additionalProviders.filter(
          (provider): provider is string => typeof provider === "string",
        )
      : [];
    if (!hiddenFromMenu && ctx.mode === "tui") {
      hiddenFromMenu = true;
      ctx.ui.addAutocompleteProvider((current) => ({
        ...current,
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const suggestions = await current.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options,
          );
          if (
            suggestions === null ||
            isTarget(ctx.model, additionalProviders, contextWindows)
          )
            return suggestions;

          const items = suggestions.items.filter(
            (item) => item.value !== COMMAND_NAME,
          );
          return items.length === 0 ? null : { ...suggestions, items };
        },
        applyCompletion: current.applyCompletion.bind(current),
        shouldTriggerFileCompletion:
          current.shouldTriggerFileCompletion?.bind(current),
      }));
    }
    const key =
      process.env.PI_SUBAGENT_CHILD === "1"
        ? "autoEnableSubagents"
        : "autoEnable";
    autoEnabled = config[key] === true;
    await raiseWindowWhenAutoEnabled(ctx);
  });

  pi.on("input", async (event, ctx: ExtensionContext) => {
    if (event.streamingBehavior === undefined) await reattachRaisedWindow(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    warnBeforeAutoCompaction = undefined;
    await reattachRaisedWindow(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.reason === "manual") return;
    if (await reattachRaisedWindow(ctx))
      return event.reason === "overflow" && event.willRetry === true
        ? undefined
        : { cancel: true };
    if (ctx.model !== warnBeforeAutoCompaction || !ctx.hasUI) return;

    const choice = await ctx.ui.select(
      "Compaction required after turning off long context",
      ["Compact now", KEEP_LONG_CONTEXT],
    );

    warnBeforeAutoCompaction = undefined;
    if (choice !== KEEP_LONG_CONTEXT) return;
    if (!(await raiseWindowOnPrivateCopy(ctx))) return;
    return { cancel: true };
  });

  pi.on("model_select", async (event, ctx: ExtensionContext) => {
    warnBeforeAutoCompaction = undefined;
    if (modelBeingSet !== undefined) {
      if (event.model !== modelBeingSet) raiseInterruptedBy = event.model;
      return;
    }
    releaseRaisedWindow(ctx);
    await raiseWindowWhenAutoEnabled(ctx);
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    releaseRaisedWindow(ctx);
  });

  pi.registerCommand(COMMAND_NAME, {
    description:
      "Raise the GPT-5.6+ context window using this provider/model’s long-context limit",
    handler: async (_args, ctx) => {
      if (modelBeingSet !== undefined) {
        raiseCancelled = true;
        raiseInterruptedBy = ctx.model;
        return;
      }
      if (releaseRaisedWindow(ctx)) {
        warnBeforeAutoCompaction = ctx.model;
        return;
      }

      const raised = await raiseWindowOnPrivateCopy(ctx);
      if (raiseCancelled) return;
      if (raised === undefined) {
        ctx.ui.notify(
          `/${COMMAND_NAME} only applies to GPT-5.6+ models on openai, openai-codex, or configured additionalProviders. Switch to one with a known or configured context window first.`,
          "warning",
        );
        return;
      }

      warnBeforeAutoCompaction = undefined;
      ctx.ui.notify(
        `Long context is active for ${raised.provider}/${raised.id} — ${raised.contextWindow.toLocaleString("en-US")} tokens.`,
        "warning",
      );
    },
  });
}
