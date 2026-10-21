# pi-openai-long-context

Raise GPT-5.6+ models to a provider/model-specific long-context target: **1.05M for OpenAI API**, or **872K for the current Codex models listed below**.

It is off until you ask for it, because [it costs more](#what-it-costs).

https://github.com/user-attachments/assets/6844778e-da8f-4892-b9c9-05ed09f00190

## Install

```bash
pi install npm:pi-openai-long-context
```

Restart pi, or run `/reload`.

## Turn it on for one task

```text
/long-context
```

Run it again to turn it off. A `⚠` in the footer means it is on. The command only shows up in the `/` menu when you are on a supported model.

## Turn it on for good

Create/edit `~/.pi/agent/openai-long-context.json` (or the same file in your `PI_CODING_AGENT_DIR`):

```json
{
  "autoEnable": true,
  "autoEnableSubagents": true
}
```

| Flag | Turns long context on for |
| --- | --- |
| `autoEnable` | Your own pi sessions, and foreground children running inside them |
| `autoEnableSubagents` | [pi-subagents](https://github.com/nicobailon/pi-subagents) children in background runner processes |

Use one, the other, or both — they are independent. The split is by process, not by foreground or background: a child gets whichever flag applies to the process it runs in. Only the literal `true` counts; anything else (missing file, `false`, `"true"`, broken JSON) leaves that side off. pi never writes this file for you.

Opted-in sessions turn long context on at startup and again whenever you pick a supported model. `/long-context` still wins for the model you are on, until the next model switch or session.

To opt out, flip the flag to `false` or delete the file. The file is read when a session starts, so a running session keeps auto-arming until you `/reload` it (or start, resume, or fork one).

## It turns itself off

Without the config above, long context never outlives the moment: switching models, a new session, restarting pi, `/reload` — all of it restores the previous context window (for example, 272K or 500K), so you cannot leave it on and be billed for it a week later. Nothing is written to your settings.

Compaction is the exception: it keeps the big window, which is the whole point of turning it on. And if turning it *off* would immediately trigger automatic compaction, pi asks whether to compact or keep long context instead.

## What it costs

Long-context pricing and subscription quota usage depend on the model and route — see [OpenAI's pricing](https://platform.openai.com/docs/pricing) for API rates and your subscription terms for Codex. A token target here is not a billing threshold. Each subagent child can also consume long-context usage.

## Supported models and providers

Any GPT model from 5.6 onward — `gpt-5.6-*`, `gpt-6-*`, `gpt-6.1-*`, and later versions (including namespaced IDs such as `openai/gpt-5.6-*`) — on the `openai` and `openai-codex` providers. Other providers can be explicitly enabled with `additionalProviders` in `openai-long-context.json`; providers not listed there are left untouched.

To use an equivalent model through another provider, add its provider name to `~/.pi/agent/openai-long-context.json`:

```json
{
  "additionalProviders": ["openrouter"]
}
```

This applies to manual toggles, the command menu, and sessions opted in with either auto-enable flag. Only add providers whose context limits you have checked. An alias is never enabled automatically, even when it has a configured token target. Opted-in `openai-codex@...` aliases and models using `openai-codex-responses` use the Codex defaults; other additional providers retain the 1.05M default. Set an exact override when a route has a different limit.

### Token targets

| Route | Default target |
| --- | --- |
| `openai` | 1,050,000 (existing GPT-5.6+ API behavior) |
| Codex: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-6.1-sol` | 872,000 |
| Other/future Codex models | No automatic target; configure one explicitly |
| Other opted-in providers | 1,050,000 unless overridden |

The Codex value is a snapshot reported in [Pi #11173](https://github.com/earendil-works/pi/pull/11173): the author's backend model listing returned `max_context_window: 872000`. It is **not a universal limit or a limit independently verified for your account**. Pi's catalog still supplies 272K or 500K defaults; this extension chooses a larger opt-in target. OpenAI API documentation does not establish Codex subscription limits. Newer API models still match the existing GPT-5.6+ rule; verify their limits before using them.

Override an exact `provider/model-id` in `openai-long-context.json` after checking the limit for that route/account:

```json
{
  "additionalProviders": ["openai-codex@work"],
  "contextWindows": {
    "openai/gpt-6.1-sol": 1050000,
    "openai-codex/gpt-6.1-sol": 872000,
    "openai-codex@work/gpt-6.1-sol": 872000
  }
}
```

Keys include the full model ID, including any namespace (for example `openrouter/openai/gpt-6.1-sol`). Values must be positive safe integers; invalid entries fall back to the defaults above. Configuration is read on session start. Overrides do not enable other providers or models outside the existing GPT-5.6+ rule.

Targets only raise windows: an already larger value from `models.json` stays larger, even above these defaults or an override. Turning long context off restores the exact previous value. This is not a hard server-limit clamp. The activation notification shows the effective size. Pi uses this window for compaction and subtracts its own reserve; the extension does not change output-token limits or send a server-side context-window parameter.

## Subagent details

Which children this reaches, and what to do when it misses one.

Nothing per launch is needed: no flag, no `/long-context`, no `extensionBindings`. An opted-in child raises its window at startup if the extension is loaded and its model is supported.

`autoEnableSubagents` keys off `PI_SUBAGENT_CHILD=1`, which marks the **runner process**, not one child's execution mode. So it also covers nested foreground children (`async: false`) running in that process. A foreground child started directly inside your own pi process has no marker, so it follows `autoEnable` like your session does.

Background children discover installed extensions on their own; foreground children need an explicit path. If a child does not pick this up, add this extension's `index.ts` to the agent's `extensions` or `subagentOnlyExtensions`. Extension-denying policies still apply.

Each child gets its own window. One child turning it off, switching models, or shutting down never touches its siblings.

## License

MIT
