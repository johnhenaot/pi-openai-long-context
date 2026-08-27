/**
 * Toggle OpenAI GPT-5.6 models between pi's built-in 272K context window
 * (OpenAI short-context pricing) and OpenAI's 1.05M maximum.
 *
 * Only `openai/gpt-5.6-*` models are touched — every other provider and model
 * keeps its own context window.
 *
 * Session-scoped by design: each new pi session starts back at the built-in
 * default, so a forgotten toggle can't silently run up long-context rates.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

/** OpenAI's maximum GPT-5.6 context window. */
export const MAX_CONTEXT_WINDOW = 1_050_000;

const GPT_5_6_ID = /^gpt-5\.6-/;

export function isTarget(model: Model<Api> | undefined): model is Model<Api> {
  return (
    model !== undefined && model.provider === "openai" && GPT_5_6_ID.test(model.id)
  );
}

export interface ContextToggle {
  readonly enabled: boolean;
  apply(model: Model<Api> | undefined): boolean;
  flip(): boolean;
}

export function createToggle(): ContextToggle {
  const builtIns = new Map<string, number>();
  let enabled = false;

  return {
    get enabled(): boolean {
      return enabled;
    },

    flip(): boolean {
      enabled = !enabled;
      return enabled;
    },

    apply(model: Model<Api> | undefined): boolean {
      if (!isTarget(model)) return false;

      // Record the real built-in window the first time this model is seen, so
      // toggling back restores that value rather than a hardcoded default.
      const builtIn = builtIns.get(model.id) ?? model.contextWindow;
      builtIns.set(model.id, builtIn);
      model.contextWindow = enabled ? MAX_CONTEXT_WINDOW : builtIn;
      return true;
    },
  };
}

export default function openaiLongContext(pi: ExtensionAPI): void {
  const toggle = createToggle();

  // Keep newly selected and restored models in sync with the current state.
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    toggle.apply(ctx.model);
  });
  pi.on("model_select", (event) => {
    toggle.apply(event.model);
  });

  pi.registerCommand("long-context", {
    description:
      "Toggle OpenAI GPT-5.6 context window: 272K default / 1.05M max",
    handler: async (_args, ctx) => {
      const enabled = toggle.flip();

      // Patch the whole catalogue, not just the active model, so the /model
      // picker and any later selection reflect the toggle too.
      for (const model of ctx.modelRegistry.getAvailable()) toggle.apply(model);
      toggle.apply(ctx.model);

      if (!isTarget(ctx.model)) {
        ctx.ui.notify(
          "Active model is not an OpenAI GPT-5.6 model — the toggle is set but has no effect until you switch to one.",
          "warning",
        );
      }

      ctx.ui.notify(
        enabled
          ? `GPT-5.6 context window: ${MAX_CONTEXT_WINDOW.toLocaleString()} (long-context rates apply above 272K input tokens)`
          : "GPT-5.6 context window: built-in default (272K, short-context rates)",
        "info",
      );
    },
  });
}
