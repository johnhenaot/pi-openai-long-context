# pi-openai-long-context

Raise GPT-5.6 and GPT-6 models from pi's **272K** context window to **1.05M**.

It is off until you ask for it, because [it costs more](#what-it-costs).

https://github.com/user-attachments/assets/689360eb-6e11-47a2-930c-c6741ec232c6

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

Create `~/.pi/agent/openai-long-context.json` (or the same file in your `PI_CODING_AGENT_DIR`):

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

Without the config above, long context never outlives the moment: switching models, a new session, restarting pi, `/reload` — all of it drops you back to 272K, so you cannot leave it on and be billed for it a week later. Nothing is written to your settings.

Compaction is the exception: it keeps the big window, which is the whole point of turning it on. And if turning it *off* would immediately trigger automatic compaction, pi asks whether to compact or keep long context instead.

## What it costs

Past 272K input tokens, OpenAI bills the **whole request** at its long-context rate — see [OpenAI's pricing](https://platform.openai.com/docs/pricing). On a subscription, it burns through your quota faster too. That applies to every subagent child as well, and there can be a lot of those.

## Supported models

`gpt-5.6-*` and `gpt-6-*` on the `openai` and `openai-codex` providers. Everything else is left alone — other providers already ship the bigger window.

1.05M is the documented maximum for GPT-5.6 and [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra). Future `gpt-6-*` models match automatically, but their real limits are not checked here; look up a new model's context window before trusting it.

If you set your own context window for a supported model in `models.json`, turning this off restores *your* value, not pi's.

## Subagent details

Which children this reaches, and what to do when it misses one.

Nothing per launch is needed: no flag, no `/long-context`, no `extensionBindings`. An opted-in child raises its window at startup if the extension is loaded and its model is supported.

`autoEnableSubagents` keys off `PI_SUBAGENT_CHILD=1`, which marks the **runner process**, not one child's execution mode. So it also covers nested foreground children (`async: false`) running in that process. A foreground child started directly inside your own pi process has no marker, so it follows `autoEnable` like your session does.

Background children discover installed extensions on their own; foreground children need an explicit path. If a child does not pick this up, add this extension's `index.ts` to the agent's `extensions` or `subagentOnlyExtensions`. Extension-denying policies still apply.

Each child gets its own window. One child turning it off, switching models, or shutting down never touches its siblings.

## License

MIT
