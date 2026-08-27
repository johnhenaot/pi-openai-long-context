# pi-openai-long-context

Raise GPT-5.6 from pi's default **272K** context window to OpenAI's **1.05M** maximum, one task at a time.

## Install

```bash
pi install git:github.com/johnhenaot/pi-openai-long-context
```

Restart pi, or run `/reload`.

## Use it

```text
/long-context
```

Toggles the big window on and off for the GPT-5.6 model you are using. A `⚠` in the footer means it is on. The command only appears in the `/` menu on a GPT-5.6 model.

## It turns itself off

Switching models, starting a new session, restarting pi, `/reload` — all of it drops you back to 272K, so you cannot leave it on and be billed for it later. Nothing is saved to your settings.

Compaction is the exception: it keeps the big window, which is the point of turning it on.

## What it costs

Past 272K input tokens, OpenAI bills the **whole request** at its long-context rate — see [OpenAI's pricing](https://platform.openai.com/docs/pricing). On a subscription, that also burns through your quota faster.

## Only GPT-5.6, only from OpenAI

Other models keep their own context windows, and GPT models served through OpenRouter, Copilot, or Azure are left alone — they bill differently.

If you already set your own context window for a GPT-5.6 model in `models.json`, turning this off restores *your* value, not pi's.

## License

MIT
