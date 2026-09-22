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

const CONFIG_FILE = "openai-long-context.json";

const SUBAGENT_RUNNER_MARKER = "PI_SUBAGENT_CHILD";

const KEEP_LONG_CONTEXT = "Keep long context";

const SUPPORTED_MODEL_ID = /^(?:[^/]+\/)?gpt-(?:5\.6|6)-/;

const CAPPED_PROVIDERS = new Set(["openai", "openai-codex"]);

export function isTarget(
  model: Model<Api> | undefined,
  additionalProviders: readonly string[] = [],
): model is Model<Api> {
  return (
    model !== undefined &&
    (CAPPED_PROVIDERS.has(model.provider) ||
      additionalProviders.includes(model.provider)) &&
    SUPPORTED_MODEL_ID.test(model.id)
  );
}

export function createLongContext(
  getAdditionalProviders: () => readonly string[] = () => [],
) {
  let armed: { model: Model<Api>; previousContextWindow: number } | undefined;

  return {
    get armedModel(): Model<Api> | undefined {
      return armed?.model;
    },

    enable(model: Model<Api> | undefined): boolean {
      if (armed !== undefined || !isTarget(model, getAdditionalProviders()))
        return false;

      armed = { model, previousContextWindow: model.contextWindow };
      model.contextWindow = Math.max(model.contextWindow, MAX_CONTEXT_WINDOW);
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

function isSubagentRunnerProcess(): boolean {
  return process.env[SUBAGENT_RUNNER_MARKER] === "1";
}

type LongContextConfig = {
  autoEnable?: boolean;
  autoEnableSubagents?: boolean;
  additionalProviders?: unknown;
};

async function readConfig(): Promise<LongContextConfig> {
  try {
    const config = JSON.parse(
      await readFile(join(getAgentDir(), CONFIG_FILE), "utf8"),
    );
    return config !== null &&
      typeof config === "object" &&
      !Array.isArray(config)
      ? config
      : {};
  } catch {
    return {};
  }
}

function getAdditionalProviders(config: LongContextConfig): string[] {
  return Array.isArray(config.additionalProviders)
    ? config.additionalProviders.filter(
        (provider): provider is string => typeof provider === "string",
      )
    : [];
}

export default function openaiLongContext(pi: ExtensionAPI): void {
  let additionalProviders: string[] = [];
  const longContext = createLongContext(() => additionalProviders);
  let hiddenFromMenu = false;
  let warnBeforeAutoCompaction: Model<Api> | undefined;
  let autoEnabled = false;
  let raisingWindow = false;
  let modelBeingSet: Model<Api> | undefined;
  let raiseInterruptedBy: Model<Api> | undefined;
  let raiseCancelled = false;

  const setMarker = (ui: ExtensionUIContext, on: boolean): void => {
    ui.setStatus(COMMAND_NAME, on ? ui.theme.fg("warning", "⚠") : undefined);
  };

  const hideFromMenuUnlessTargeted = (ctx: ExtensionContext): void => {
    if (hiddenFromMenu || ctx.mode !== "tui") return;
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
        if (suggestions === null || isTarget(ctx.model, additionalProviders))
          return suggestions;

        const items = suggestions.items.filter(
          (item) => item.value !== COMMAND_NAME,
        );
        return items.length === 0 ? null : { ...suggestions, items };
      },
      applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
        current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
      shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        false,
    }));
  };

  const releaseRaisedWindow = (ctx: ExtensionContext): boolean => {
    if (!longContext.reset()) return false;
    setMarker(ctx.ui, false);
    return true;
  };

  const setModelUntilTheUserStopsSwitching = async (
    model: Model<Api>,
  ): Promise<boolean> => {
    let next: Model<Api> | undefined = model;
    while (next !== undefined) {
      modelBeingSet = next;
      raiseInterruptedBy = undefined;
      if (!(await pi.setModel(next))) return false;
      next = raiseInterruptedBy;
    }
    return true;
  };

  const raiseWindowOnPrivateCopy = async (
    ctx: ExtensionContext,
  ): Promise<Model<Api> | undefined> => {
    if (raisingWindow || !isTarget(ctx.model, additionalProviders))
      return undefined;

    raisingWindow = true;
    raiseCancelled = false;
    const privateCopy = { ...ctx.model };
    const requestedThinkingLevel = pi.getThinkingLevel();
    let interrupted = false;
    try {
      if (!(await setModelUntilTheUserStopsSwitching(privateCopy)))
        return undefined;
      interrupted = modelBeingSet !== privateCopy || raiseCancelled;
      if (interrupted) return undefined;
      pi.setThinkingLevel(requestedThinkingLevel);
      if (!longContext.enable(privateCopy)) return undefined;
      setMarker(ctx.ui, true);
      return privateCopy;
    } finally {
      raisingWindow = false;
      modelBeingSet = undefined;
      raiseInterruptedBy = undefined;
      if (interrupted && !raiseCancelled) await raiseWindowWhenAutoEnabled(ctx);
    }
  };

  const raisedCopyDetachedFromSession = (ctx: ExtensionContext): boolean =>
    longContext.armedModel !== undefined &&
    longContext.armedModel !== ctx.model;

  const reattachRaisedWindow = async (
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    if (!raisedCopyDetachedFromSession(ctx)) return false;
    releaseRaisedWindow(ctx);
    return (await raiseWindowOnPrivateCopy(ctx)) !== undefined;
  };

  const raiseWindowWhenAutoEnabled = async (
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (!autoEnabled || longContext.armedModel) return;
    await raiseWindowOnPrivateCopy(ctx);
  };

  const startsNewTurn = (event: { streamingBehavior?: unknown }): boolean =>
    event.streamingBehavior === undefined;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const config = await readConfig();
    additionalProviders = getAdditionalProviders(config);
    hideFromMenuUnlessTargeted(ctx);
    const key = isSubagentRunnerProcess()
      ? "autoEnableSubagents"
      : "autoEnable";
    autoEnabled = config[key] === true;
    await raiseWindowWhenAutoEnabled(ctx);
  });

  pi.on("input", async (event, ctx: ExtensionContext) => {
    if (startsNewTurn(event)) await reattachRaisedWindow(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    warnBeforeAutoCompaction = undefined;
    await reattachRaisedWindow(ctx);
  });

  const compactionContinuesAnInterruptedTurn = (event: {
    reason: string;
    willRetry?: boolean;
  }): boolean => event.reason === "overflow" && event.willRetry === true;

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.reason === "manual") return;
    if (await reattachRaisedWindow(ctx))
      return compactionContinuesAnInterruptedTurn(event)
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
    if (raisingWindow) {
      const chosen = event.model ?? ctx.model;
      if (chosen !== modelBeingSet) raiseInterruptedBy = chosen;
      return;
    }
    releaseRaisedWindow(ctx);
    await raiseWindowWhenAutoEnabled(ctx);
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    releaseRaisedWindow(ctx);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: `Raise the GPT-5.6 / GPT-6 context window to ${MAX_CONTEXT_WINDOW.toLocaleString("en-US")} for this model`,
    handler: async (_args, ctx) => {
      if (raisingWindow) {
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
          `/${COMMAND_NAME} only applies to GPT-5.6 / GPT-6 models on openai, openai-codex, or configured additionalProviders. Switch to one first.`,
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
