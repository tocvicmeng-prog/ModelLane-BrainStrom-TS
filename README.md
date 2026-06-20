# ModelLane-BrainStrom (TS)

**Multi-LLM moderated brainstorming — game-theoretic, critical, and heuristic debates — inside VS Code. Pure TypeScript, end-to-end typed, fully in-process.**

[![Release](https://img.shields.io/github/v/release/tocvicmeng-prog/ModelLane-BrainStrom-TS?sort=semver&color=success)](https://github.com/tocvicmeng-prog/ModelLane-BrainStrom-TS/releases/latest)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.104-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![node:test](https://img.shields.io/badge/node%3Atest-215%20passing-brightgreen.svg)](#development)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

ModelLane-BrainStrom forks and upgrades [ModelLane](#relationship-to-modellane) with a new
synthetic chat model, **🧠 Brainstorm Debate Model**. Pick it in VS Code Chat, give it a topic,
and a local **moderator/scribe** model orchestrates two or more **debate models** (remote or
local) through a structured debate: it decomposes your domain into debatable knowledge points,
runs a group debate per point (in parallel or in dependency order), and a **chief scribe**
aggregates everything into one savable, uncertainty-honest Markdown report — with live progress
on a sidebar board.

The debate engine is the **Unit Cell** project (a two-agent deliberation-and-inquiry engine);
this edition **ports it, and the whole BrainStrom orchestration layer, to TypeScript** so the
entire system runs *in the extension host* — no Python, no sidecar, no inter-process protocol.

> **Status: v0.6 — audit-hardened, with an intuitive Configure dashboard.** The Unit Cell engine and the BrainStrom orchestration
> (decomposition, scheduling, chief-scribe aggregation, connectors, egress guard, security) are
> ported to in-process TypeScript. The project **compiles clean** (`tsc`, strict) and **packages**
> to an installable `.vsix`. **215 `node:test` tests pass** (the ported pytest suite + audit-hardening regressions).
> The **in-editor runtime acceptance** (running a live debate against your models in VS Code) is
> the remaining manual sign-off.

**Contents:** [How it works](#how-it-works) · [Two functions, one panel](#two-functions-one-panel) · [Architecture](#architecture-in-one-breath) · [Requirements](#requirements) · [Install](#install) · [Quick start](#quick-start) · [Seats](#debate-models--seats) · [Modes](#debate-modes) · [Personas & skills](#personas--skill-files) · [Settings](#settings) · [Commands](#commands) · [Security](#security--privacy) · [Development](#development) · [License](#license)

---

## How it works

```
 You ─ pick "🧠 Brainstorm Debate Model" ─ type a domain
   │
   ▼
 Moderator decomposes the domain → N debatable knowledge points
   (two kinds: atomic propositions + cross-cutting lenses) + a dependency DAG
   │
   ▼
 Scheduler runs a debate GROUP per point:
   • same-layer points in parallel (Promise.all) · dependent points in sequence
   • each group = one Unit Cell debate (two debaters + a judge/referee/scribe)
   • upstream conclusions pass downstream as quarantined "prior claims"
   │
   ▼
 Chief scribe aggregates → one Markdown report
   (executive synthesis · per-point conclusions · cross-cutting findings ·
    "what we are NOT sure about" · provenance & metrics)
   │
   ▼
 Live board streams group/phase progress · report saved to disk
```

Everything except the initial moderator question and the final report streams to the **BrainStrom**
view (activity bar): the points, which group owns which point, the parallel/sequential ordering,
per-group progress, and interim conclusions.

## Two functions, one panel

The activity-bar **ModelLane-BrainStrom** container holds **two views side by side**, and you
click between them:

- **ModelLane: Local LLM Chat** — ModelLane's original capability: chat with your local model
  (LM Studio / Ollama / vLLM / llama.cpp) right in the panel — streaming replies, an **Agent**
  toggle, and one-click code insertion. The same chat also opens as a full editor tab via
  **ModelLane: Open Chat (Editor)**.
- **Brainstorm: Live Board** — the multi-LLM moderated debate board described above.

Each view's title bar has a button to jump to the other, so the two functions are always one
click apart. Local models also appear in VS Code's built-in **Chat model picker** (ModelLane's
language-model provider), next to the synthetic **🧠 Brainstorm Debate Model**.

## Architecture (in one breath)

A **single TypeScript VS Code extension** owns everything — UX, secrets, lifecycle, *and* the
debate engine. There is **no Python sidecar and no JSON-RPC**: the ported Unit Cell engine
(`src/engine/`) and the BrainStrom orchestration (`src/orchestrator/`) run **in-process** behind a
typed `EngineService` (`src/brainstorm/engineService.ts`) that the controller calls with plain
`await`. Every model/embedding/research call is an `async fetch` (injectable for tests) routed
through a single **connector layer** with an egress guard; same-DAG-layer groups run concurrently
via `Promise.all`. Types flow end-to-end from the chat provider through the engine to the report.

This is the pay-off of the port: **end-to-end type safety** (one type system from the VS Code API
down to the engine internals) and **flawless async I/O** (native `Promise`/`async`, no stdio
framing, no process to spawn, crash, or version-match).

See [CONSTITUTION.md](docs/01-architecture/CONSTITUTION.md) for scope and tenets (note: the
governance docs were authored for the original sidecar design; the runtime is now in-process TS).

## Requirements

- **VS Code** ≥ 1.104
- **No Python, no extra runtime** — the engine is bundled TypeScript and runs in the extension host.
- At least one reachable **LLM endpoint**:
  - a local OpenAI-compatible server (e.g. **LM Studio** at `http://localhost:1234/v1`) — works with the default config, **or**
  - **OpenAI** / **Anthropic** API access (requires enabling remote egress + a key, see [Security](#security--privacy)), **or**
  - the **Codex** / **Claude** CLIs driven as sandboxed subprocesses (they use their own login).

## Install

Grab the latest `.vsix` from [**Releases**](https://github.com/tocvicmeng-prog/ModelLane-BrainStrom-TS/releases/latest), then:

```powershell
code --install-extension ".\modellane-brainstrom-ts-0.6.1.vsix" --force
```

Then **Developer: Reload Window**. (Or build the `.vsix` yourself with the [Development](#development) steps.)

## Quick start

1. Start a local model server (e.g. LM Studio with a chat model loaded at `http://localhost:1234`).
2. Run **BrainStrom: Configure** and confirm/adjust the connectors and the three seats
   (`agent_a`, `agent_b`, `judge`). The default targets the local server for all three.
3. Open VS Code Chat → model picker → **Other Models → ModelLane-BrainStrom → 🧠 Brainstorm Debate Model**
   (its own provider group; appears even with no local model loaded).
4. Type the domain or question you want to brainstorm, and send.
5. Open the **BrainStrom** view (activity bar) to watch the live board; the final report is streamed
   to chat and saved as Markdown under the extension's storage.

> **CONFIRM_PLAN:** by default BrainStrom proposes the decomposition plan first and waits for you to
> reply "go" before debating. Set `brainstrom.autoConfirmPlan` to run a session in a single turn.

## Debate models & seats

A session uses three **seats**, mapped onto the Unit Cell engine:

| Seat | Role | Default |
|------|------|---------|
| `agent_a` | debater A | local model |
| `agent_b` | debater B | local model |
| `judge` | moderator / referee / chief scribe | local model |

Each seat is bound to a **connector** (`openai`, `anthropic`, `openai-compatible` local, or `cli`).
The envisioned default debate pair is **OpenAI (Codex-style persona)** + **Anthropic
(Claude-Code-style persona)**, via their APIs *or* via the sandboxed **CLI-subprocess connector**
that drives the real `codex` / `claude` CLIs (which authenticate with their own stored login — no
API key is placed in argv or env). Running **more than two debate models inside a single group** is
supported by the panel engine (`src/orchestrator/multiDebate.ts`).

## Debate modes

Modes are **presets over the engine's existing knobs** (not new science); the objective label is
documentation, not a separate mechanism.

| Mode | Emphasis | Preset |
|------|----------|--------|
| `critical` | flaws & assumptions | longer clash, colder verifier |
| `heuristic` | broad idea space | longer propose, hotter agents, diversity-weighted |
| `game-theoretic` | incentives / strategy | high-rigor, balanced, verify all disputes |
| `mixed` (default) | routed per point kind | atomic→critical, lens→heuristic |

## Personas & skill files

Each seat (and panel debater) has a **persona** — sent to that model as its system prompt. In
**BrainStrom: Configure** you can either:

- **type** a short role description in the persona box, or
- **double-click** the persona box to **load a Markdown skill file** — a `.md`/`.txt` file describing
  how that persona should *think and search* (e.g. "prefer academic databases", "reason from first
  principles", "use analogical / reverse thinking", a specific mathematical method). Typed text and
  the skill file are **combined** into the system prompt; a removable 📎 chip shows what's attached.

A skill file is plain Markdown, optionally with a simple `key: value` front-matter block that is
rendered as directives. See [`examples/skills/first-principles-researcher.md`](examples/skills/first-principles-researcher.md).
Skill files are stored in the extension config (not the OS keychain) — don't put secrets in them.

The Configure panel is organized as a **dashboard**: a left **section rail**
(Setup · Connectors · Seats · Panel · Session · Settings), a **Setup overview** that shows your
debate pipeline at a glance and flags any seat whose connector id isn't defined yet, and a **pinned
save bar** that lights up when you have unsaved changes. Each connector has a **Test** button that
checks reachability (through the egress guard) with a green/red dot; invalid settings are flagged
**inline** on the offending field; and **Draft with local model** turns a plain-English description
into a starting configuration (your local model drafts it; you review before saving). The chat panel
shows the **active model + a connection dot**, an empty state with example prompts, and an inline
error banner when the server can't be reached.

Common fields — **connector id**, **model**, **family** — are dropdowns of recommended values with an
**Other…** option that switches to a free-text box for custom values. Every field also has a **?** help
icon next to its name — click it for what to fill in and the field rules; click again (or press Escape) to close.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `brainstrom.allowRemote` | `false` | Allow BrainStrom to reach non-local model endpoints (OpenAI/Anthropic). Off by default. |
| `brainstrom.autoConfirmPlan` | `false` | Run a session in a single turn (skip the CONFIRM_PLAN approval gate). |

ModelLane's original local-model settings (`lmstudio.*`, `localModels.*`) are retained — see
[Relationship to ModelLane](#relationship-to-modellane).

**One place for everything.** All of the above — plus the `lmstudio.*` / `localModels.*` options —
can be edited inside **BrainStrom: Configure** under **Global settings**, so you rarely need to open
`settings.json`. **Boolean options render as on/off switches**; the rest are text/number/dropdown
fields. Changes are written to your VS Code user settings when you click **Save configuration**.

## Commands

| Command | What it does |
|---|---|
| **BrainStrom: Configure** | Open the admin console — connectors, seats, mode, budget; set API keys (stored in the OS keychain) |
| **BrainStrom: Open Live Board** | Focus the live debate board |

Plus all the inherited ModelLane commands (model sensing, side chat, diagnostics, …).

## Security & privacy

BrainStrom is built local-first and treats model output as untrusted data:

- **Secrets** live only in VS Code **SecretStorage** (OS keychain) — never in settings, logs,
  reports, exports, or any process argv/env. They are read into memory only when a session runs.
- **Egress guard (total)**: loopback/private endpoints are allowed by default; **remote endpoints
  require `brainstrom.allowRemote` + an allowlist + HTTPS**; cloud-metadata addresses are always
  blocked, and hostnames are **resolved and re-checked** before each request (DNS-rebinding defence).
  Every model **and research** call goes through the connector layer / a guarded fetch — proven by a
  "trap-client" test that fails if the engine ever constructs an unguarded client. External research
  is additionally restricted to a fixed allowlist of research-API hosts.
- **CLI connector** runs `shell:false` with an argv list, a per-call timeout and an output cap, and —
  unless `allowFileTools` is enabled — a **fresh throwaway temp working directory that is deleted
  after each call**. It inherits the user environment so the CLI finds its own login, and never
  receives BrainStrom-managed API keys.
- **Prompt-injection defence**: decomposition output, inter-group context, and aggregation inputs
  are wrapped/quarantined; injected "knowledge points" are isolated, not executed.
- **Webviews** are CSP-hardened (`default-src 'none'`, nonce-gated scripts, no remote content) and
  render model text as plain text; Markdown is only rendered in the saved report file.
- **External research** (Wikipedia/Semantic Scholar/etc.) is **off by default** for privacy.

Honesty stances baked into the output: **σ_SI is a diversity signal, not a quality score**;
"validated" means *survived scrutiny*, not *proven true*; token/cost figures are **estimates**.

## Development

```powershell
npm install
npm run compile      # tsc -> out/**/*.js   (strict; emits extension.js + engine/ + orchestrator/)
npm test             # tsc + node --test "out/test/**/*.test.js"   (215 tests; zero network, zero tokens)

# Package a .vsix
npx --yes @vscode/vsce package --no-dependencies
```

Press **F5** in VS Code for an Extension Development Host. Repo layout:

```
src/                    TypeScript extension (forked ModelLane shell)
  extension.ts            activation; builds the in-process EngineService
  modelLaneProvider.ts    injects the synthetic Brainstorm model + response branch
  brainstorm/             engineService (in-process engine facade), controller (CONFIRM_PLAN),
                          brainstormViewProvider (live board), adminConsolePanel, connectorRegistry, secrets
  engine/                 ported Unit Cell debate engine (types, agent, judge, harvester, ledger,
                          metrics, embeddings, research, budget, config, engine, + http/rng/util helpers)
  orchestrator/           ported BrainStrom orchestration (decompose, scheduler, chiefScribe,
                          groupRunner, multiDebate, security, sessionState, types)
    connectors/           base, egress guard, openai, anthropic, openaiCompatible, cli, factory, probe
  test/                   node:test suite (215 tests: ported pytest suite + audit-hardening regressions)
out/                    tsc output (shipped)
docs/01-architecture/   CONSTITUTION · ARCHITECTURE · ENGINEERING · DASHBOARD (authored for the
                        original sidecar design; runtime is now in-process TS)
```

## Project status

| Area | State |
|---|---|
| Unit Cell engine (ported to TS) + additive surfaces | ✅ ported; behavioral tests green |
| Connectors, egress guard, security (TS) | ✅ ported + tested |
| Decomposition · scheduler · chief scribe (TS) | ✅ ported; headless end-to-end test passes |
| In-process `EngineService` (replaces the RPC sidecar) | ✅ built; direct async calls |
| TS extension (model branch, controller, sidebar, admin console) | ✅ compiles |
| CLI connector (Codex/Claude) · multi-debater panel | ✅ ported |
| Packaging (`.vsix`) | ✅ done (`modellane-brainstrom-ts-0.6.1.vsix`) |
| Test suite (`node:test`) | ✅ 215 / 215 pass |
| In-VS-Code runtime acceptance | ⬜ manual (your models + VS Code) |

## Relationship to ModelLane

BrainStrom is a superset of [ModelLane](https://github.com/tocvicmeng-prog/ModelLane): it keeps
ModelLane's unified local-model picker (LM Studio, Ollama, vLLM, llama.cpp, Llamafile), its side
chat panel, and code actions, and adds the Brainstorm Debate Model on top. If you only want the
local-model picker, ModelLane alone suffices.

## License

**GNU General Public License v3.0 or later** (`GPL-3.0-or-later`) — see [LICENSE](LICENSE).
Copyright (C) 2026 Tocvic M. Embeds the Unit Cell engine (same project family), ported to TypeScript.

> **Disclaimer.** This software orchestrates language-model debates for brainstorming and research
> support. Outputs are model-generated and may be wrong; "validated" findings reflect surviving the
> system's scrutiny, not ground truth. Review conclusions before relying on them.
