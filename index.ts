/**
 * Toggle the active OpenAI GPT-5.6 model between pi's built-in 272K context
 * window and OpenAI's 1.05M maximum.
 *
 * Deliberately hard to leave on: the toggle is bound to the exact model that
 * was active when you enabled it, and any model change — including sol to
 * terra — puts it back. Compaction keeps it on; that is the point of raising
 * the window in the first place.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

/** OpenAI's maximum GPT-5.6 context window. */
export const MAX_CONTEXT_WINDOW = 1_050_000;

export const COMMAND_NAME = "long-context";

/** Input tokens above this bill the whole request at long-context rates. */
const LONG_CONTEXT_TIER = 272_000;

const GPT_5_6_ID = /^gpt-5\.6-/;

export function isTarget(model: Model<Api> | undefined): model is Model<Api> {
  return (
    model !== undefined &&
    model.provider === "openai" &&
    GPT_5_6_ID.test(model.id)
  );
}

/**
 * True for this extension's own entry in the `/` menu. pi appends `:1`, `:2`
 * suffixes when several extensions register the same command name.
 */
export function isOwnCommandItem(item: { value: string }): boolean {
  return (
    item.value === COMMAND_NAME || item.value.startsWith(`${COMMAND_NAME}:`)
  );
}

export function warningMessage(model: Model<Api>): string {
  return (
    `Long context is active for ${model.provider}/${model.id} — ` +
    `${MAX_CONTEXT_WINDOW.toLocaleString("en-US")} tokens. Above ` +
    `${LONG_CONTEXT_TIER.toLocaleString("en-US")} input tokens the entire ` +
    `request is billed at GPT-5.6 long-context rates: 2x input and cache, ` +
    `1.5x output. It resets to the built-in window when you switch models ` +
    `or start a new session.`
  );
}

export interface LongContext {
  /** The model currently raised to the max window, if any. */
  readonly armedModel: Model<Api> | undefined;
  /** Raise `model` to the max window. False when it is not a GPT-5.6 model. */
  enable(model: Model<Api> | undefined): boolean;
  /** Restore the recorded built-in window. False when nothing was armed. */
  reset(): boolean;
}

export function createLongContext(): LongContext {
  let armed: { model: Model<Api>; builtIn: number } | undefined;

  return {
    get armedModel(): Model<Api> | undefined {
      return armed?.model;
    },

    enable(model: Model<Api> | undefined): boolean {
      if (armed !== undefined || !isTarget(model)) return false;

      // Record the real built-in window, so a models.json contextWindow
      // override of your own survives the toggle instead of being clobbered.
      armed = { model, builtIn: model.contextWindow };
      model.contextWindow = MAX_CONTEXT_WINDOW;
      return true;
    },

    reset(): boolean {
      if (armed === undefined) return false;

      armed.model.contextWindow = armed.builtIn;
      armed = undefined;
      return true;
    },
  };
}

export default function openaiLongContext(pi: ExtensionAPI): void {
  const longContext = createLongContext();
  let hiddenFromMenu = false;

  const setMarker = (ui: ExtensionUIContext, on: boolean): void => {
    ui.setStatus(COMMAND_NAME, on ? ui.theme.fg("warning", "⚠") : undefined);
  };

  /**
   * Keep `/long-context` out of the `/` menu unless it would do something.
   * pi has no way to unregister a command, so the menu is filtered instead;
   * typing the command by hand still reaches the handler, which refuses.
   */
  const hideFromMenuUnlessTargeted = (ctx: ExtensionContext): void => {
    if (hiddenFromMenu || ctx.mode !== "tui") return;
    hiddenFromMenu = true;

    ctx.ui.addAutocompleteProvider((current) => ({
      ...current,
      triggerCharacters: current.triggerCharacters,
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const suggestions = await current.getSuggestions(
          lines,
          cursorLine,
          cursorCol,
          options,
        );
        if (suggestions === null || isTarget(ctx.model)) return suggestions;

        const items = suggestions.items.filter(
          (item) => !isOwnCommandItem(item),
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

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    hideFromMenuUnlessTargeted(ctx);
  });

  // Any model change drops back to the built-in window — including switching
  // between two GPT-5.6 models. Compaction emits no model change, so a raised
  // window survives it.
  pi.on("model_select", (_event, ctx: ExtensionContext) => {
    if (longContext.reset()) setMarker(ctx.ui, false);
  });

  // The model objects come from the shared catalogue, so a raised window would
  // outlive this session's state on /reload.
  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    if (longContext.reset()) setMarker(ctx.ui, false);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: `Raise the GPT-5.6 context window to ${MAX_CONTEXT_WINDOW.toLocaleString("en-US")} for this model`,
    handler: async (_args, ctx) => {
      if (longContext.reset()) {
        setMarker(ctx.ui, false);
        return;
      }

      const model = ctx.model;
      if (!isTarget(model) || !longContext.enable(model)) {
        ctx.ui.notify(
          `/${COMMAND_NAME} only applies to OpenAI GPT-5.6 models. Switch to one first.`,
          "warning",
        );
        return;
      }

      setMarker(ctx.ui, true);
      ctx.ui.notify(warningMessage(model), "warning");
    },
  });
}
