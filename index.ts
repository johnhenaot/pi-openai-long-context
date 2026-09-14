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

export default function openaiLongContext(pi: ExtensionAPI): void {
  const longContext = createLongContext();
  let hiddenFromMenu = false;
  let warnBeforeAutoCompaction: Model<Api> | undefined;
  let optedIn = false;
  let arming = false;

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

  const autoArm = async (ctx: ExtensionContext): Promise<void> => {
    // Re-selecting the current model swaps in the registry object without a
    // model_select event; release our orphaned copy before re-arming.
    if (longContext.armedModel && longContext.armedModel !== ctx.model) {
      longContext.reset();
      setMarker(ctx.ui, false);
    }
    // pi.setModel below cannot re-enter this, but a loop here would hang a session.
    if (arming || !optedIn || longContext.armedModel || !isTarget(ctx.model))
      return;
    arming = true;
    try {
      // Sessions in one process share a model registry, and a subagent child can
      // be one of them; only ever mutate this session's own copy.
      const model = { ...ctx.model };
      const thinkingLevel = pi.getThinkingLevel();
      if (!(await pi.setModel(model))) return;
      pi.setThinkingLevel(thinkingLevel);
      if (longContext.enable(model)) setMarker(ctx.ui, true);
    } finally {
      arming = false;
    }
  };

  // Re-selecting the model that is already selected swaps pi's registry object
  // back in without a model_select event, orphaning the copy we raised.
  const healOrphanedCopy = async (ctx: ExtensionContext): Promise<void> => {
    if (longContext.armedModel && longContext.armedModel !== ctx.model)
      await autoArm(ctx);
  };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    hideFromMenuUnlessTargeted(ctx);

    try {
      const config = JSON.parse(
        await readFile(join(getAgentDir(), "openai-long-context.json"), "utf8"),
      );
      optedIn =
        config?.[
          process.env.PI_SUBAGENT_CHILD === "1"
            ? "autoEnableSubagents"
            : "autoEnable"
        ] === true;
    } catch {
      optedIn = false;
    }

    await autoArm(ctx);
  });

  // Unlike before_agent_start, this runs before pi decides whether to compact,
  // which is the decision an orphaned copy would silently get wrong.
  pi.on("input", async (event, ctx: ExtensionContext) => {
    // Mid-stream messages skip that check anyway, and swapping the model out
    // from under a running turn helps nobody.
    if (event.streamingBehavior === undefined) await healOrphanedCopy(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    warnBeforeAutoCompaction = undefined;
    // Only heal here; turning it off by hand must stay off.
    await healOrphanedCopy(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (
      event.reason === "manual" ||
      ctx.model !== warnBeforeAutoCompaction ||
      !ctx.hasUI
    )
      return;

    const choice = await ctx.ui.select(
      "Compaction required after turning off long context",
      ["Compact now", "Keep long context"],
    );

    warnBeforeAutoCompaction = undefined;
    if (choice !== "Keep long context" || !longContext.enable(ctx.model))
      return;
    setMarker(ctx.ui, true);
    return { cancel: true };
  });

  pi.on("model_select", async (_event, ctx: ExtensionContext) => {
    warnBeforeAutoCompaction = undefined;
    if (longContext.reset()) setMarker(ctx.ui, false);
    await autoArm(ctx);
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    if (longContext.reset()) setMarker(ctx.ui, false);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: `Raise the GPT-5.6 / GPT-6 context window to ${MAX_CONTEXT_WINDOW.toLocaleString("en-US")} for this model`,
    handler: async (_args, ctx) => {
      const armedModel = longContext.armedModel;
      if (longContext.reset()) {
        warnBeforeAutoCompaction = armedModel;
        setMarker(ctx.ui, false);
        return;
      }

      const model = ctx.model;
      if (!isTarget(model) || !longContext.enable(model)) {
        ctx.ui.notify(
          `/${COMMAND_NAME} only applies to GPT-5.6 / GPT-6 models on openai or openai-codex. Switch to one first.`,
          "warning",
        );
        return;
      }

      warnBeforeAutoCompaction = undefined;
      setMarker(ctx.ui, true);
      ctx.ui.notify(
        `Long context is active for ${model.provider}/${model.id} — ${model.contextWindow.toLocaleString("en-US")} tokens.`,
        "warning",
      );
    },
  });
}
