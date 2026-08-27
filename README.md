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
pi install /Users/johnhenao/repos/personal/pi-openai-long-context
```

Local paths are registered in place, not copied. Once this is pushed to a remote, `pi install git:github.com/<user>/pi-openai-long-context` works too.

## Usage

```text
/long-context
```

Run it once to raise every `openai/gpt-5.6-*` model to 1.05M. Run it again to drop back to the built-in window.

The whole model catalogue is patched, so the `/model` picker and any model you switch to afterwards both reflect the current state.

## Scope

- **Only `openai/gpt-5.6-*` models.** Other providers keep their own context windows, including OpenAI-compatible routes that serve GPT models (OpenRouter, Copilot, Azure) — those have their own pricing and are deliberately left alone.
- **Session-scoped.** Every new pi session starts back at the built-in default. This is intentional: a persistent toggle you forgot about changes when compaction fires, letting sessions grow to ~1M tokens at long-context rates. Opting in per session keeps that a deliberate choice.
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
