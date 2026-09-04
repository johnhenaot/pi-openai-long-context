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

Switching models, starting a new session, restarting pi, `/reload` — all of it drops you back to 272K, so you cannot leave it on and be billed for it later. Nothing is saved to your settings.

Compaction is the exception: it keeps the big window, which is the point of turning it on.

If turning it off would immediately trigger automatic compaction, pi asks whether to compact or keep long context instead.

## What it costs

Past 272K input tokens, OpenAI bills the **whole request** at its long-context rate — see [OpenAI's pricing](https://platform.openai.com/docs/pricing). On a subscription, that also burns through your quota faster.

## Supported models and providers

Works on `gpt-5.6-*` and `gpt-6-*` models on the `openai` and `openai-codex` providers. Other providers are left untouched.

The toggle uses 1.05M tokens, the documented maximum for GPT-5.6 and [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra). Future `gpt-6-*` models are matched automatically, but this extension does not validate their limits; verify each model's documented context window before enabling it.

If you already set your own context window for a supported model in `models.json`, turning this off restores *your* value, not pi's.

## License

MIT
