# pi-openai-long-context

Toggle OpenAI GPT-5.6 models between pi's built-in **272K** context window and OpenAI's **1.05M** maximum, with one command.

## Why

Pi ships GPT-5.6 Sol, Terra, and Luna with a `272000` context window so requests stay inside OpenAI's short-context pricing tier. Raising it normally means hand-editing `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.6-sol": { "contextWindow": 1050000 }
      }
    }
  }
}
```

That works, but it is a per-model edit, it is easy to forget you left it on, and it is a poor fit for the common case: you want the big window for one long task, not forever.

## Install

```bash
pi install git:github.com/johnhenaot/pi-openai-long-context
```

Or register a local checkout in place:

```bash
pi install /Users/johnhenao/repos/personal/pi-openai-long-context
```

## Usage

```text
/long-context
```

Run it while an `openai/gpt-5.6-*` model is active to raise **that model** to 1.05M. Run it again to drop back.

While it is on, the footer shows a `⚠`. Enabling it prints the same style of billing warning pi shows for Anthropic subscription auth.

The command is hidden from the `/` menu unless the active model is a GPT-5.6 one.

## Scope

- **Only `openai/gpt-5.6-*` models.** Other providers keep their own context windows, including OpenAI-compatible routes that serve GPT models (OpenRouter, Copilot, Azure) — those have their own pricing and are deliberately left alone.
- **Bound to one model.** Any model change resets it to the built-in window — including `sol` → `terra`. Coming back means running `/long-context` again.
- **Survives compaction.** Auto and manual compaction keep it on; the raised window is exactly what pushes the compaction threshold out.
- **Never persisted.** No settings are written. Every new session, and every `/reload`, starts at the built-in default.
- **Restores the real built-in value**, so it composes with your own `models.json` overrides instead of clobbering them.

## Cost

Above 272K total input tokens, OpenAI bills the **entire request** at GPT-5.6 long-context rates. Pi's built-in pricing metadata already knows both tiers, so `/cost` stays accurate — but the toggle is a spending decision, not just a limit change.

## Develop

```bash
npm install
npm run check   # tsc --noEmit, then node --test
```

Requires Node 24+ — tests execute TypeScript directly, no build step.

## License

MIT
