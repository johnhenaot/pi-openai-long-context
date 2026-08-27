# pi-openai-long-context

Give GPT-5.6 a **1.05M token** memory for one long task, with one command — then have it go back to normal on its own.

## The problem

Pi ships GPT-5.6 Sol, Terra, and Luna with a **272K** context window. That is not a technical limit, it is a price line: OpenAI charges double for input the moment a request goes past 272K tokens. Pi keeps you under it by default.

Sometimes you want the big window anyway — a huge file, a long refactor, a session you would rather not compact. This adds a command for exactly that, and makes sure you never leave it on by accident.

## Install

```bash
pi install git:github.com/johnhenaot/pi-openai-long-context
```

Restart pi, or run `/reload`.

## Use it

While you are on a GPT-5.6 model, type:

```text
/long-context
```

Your window jumps to 1.05M and you get a warning telling you what it will cost. A `⚠` appears in the footer so you always know it is on.

Run `/long-context` again to go back to 272K.

## It turns itself off

This is the whole point. The big window costs real money, so it is never something you can forget about:

| What you do | What happens |
| --- | --- |
| Switch to another model — **any** other model, even Sol → Terra | Back to 272K |
| Start a new session | Back to 272K |
| Restart pi, or `/reload` | Back to 272K |
| Compact (auto or manual) | **Stays on** — the big window is what let you get this far |

Nothing is saved to your settings. Turning it on is always a fresh, deliberate choice.

You will only see `/long-context` in the `/` menu when you are on a GPT-5.6 model, since it does nothing anywhere else.

## What it costs

Once a request goes over 272K input tokens, OpenAI bills **that entire request** at the higher rate — 2× for input and cached input, 1.5× for output. It is not just the tokens above the line.

A rough sense of it, per million tokens of input:

| Model | Normal | Over 272K |
| --- | --- | --- |
| GPT-5.6 Sol | $5 | $10 |
| GPT-5.6 Terra | $2 | $4 |
| GPT-5.6 Luna | $0.20 | $0.40 |

`/cost` stays accurate the whole time — pi already knows both price tiers.

## Only GPT-5.6, only from OpenAI

Nothing else is touched. Other models keep their own context windows, and GPT models served through OpenRouter, Copilot, or Azure are left alone — they bill differently.

If you already set your own context window for a GPT-5.6 model in `models.json`, turning this off restores *your* value, not pi's.

## Contributing

```bash
npm install
npm run check   # type check, then tests
```

Needs Node 24+. No build step.

## License

MIT
