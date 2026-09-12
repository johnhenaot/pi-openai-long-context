# pi-openai-long-context

Raise GPT-5.6 and GPT-6 models (including GPT-6 Astra) from pi's **272K** context window to **1.05M**, one task at a time.

## Install

```bash
pi install npm:pi-openai-long-context
```

Restart pi, or run `/reload`.

## Use it

```text
/long-context
```

Toggles the big window on and off for the supported model you are using. A `⚠` in the footer means it is on. The command only appears in the `/` menu for `gpt-5.6-*` and `gpt-6-*` models on `openai` or `openai-codex`.

## It turns itself off

In ordinary sessions, switching models, starting a new session, restarting pi, `/reload` — all of it drops you back to 272K, so you cannot leave it on and be billed for it later. Nothing is saved to your settings.

Compaction is the exception: it keeps the big window, which is the point of turning it on.

If turning it off would immediately trigger automatic compaction, pi asks whether to compact or keep long context instead.

## pi-subagents

Automatic long context for [pi-subagents](https://github.com/nicobailon/pi-subagents) is **off by default**. To opt in once for all future background children, create `~/.pi/agent/openai-long-context.json`:

```json
{
  "autoEnableSubagents": true
}
```

If you use `PI_CODING_AGENT_DIR`, put the file in that directory instead. Only the boolean `true` enables this behavior; missing, false, unreadable, or invalid config leaves it off. This extension never creates or changes the config file.

After opting in, background children automatically enable long context at session startup when this extension is loaded and the selected model is supported. No per-launch flag, `/long-context` command, or `extensionBindings` is needed, and the parent's toggle is unchanged. `/long-context` remains available without opting in.

Detection uses pi-subagents' `PI_SUBAGENT_CHILD=1` marker. Foreground children (`async: false`) are not automatically enabled. Background children normally discover installed extensions; if your agent restricts extension loading, include this extension's `index.ts` path in its `extensions` or `subagentOnlyExtensions` configuration. Extension-denying policies still apply.

Each child keeps its own context window. Compaction preserves it; toggling off, switching models, or shutting down restores the previous value. Starting or reloading a marked child session automatically enables it again only while opted in. To opt out, set `autoEnableSubagents` to `false` or remove the file; already-running children are unaffected. The long-context costs below apply to opted-in children too.

## What it costs

Past 272K input tokens, OpenAI bills the **whole request** at its long-context rate — see [OpenAI's pricing](https://platform.openai.com/docs/pricing). On a subscription, that also burns through your quota faster.

## Supported models and providers

Works on `gpt-5.6-*` and `gpt-6-*` models on the `openai` and `openai-codex` providers. Other providers are left untouched.

The toggle uses 1.05M tokens, the documented maximum for GPT-5.6 and [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra). Future `gpt-6-*` models are matched automatically, but this extension does not validate their limits; verify each model's documented context window before enabling it.

If you already set your own context window for a supported model in `models.json`, turning this off restores *your* value, not pi's.

## License

MIT
