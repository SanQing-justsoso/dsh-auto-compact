# dsh-auto-compact

Early automatic conversation compaction for DeepSeek Harness: condense history as soon as measured context pressure reaches a configurable fraction of the routed model's context window — **40% by default** — instead of waiting for the host engine's stock 80% trigger.

## What it does

The host ships `@deepseek-ai/dsh-compaction-basic`, whose automatic path already condenses history at a per-model threshold (default 80% of the window). This plugin moves that threshold earlier and adds a boundary sweep, through three mechanisms:

1. **Policy sync (primary).** The plugin projects its threshold onto the mounted engine's resolved configuration at every step boundary. The engine's own `agent/pre-step` listener then compacts mid-turn at the synced threshold, reusing its native balanced-range selection, summarization, durable commit, and overflow recovery. The sync is idempotent and re-asserts itself, so runtime config edits and engine reloads apply without a restart.
2. **Pressure listener (fallback).** When the engine has automatic compaction switched off (`auto: false`), the plugin drives the engine's public `compactIfNeeded()` pressure path itself at the same threshold.
3. **Idle sweep (boundary guarantee).** On every transition to idle, the plugin measures pressure and — when at or above the threshold — runs the engine's public `compactNow()` (the same entry `/compact` uses). This catches pressure that crossed the threshold after the last step of a turn (a long final assistant message, a large claimed input), and works even with engines that expose no patchable policy.

Everything is feature-detected: a composition without a compaction engine, token meter, or LLM service degrades to logging, and no listener ever breaks a turn. `/autocompact` reports the live threshold, pressure, and last run.

## Install

```bash
dsh plugin --profile desktop add github:SanQing-justsoso/dsh-auto-compact
```

Restart the GUI afterwards. A local path works too, without publishing:

```bash
dsh plugin --profile desktop add /绝对路径/dsh-auto-compact
```

## Configuration

Set through the profile patch (`~/.dsh/profiles/desktop/cordis.patch.yml`) or any config editor:

```yaml
- id: auto-compact
  name: dsh-auto-compact
  config:
    thresholdRatio: 0.4      # compact at 40% of the context window
    headroomTokens: 512      # optional; also moves the summary maxTokens when it followed the old headroom
    modelPolicies:           # optional per-route overrides
      - provider: tokenhub
        model: kimi-k3
        thresholdRatio: 0.3
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; volatile (live-editable). |
| `thresholdRatio` | `0.4` | Window fraction that triggers compaction; must be in (0, 1); volatile. |
| `retainRatio` / `retainTokens` | — | Optional retention override projected onto the engine (one form only; tokens win). `retainRatio` must stay below the tightest effective threshold. |
| `headroomTokens` | — | Optional engine headroom override; a summary `maxTokens` that was defaulted from the old headroom follows it. |
| `cooldownSeconds` | `30` | Minimum seconds between idle-sweep attempts per agent; volatile. |
| `modelPolicies` | `[]` | Exact `{ provider, model, thresholdRatio }` overrides merged over the engine's table; load-time only. |

Misconfiguration fails fast at load, like every other dsh policy plugin.

## How it works

DSH ships two composition shapes, and the plugin resolves the engine for both:

- **Base compositions** (headless, SDK, minimal) mount `@deepseek-ai/dsh-compaction-basic` on the root plane, reachable as `ctx.get("compaction")`.
- **The web/desktop app** mounts the same engine inside an agent preset's isolated group (`isolate: { compaction: true }`), where root-plane consumers cannot see it. Each trigger therefore resolves the agent's own instance through the preset registry's documented `agentPresets.serviceFor(agent, "compaction")` seam first, and the root plane second.

The projected policy lands on the engine's resolved configuration, so the engine's native `agent/pre-step` listener condenses mid-turn at the synced threshold. The sync is idempotent and re-asserts itself on every step, so runtime config edits and engine reloads apply without a restart.

## Choose the threshold

```bash
/autocompact        # status: threshold, engine policy, route, pressure, last run
/autocompact 30     # set the threshold to 30% of the context window
/autocompact 42.5%  # decimals and a trailing % are accepted
```

A set is persisted through the settings seam into the profile patch — the same path the GUI's plugin config form writes — so it survives restarts and applies live to the running engine from the next step. Values outside 1–99, or a threshold at or below a configured `retainRatio`, are rejected with the reason. The Plugins page of the GUI (plugin manager) renders the same fields as a form for `dsh-auto-compact`. A working desktop install reports `engine: policy synced (automatic compaction on; active threshold 40%)` — the command applies the policy before reporting it, so the reading is correct even before the session's first step runs. The host log view shows `auto-compact:` lines when the threshold is armed, when pressure crosses it, and for every compaction the sweep performs. Session logs record each compaction as `compaction/start` → `compaction/summary` → `compaction/end`, with `turn` set for mid-turn compactions and `null` for idle-sweep ones.

## Tests

Offline unit tests with a fake cordis context — no network, no real DSH boot:

```bash
pnpm install   # or: ln -sfn "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules" node_modules
node test/run-test.mjs
```

39 cases cover fail-fast validation, policy projection (threshold, retention single-form, headroom/maxTokens coupling, per-model merge), idempotent re-sync, runtime edits and engine reloads, both compaction triggers, the cooldown/log-growth guards, in-flight serialization, busy/failure classification, disabled and engine-less compositions, isolated-preset engine resolution (the desktop shape), the self-healing status/sweep sync, the `/autocompact [percent]` set path (settings persistence, validation, engine re-sync), and the status command.

Live verification ran both composition shapes against a mock OpenAI-completions server: a base headless profile (root-plane engine) and a preset-isolated profile reproducing the desktop mount (engine inside `isolate: { compaction: true }`, root row disabled). Both showed a mid-turn compaction at ~57% of a 16K window — reachable only through the synced 40% threshold — plus an idle-sweep compaction; an A/B control with the engine at its stock 80% and the plugin off produced zero compactions on the identical conversation.

## License

MIT
