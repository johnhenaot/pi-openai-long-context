import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const API_MAX_CONTEXT_WINDOW = 1_050_000;
export const OAUTH_MAX_CONTEXT_WINDOW = 872_000;

export const COMMAND_NAME = "long-context";

const KEEP_LONG_CONTEXT = "Keep long context";

const GPT_VERSION_EXTRACTOR_REGEX = /^(?:[^/]+\/)?gpt-(\d+(?:\.\d+)?)(?:-|$)/;

function isSupportedModelId(id: string): boolean {
  return Number(GPT_VERSION_EXTRACTOR_REGEX.exec(id)?.[1]) >= 5.6;
}

const CAPPED_PROVIDERS = new Set(["openai", "openai-codex"]);

export function isTarget(
  model: Model<Api> | undefined,
  additionalProviders: ReadonlyMap<string, number> = new Map(),
): model is Model<Api> {
  return (
    model !== undefined &&
    (CAPPED_PROVIDERS.has(model.provider) ||
      additionalProviders.has(model.provider)) &&
    isSupportedModelId(model.id)
  );
}

export function createLongContext() {
  let armed: { model: Model<Api>; previousContextWindow: number } | undefined;

  return {
    get armedModel(): Model<Api> | undefined {
      return armed?.model;
    },

    enable(model: Model<Api>, contextWindow: number): boolean {
      if (armed !== undefined) return false;

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

function parseLegacyProviderList(providers: unknown[]): Map<string, number> {
  return new Map(
    providers
      .filter((provider): provider is string => typeof provider === "string")
      .map((provider) => [provider, OAUTH_MAX_CONTEXT_WINDOW]),
  );
}

function parseAdditionalProviders(value: unknown): Map<string, number> {
  if (Array.isArray(value)) return parseLegacyProviderList(value);
  if (value === null || typeof value !== "object") return new Map();
  return new Map(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        Number.isSafeInteger(entry[1]) && (entry[1] as number) > 0,
    ),
  );
}

export default function openaiLongContext(pi: ExtensionAPI): void {
  let additionalProviders = new Map<string, number>();
  const longContext = createLongContext();
  let hiddenFromMenu = false;
  let warnBeforeAutoCompaction: Model<Api> | undefined;
  let autoEnabled = false;
  let modelBeingSet: Model<Api> | undefined;
  let raiseInterruptedBy: Model<Api> | undefined;
  let raiseCancelled = false;

  const targetWindow = (model: Model<Api>, ctx: ExtensionContext): number => {
    if (model.provider === "openai" && !ctx.modelRegistry.isUsingOAuth(model))
      return API_MAX_CONTEXT_WINDOW;
    if (CAPPED_PROVIDERS.has(model.provider)) return OAUTH_MAX_CONTEXT_WINDOW;
    return additionalProviders.get(model.provider) ?? OAUTH_MAX_CONTEXT_WINDOW;
  };

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
      !isTarget(ctx.model, additionalProviders)
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
      if (!longContext.enable(privateCopy, targetWindow(privateCopy, ctx)))
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
    additionalProviders = parseAdditionalProviders(config.additionalProviders);
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
          if (suggestions === null || isTarget(ctx.model, additionalProviders))
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
    description: "Raise the GPT-5.6+ context window for this model",
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
          `/${COMMAND_NAME} only applies to GPT-5.6+ models on openai, openai-codex, or configured additionalProviders. Switch to one first.`,
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
