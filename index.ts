import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

export const MAX_CONTEXT_WINDOW = 1_050_000;

export const COMMAND_NAME = "long-context";

const CONFIG_FILE = "openai-long-context.json";

const SUBAGENT_RUNNER_MARKER = "PI_SUBAGENT_CHILD";

const KEEP_LONG_CONTEXT = "Keep long context";

const SUPPORTED_MODEL_ID = /^gpt-(?:5\.6|6)-/;

const CAPPED_PROVIDERS = new Set(["openai", "openai-codex"]);

export function isTarget(model: Model<Api> | undefined): model is Model<Api> {
  return (
    model !== undefined &&
    CAPPED_PROVIDERS.has(model.provider) &&
    SUPPORTED_MODEL_ID.test(model.id)
  );
}

export function createLongContext() {
  let armed: { model: Model<Api>; previousContextWindow: number } | undefined;

  return {
    get armedModel(): Model<Api> | undefined {
      return armed?.model;
    },

    enable(model: Model<Api> | undefined): boolean {
      if (armed !== undefined || !isTarget(model)) return false;

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

async function readAutoEnableSetting(): Promise<boolean> {
  const key = isSubagentRunnerProcess() ? "autoEnableSubagents" : "autoEnable";
  try {
    const config = JSON.parse(
      await readFile(join(getAgentDir(), CONFIG_FILE), "utf8"),
    );
    return config?.[key] === true;
  } catch {
    return false;
  }
}

export default function openaiLongContext(pi: ExtensionAPI): void {
  const longContext = createLongContext();
  let hiddenFromMenu = false;
  let warnBeforeAutoCompaction: Model<Api> | undefined;
  let autoEnabled = false;
  let raisingWindow = false;

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
        if (suggestions === null || isTarget(ctx.model)) return suggestions;

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

  const raiseWindowOnPrivateCopy = async (
    ctx: ExtensionContext,
  ): Promise<Model<Api> | undefined> => {
    if (raisingWindow || !isTarget(ctx.model)) return undefined;

    raisingWindow = true;
    try {
      const privateCopy = { ...ctx.model };
      const requestedThinkingLevel = pi.getThinkingLevel();
      if (!(await pi.setModel(privateCopy))) return undefined;
      pi.setThinkingLevel(requestedThinkingLevel);
      if (!longContext.enable(privateCopy)) return undefined;
      setMarker(ctx.ui, true);
      return privateCopy;
    } finally {
      raisingWindow = false;
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
    hideFromMenuUnlessTargeted(ctx);
    autoEnabled = await readAutoEnableSetting();
    await raiseWindowWhenAutoEnabled(ctx);
  });

  pi.on("input", async (event, ctx: ExtensionContext) => {
    if (startsNewTurn(event)) await reattachRaisedWindow(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    warnBeforeAutoCompaction = undefined;
    await reattachRaisedWindow(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.reason === "manual") return;
    if (await reattachRaisedWindow(ctx)) return { cancel: true };
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

  pi.on("model_select", async (_event, ctx: ExtensionContext) => {
    warnBeforeAutoCompaction = undefined;
    releaseRaisedWindow(ctx);
    await raiseWindowWhenAutoEnabled(ctx);
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    releaseRaisedWindow(ctx);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: `Raise the GPT-5.6 / GPT-6 context window to ${MAX_CONTEXT_WINDOW.toLocaleString("en-US")} for this model`,
    handler: async (_args, ctx) => {
      if (releaseRaisedWindow(ctx)) {
        warnBeforeAutoCompaction = ctx.model;
        return;
      }

      const raised = await raiseWindowOnPrivateCopy(ctx);
      if (raised === undefined) {
        ctx.ui.notify(
          `/${COMMAND_NAME} only applies to GPT-5.6 / GPT-6 models on openai or openai-codex. Switch to one first.`,
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
