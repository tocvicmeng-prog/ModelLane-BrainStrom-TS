# ModelLane-BrainStrom (TS) — Architecture Document (Blueprint)

**Version: v0.3 · Date: 2026-06-15 · Status: DELIVERED (pure-TypeScript in-process port)**

> This blueprint describes the buildable architecture for **ModelLane-BrainStrom** —
> a VS Code extension that runs structured multi-LLM debates (Game-theoretic /
> Critical / Heuristic / Mixed) over a user-chosen knowledge domain, orchestrated by
> a local moderator/referee/scribe. It sits one lineage step below CONSTITUTION.md
> (CONSTITUTION.md §1–§6) and inherits the deliberation-and-inquiry **Unit Cell** atom
> by reference: the Unit Cell THEORY.md/CONSTITUTION.md remain the external source of
> truth for the inherited principles (P1, P2, P5, P8–P11, P16, P17; LD1, LD4, LD7, LD8)
> cited throughout. Lineage: THEORY (Unit Cell, external) → CONSTITUTION →
> **ARCHITECTURE** → ENGINEERING → DASHBOARD.
>
> **Runtime change in v0.3 (the headline).** The v0.1/v0.2 design was *two cooperating
> processes* — a TypeScript extension host and a **Python sidecar** joined by one
> JSON-RPC stdio seam. **That seam is gone.** The Unit Cell engine and the entire
> BrainStrom orchestration layer are now **ported to TypeScript and run IN-PROCESS in
> the single extension-host process.** There is **no Python interpreter, no sidecar
> subprocess, no JSON-RPC envelope, and no Content-Length framing anywhere.** The
> former Python `rpc_server.py` is replaced by an in-process façade,
> **`EngineService` (`src/brainstorm/engineService.ts`)**, whose async methods the
> controller calls with a plain `await`. The **only** subprocess in the whole system
> is the optional, sandboxed **CLI connector** (`codex`/`claude`) spawned through
> `node:child_process`. The pay-off is **end-to-end type safety** (one type system from
> the VS Code API down to the engine internals) and **native async I/O** (`Promise`/
> `async`, no stdio framing, no process to spawn, crash, or version-match).
>
> **Honesty contract (carried verbatim in spirit from the original plan).** The Unit
> Cell engine is *reused with two small additive surfaces* (an `onEvent` hook and the
> `proposeClashSplit` + `objective` config presets) — **not** "untouched" and **not**
> forked further. Streaming is **GROUP-grain + phase-grain via `onEvent`**, **NOT**
> per-seat and **NOT** live-σ_SI. σ_SI is a **diversity** signal, not a quality score.
> Debate modes are **presets over existing engine knobs**, not new machinery. Cost/
> token figures are **estimates**. ">2 debaters inside one group" is now **delivered**
> via the dedicated panel engine (`src/orchestrator/multiDebate.ts`), no longer a
> deferral.
>
> **Properties carried forward from v0.2, with their MECHANISM updated to TS.** Total
> egress containment remains a **PROVEN property via a "trap-client" test**
> (`src/test/totalEgress.test.ts`): the engine's default client constructors throw if
> ever reached, so a missed injected slot fails the test rather than silently bypassing
> the guard. The decomposition stage is still the **bespoke `decompose`** workflow
> (`src/orchestrator/decompose.ts`), **explicitly NOT a `UnitEngine.run()`** — it does
> not inherit Unit Cell guarantees and carries its own proposers, dedup, injection
> guard, and a plan validator. The default debate seats are still **API-backed
> OpenAI (Codex-style persona)** and **Anthropic (Claude-Code-style persona)**; the
> real `codex`/`claude` CLI agents are reachable through a **first-class sandboxed
> CLI-subprocess connector** (`src/orchestrator/connectors/cli.ts`). The moderator is
> still **three logical roles** (intake/decomposition moderator, per-group judge/
> referee, chief scribe/verifier).
>
> **What was ELIMINATED relative to the sidecar design** (stated as removed, not
> migrated): `sidecarManager.ts`; `rpc_server.py`; JSON-RPC 2.0 + Content-Length
> framing; the `session.provisionSecrets` stdio handshake; the Python interpreter
> discovery/bootstrap node; `python/requirements.txt`; the `requests` dependency; the
> numpy concern; the `brainstrom.pythonPath` setting; and Risk **R-PY** (Windows
> Python bootstrap). The corresponding lifecycle states (spawn / handshake / health /
> restart / kill-on-deactivate) are likewise gone — there is no process to manage.

## 1. System Architecture

The system is **one process**: a single TypeScript VS Code extension (the extension
host). It owns all VS Code UX, configuration, secret storage, the live sidebar, the
ported Unit Cell engine, the orchestration layer, the connector layer, and the egress
security boundary. The controlling invariant is unchanged in spirit but stronger in
mechanism: **every model byte flows through the TS connector layer**, so a single
egress guard (`connectors/egress.ts` — `validateEgress` + `makeGuardedFetch`) covers
OpenAI, Anthropic, local OpenAI-compatible endpoints, the sandboxed CLI-subprocess
connector, and `research.ts` alike. There is no second process that could call a
remote LLM "around" the guard, because there is no second process.

```
┌ VS CODE EXTENSION HOST — ONE TypeScript process (no sidecar lane) ─────────────────┐
│ extension.ts (X1):  registerLanguageModelChatProvider('modellane-brainstrom')       │
│                   + registerWebviewViewProvider + commands + deactivate()            │
│                   + constructs the in-process EngineService (no spawn)               │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │ ModelLaneLanguageModelProvider (X2) [E]  (modelLaneProvider.ts)              │   │
│  │   · provideLanguageModelChatInformation(): inject synthetic                  │   │
│  │       "🧠 Brainstorm Debate Model" AFTER the sort (no-delegate kind)         │   │
│  │       — discriminated kind:"brainstrom"; visible with NO local model loaded  │   │
│  │   · provideLanguageModelChatResponse(): BRANCH on kind before delegate       │   │
│  │   · provideTokenCount():               BRANCH on kind before delegate        │   │
│  ├─────────────────────────────────────────────────────────────────────────────┤   │
│  │ EXTENSION GLUE  (src/brainstorm/)                                            │   │
│  │  controller.ts (B1)        chat-turn driver; CONFIRM_PLAN gate; session id   │   │
│  │  engineService.ts (B2)     IN-PROCESS façade: runGroup/runSession/decompose/  │   │
│  │                            executePlan — plain async, emits EngineEvents      │   │
│  │  brainstormViewProvider.ts live board: DAG + group accordions                 │   │
│  │   (B3)                     (CSP-hardened, textContent-only render)            │   │
│  │  adminConsolePanel.ts (B4) seats·roles·modes·connectors·budgets (NO secrets)  │   │
│  │  connectorRegistry.ts (B5) secret-free connector catalog + param builders     │   │
│  │  secrets.ts (B6)           SecretStorage wrapper; keys by connectorId          │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│            │  plain `await engine.<method>(params)`   ▲  `emit(EngineEvent)` to board │
│            ▼                                          │                                │
│  ┌──── ORCHESTRATION  (src/orchestrator/) ───────────┴─────────────────────────┐   │
│  │ decompose.ts (O1)   domain → N debatable points + dependency DAG             │   │
│  │                     (BESPOKE workflow — NOT a UnitEngine.run())               │   │
│  │ scheduler.ts (O2)   DAG → topo waves · Promise.all within a layer ·           │   │
│  │                     BudgetGovernor absolute cap · quarantined context down    │   │
│  │ groupRunner.ts (O3) point + RoleMap + mode → injected UnitEngine.run()        │   │
│  │                     (ALL 7 engine slots injected; NoopKnowledgeEngine when    │   │
│  │                      research OFF — trap-client proven)                       │   │
│  │ multiDebate.ts (O4) N-debater panel engine (>2 debaters in ONE group)         │   │
│  │ chiefScribe.ts (O5) cross-group dedup · contradiction present · report        │   │
│  │ sessionState.ts (O6) redacted per-group persistence under a base dir          │   │
│  │ types.ts (O7) · security.ts (O8)  schemas + wrapUntrusted/detect/redact       │   │
│  │ connectors/ (O9)  base · egress · openai · anthropic · openaiCompatible ·     │   │
│  │                   cli · factory   ← the connector + TOTAL egress guard         │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│  ┌──── UNIT-CELL ENGINE  (src/engine/, ported · 2 additive surfaces only) ──────┐   │
│  │ engine · types · config · agent · judge · harvester · ledger · metrics ·      │   │
│  │ research · budget · embeddings  +  http (FetchLike/fetchJson/HttpError) ·      │   │
│  │ rng (mulberry32 makeRng) · util (sha256hex/estimateTokens/clamp)   [E1/E*]    │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
└──────────────┬─────────────────────────────────────────────────────────────────────┘
               ▼ async fetch (FetchLike → globalThis.fetch), AbortController timeouts
                 HTTPS (remote, allowlisted) / loopback 127.0.0.1 (local) /
                 node:child_process spawn(shell:false) for the CLI connector only
   OpenAI API (Codex-style persona) · Anthropic API (Claude-Code-style persona) ·
   LM Studio / llama.cpp / Ollama · codex/claude CLI subprocess (sandboxed, own login)
```

**Invariant (stated for emphasis):** *every model/embedding/research call is an
`async fetch` built through the connector layer, and every such fetch transits
`validateEgress` (directly, and via `makeGuardedFetch`).* The extension host holds no
ad-hoc HTTP client for model traffic; clients are only ever constructed by connectors,
which validate egress at construction *and* before each client build (§5). This is
what makes the egress guard *total* (ARCHITECTURE.md §5; mapped to control **S5** in
§10 / CONSTITUTION.md §4). The **CLI-subprocess connector** is the one egress family
that does not transit an HTTP guard (it spawns a vetted local agent process rather
than making an HTTP call); its own sandbox controls (no shell, no shell interpolation,
bounded temporary cwd, no secret in argv/env, per-call timeout + output cap, no
file-tool/agent-write unless explicitly enabled) form the equivalent total boundary
for that surface (§5.5; risk R-CLI).

**Hybrid connector policy.** The DEFAULT debate seats are **API-backed**: OpenAI
configured with a **Codex-style coding-agent persona** and Anthropic configured with a
**Claude-Code-style coding-agent persona**. These are ordinary model-API seats wearing
personas — the product does **not** imply that it drives the CLI/agent products by
default. **Additionally**, a sandboxed CLI-subprocess connector (`kind:"cli"`) is a
first-class connector that *does* drive the real `codex`/`claude` CLI agents as
subprocesses via their existing login/OAuth. This satisfies both the API interpretation
(default) and the product interpretation (opt-in CLI) without overpromising.

## 2. Module / Node Table

Tags: **[R]** reuse (inherited ModelLane shell) · **[E]** extend (additive,
backward-compatible) · **[N]** new/ported.

**Node-map convention (replaces the Python N0–N25 sidecar inventory).** The TS module
inventory below *replaces* the former sidecar node list. An `N`-style id scheme is kept
where it aids the DAG and tables, but every id now names a TypeScript module under
`src/`. The build is gated by **`tsc --noEmit` (strict) + the `node:test` suite (181
tests) + the adversarial fidelity audit** — not by per-node gate logs. Critical-path
modules are highlighted in §2.1.

### 2.1 inherited shell (ModelLane, reused)

| Node | Module (`src/…`)            | Responsibility                                                       | Tag |
|------|-----------------------------|----------------------------------------------------------------------|-----|
| R1   | `lmStudioApi.ts`            | LM Studio REST client (model sensing, chat)                          | [R] |
| R2   | `chatPanel.ts`              | side chat panel (inherited)                                          | [R] |
| R3   | `agentRunner.ts`            | inherited agent runner                                               | [R] |
| R4   | `codeActions.ts`            | inherited code actions                                               | [R] |
| R5   | `inlineCompletion.ts`       | inherited inline completion                                          | [R] |
| R6   | `languageModelProvider.ts`  | LM Studio chat-model provider (delegate)                             | [R] |
| R7   | `localModelProvider.ts`     | Ollama/vLLM/llama.cpp/Llamafile probes + providers (delegates)       | [R] |
| R8   | `statusBar.ts`              | inherited status bar                                                  | [R] |

### 2.2 extension glue (BrainStrom shell)

| Node | Module (`src/…`)                       | Responsibility                                                                                  | Tag |
|------|----------------------------------------|-------------------------------------------------------------------------------------------------|-----|
| X1   | `extension.ts`                         | activation; registers the unique `modellane-brainstrom` provider, view, commands; **constructs `EngineService` in-process** (no spawn); wires `emit` → board and `secretsAccessor` → controller; `deactivate()` (no child to reap) | [E] |
| X2   | `modelLaneProvider.ts`                 | inject the synthetic, no-delegate **🧠 Brainstorm Debate Model** AFTER the sort; branch on `kind:"brainstrom"` in `provideLanguageModelChatResponse` **and** `provideTokenCount`; visible with no local model loaded | [E] |
| B1   | `brainstorm/controller.ts`             | chat-turn driver; **CONFIRM_PLAN** multi-turn gate (decompose+propose, then executePlan on approval), keyed by first-message identity; `autoConfirmPlan ⇒` single-turn `runSession`; collects secrets one-shot; saves report under `globalStorageUri` | [N] |
| B2   | `brainstorm/engineService.ts`          | **in-process façade** (replaces `rpc_server.py`): async `runGroup`/`runSession`/`decompose`/`executePlan`; `EngineEvent` emitter; injectable executors                                              | [N] |
| B3   | `brainstorm/brainstormViewProvider.ts` | live board (DAG + group accordions); CSP-hardened, `textContent`-only render                     | [N] |
| B4   | `brainstorm/adminConsolePanel.ts`      | seats/roles/modes/connectors/budgets; API keys via `showInputBox(password)` → SecretStorage; **no secret in the panel** | [N] |
| B5   | `brainstorm/connectorRegistry.ts`      | secret-free connector catalog; `buildSessionParams` / `buildExecuteParams` (snake_case param shaping for the engine) | [N] |
| B6   | `brainstorm/secrets.ts`                | SecretStorage wrapper; `collect(connectorIds)` into the in-memory snapshot                       | [N] |

### 2.3 orchestration (ported `python/brainstrom/` → `src/orchestrator/`)

| Node | Module (`src/orchestrator/…`)          | Responsibility                                                                                                | Tag |
|------|----------------------------------------|---------------------------------------------------------------------------------------------------------------|-----|
| O1   | `decompose.ts`                         | **bespoke** decomposition: domain → N debatable points (atomic + lens kinds) + dependency DAG; cycles resolved here; own proposers/dedup/injection-guard; **NOT a `UnitEngine.run()`** | [N] |
| O2   | `scheduler.ts` (+ `BudgetGovernor`)    | DAG → topo waves; **`Promise.all` within a layer**, sequential across layers; per-layer concurrency cap; absolute token-budget governor; quarantined predecessor context downstream | [N] |
| O3   | `groupRunner.ts`                       | point + RoleMap + mode → injected `UnitEngine.run()`; injects **all 7 engine slots** (total-egress seam); `clientsFromConnectors`; routes >2 debaters to the panel | [N] |
| O4   | `multiDebate.ts`                       | N-debater **panel** engine (>2 debaters in one group), reusing the engine primitives                          | [N] |
| O5   | `chiefScribe.ts`                       | cross-group dedup; contradiction detect+present; enforced-uncertainty Markdown report                          | [N] |
| O6   | `sessionState.ts`                      | `SessionStore`: redacted per-group interim + session-state persistence under a base dir (`globalStorageUri`)   | [N] |
| O7   | `types.ts`                             | KnowledgePoint(Set), DependencyEdge, RoleMap, SeatConfig, GroupSpec, Interim/GroupResult/GroupEvent, ModeProfile, topoLayers/predecessors/hasCycle/validate | [N] |
| O8   | `security.ts`                          | `detectInjection`, `wrapUntrusted`, `quarantinePriorClaims`, `redact`, `NoopKnowledgeEngine`                   | [N] |
| O9a  | `connectors/base.ts`                   | `ConnectorInterface`; `BaseConnector` (OpenAI-compatible); `makeAgentClient`/`makeEmbeddingsClient`; egress validated at construction + each build | [N] |
| O9b  | `connectors/egress.ts`                 | `validateEgress` + `makeGuardedFetch` + IP classification: loopback/private allowed, cloud-metadata blocked, remote needs allowRemote+allowlist+https — **the TOTAL egress guard** | [N] |
| O9c  | `connectors/openai.ts`                 | OpenAI connector (stock `AgentClient`, Codex-style persona seat)                                              | [N] |
| O9d  | `connectors/anthropic.ts`              | Anthropic connector + `AnthropicAgentClient` (overrides only `chat` + `lastUsage`)                            | [N] |
| O9e  | `connectors/openaiCompatible.ts`       | local OpenAI-compatible connector (LM Studio / llama.cpp / Ollama; loopback-default)                          | [N] |
| O9f  | `connectors/cli.ts`                    | **sandboxed CLI-subprocess** connector: drives `codex`/`claude` via their own login; `spawn(shell:false)` + argv list + bounded temp cwd + timeout + output cap; no API key in env | [N] |
| O9g  | `connectors/factory.ts`                | `makeConnector(kind,…)` dispatch incl. `'cli'`                                                                | [N] |

### 2.4 ported Unit-Cell engine (`python/unit/` → `src/engine/`)

| Node | Module (`src/engine/…`)  | Responsibility                                                                                  | Tag |
|------|--------------------------|-------------------------------------------------------------------------------------------------|-----|
| E1   | `engine.ts`              | phase machine (PREP→OPEN→PROPOSE→CLASH→RECOMMEND→CLOSE); `UnitEngine(opts).run(cfg)`; **2 additive surfaces** (`onEvent`, `proposeClashSplit`+`objective`) | [E] |
| E2   | `types.ts`               | engine data model (UnitConfig/UnitResult, Move, RoundScore, enums)                               | [N] |
| E3   | `config.ts`             | `UnitConfig` (+ `proposeClashSplit`, `objective`); `validateConfig`                              | [E] |
| E4   | `agent.ts`               | `AgentClient` (OpenAI-shaped `chat`, overridable); `requestSlips`/`requestMove`; `extractJson`   | [N] |
| E5   | `judge.ts`               | `JudgeEngine` (generative + evaluative split); attack-graph / grounded extension                | [N] |
| E6   | `harvester.ts`           | insight harvest + two extractors                                                                 | [N] |
| E7   | `ledger.ts`              | `IdeaLedger` (dedup/MMR/novelty)                                                                 | [N] |
| E8   | `metrics.ts`             | entropy / σ_SI (diversity), coverage, fixation                                                   | [N] |
| E9   | `research.ts`            | `KnowledgeEngine` (external search OFF by default)                                               | [N] |
| E10  | `budget.ts`              | `BudgetTracker` (per-phase guard, token estimate)                                                | [N] |
| E11  | `embeddings.ts`          | `EmbeddingsClient` (cosine/jaccard fallback, degraded flag)                                      | [N] |
| H1   | `http.ts` (**new**)      | `type FetchLike`, `fetchJson`, `class HttpError` (with `.status`), `httpFetch → globalThis.fetch`; AbortController timeouts | [N] |
| H2   | `rng.ts` (**new**)       | seeded **mulberry32** `makeRng` (reproducible `next`/`shuffle`/`pick`) — replaces Python `random.Random` | [N] |
| H3   | `util.ts` (**new**)      | `sha256hex` (node:crypto), `estimateTokens`, `clamp` — replaces `hashlib`                        | [N] |

### 2.5 ELIMINATED nodes (present in the v0.2 sidecar design, removed in v0.3)

| Removed node                                  | Why it is gone                                                                                  |
|-----------------------------------------------|-------------------------------------------------------------------------------------------------|
| `sidecarManager.ts` (was N15)                 | no subprocess to spawn/health/cancel/restart/kill — the engine is in-process                     |
| `rpc_server.py` (was N12)                     | replaced by the in-process `EngineService` façade (B2)                                            |
| JSON-RPC 2.0 + Content-Length framing (was §4)| no wire protocol — methods are direct async calls; events are `emit(EngineEvent)` callbacks       |
| `session.provisionSecrets` stdio handshake    | replaced by an in-memory `secretsAccessor` closure (B6 → controller snapshot → B2)               |
| Python runtime bootstrap (was N21)            | no interpreter discovery; no `python/requirements.txt`; no `requests`; numpy concern moot         |
| `brainstrom.pythonPath` setting               | removed from `package.json` configuration                                                         |
| Risk **R-PY** (Windows Python bootstrap)      | retired — there is no Python to bootstrap                                                          |

### 2.6 Strict Dependency DAG

The graph is a strict acyclic DAG over TS modules. The ported engine (`engine/*`) is
the leaf; the connector layer (`connectors/base` → providers, all gated by
`connectors/egress`) feeds the group runner (O3). The CLI connector (O9f) depends on
`connectors/base` + `node:child_process` and feeds O3 as an alternative seat builder.
The orchestration converges on the **in-process** façade `engineService` (B2), which
the controller (B1) and `extension.ts` (X1) drive directly. There is **no stdio seam**
— the former Python/TS boundary collapses into a single in-process call edge.

```
                    ┌──────────────── ONE TypeScript process ─────────────────────────┐
                    │                                                                  │
  engine/types ─┬───┼─► engine/{config,agent,judge,harvester,ledger,metrics,           │
                │   │       research,budget,embeddings} ─► engine/engine (UnitEngine)   │
   http ════════╪══►│            ▲ (E* clients injected by O3, never default-built)     │
   rng ─────────┤   │            │                                                      │
   util ────────┘   │   connectors/egress ═╗                                            │
                    │   connectors/base ═══╬═► {openai,anthropic,openaiCompatible} ─┐    │
                    │   connectors/cli ────╝         (validateEgress on build)      │    │
                    │            │                                                  ▼    │
                    │   orchestrator/decompose ─┐                       O3 groupRunner   │
                    │   orchestrator/security ──┤                          │   │         │
                    │            ▼              ▼                          │   ▼         │
                    │   orchestrator/types ─► O2 scheduler ═(Promise.all)═►│  O4 panel   │
                    │            │                  │                      │             │
                    │            │                  ▼                      ▼             │
                    │            └────► O5 chiefScribe ◄──────── group interims          │
                    │                       │                                            │
                    │   O6 sessionState ◄───┘ (redacted persistence)                     │
                    │                       ▼                                            │
                    │   B2 engineService  ◄═(decompose/runSession/executePlan)           │
                    │        ▲   │ emit(EngineEvent)                                     │
                    │        │   ▼                                                       │
                    │   B5 connectorRegistry   B6 secrets ─► B1 controller ─► B3 board   │
                    │        ▲                      ▲             │            ▲          │
                    │        └──────────────────────┴── X1 extension.ts ──────┘          │
                    │                                    └─► X2 modelLaneProvider [E]     │
                    └──────────────────────────────────────────────────────────────────┘
   Build gate spans all gated modules: tsc --noEmit (strict) + node:test (181) +
   fidelity audit. The inherited shell (R1–R8) is reused, not re-gated.
```

**Critical path (TS):**

```
engine/types ═► engine/* ═► orchestrator/* ═► brainstorm/engineService ═►
brainstorm/controller + extension.ts
(engine data model → ported engine + connectors → orchestration →
 in-process EngineService façade → chat-turn controller + activation)
```

This path threads the ported engine and its connectors into per-group execution (O3),
the DAG scheduler (O2), and the synthesis stage (O5), then **directly into** the
in-process `EngineService` (B2) — no stdio crossing — and out to the synthetic-model
provider (X2) and the intake/CONFIRM_PLAN controller (B1). Everything else is
parallelizable around it. The CLI connector (O9f) and the panel engine (O4) are off
the minimal critical path (they extend, not gate, the M1 walking skeleton).

## 3. Engine Lifecycle (no spawn / health / restart)

The engine is a **plain object constructed once in `extension.ts`** during `activate`.
There is **no process to spawn, no handshake, no health poll, no restart, and no
kill-on-deactivate** — those sidecar lifecycle states are eliminated. The full lifecycle
is now an in-process object graph:

```
 EXTENSION ACTIVATE  (extension.ts X1)
        │
        ▼
 ┌─ CONSTRUCT (synchronous, no I/O) ────────────────────────────────────────────┐
 │ board    = new BrainstormViewProvider(extensionUri)                           │
 │ secrets  = new SecretsStore(context.secrets)            // SecretStorage (S1)  │
 │ registry = new ConnectorRegistry(context.globalState)   // secret-free catalog │
 │ controller = new BrainstormController(registry, secrets, context, log)         │
 │ engine   = new EngineService(                                                  │
 │              ev => board.postEvent(ev),     // emit: EngineEvent → live board  │
 │              () => controller.getSecrets()) // secretsAccessor: in-mem snapshot │
 │ controller.setEngine(engine)                // inject the façade back          │
 └───────────────────────────────┬───────────────────────────────────────────────┘
                                 ▼
 ┌─ REGISTER ────────────────────────────────────────────────────────────────────┐
 │ registerWebviewViewProvider(board) · registerLanguageModelChatProvider(         │
 │   'modellane-brainstrom', modelLaneProvider) · commands (openBoard / configure) │
 │ modelLaneProvider.setBrainstormHandler((msgs,_o,progress,token) =>              │
 │   controller.run(msgs, progress, token))    // chat turn → controller          │
 └───────────────────────────────┬───────────────────────────────────────────────┘
                                 ▼
 ┌─ PER CHAT TURN (controller.run) ───────────────────────────────────────────────┐
 │ 1. secrets snapshot: controller.currentSecrets = await secrets.collect(ids)     │
 │    (one-shot per run, S2 — the in-process replacement for provisionSecrets)      │
 │ 2. autoConfirmPlan ? engine.runSession(params)   // single-turn                  │
 │    : approval-of-pending-plan ? engine.executePlan(params)   // CONFIRM_PLAN run │
 │    : engine.decompose(params)   // propose plan, store pending, await "go"        │
 │ 3. engine methods stream event/* to the board via emit; return a report dict     │
 │ 4. controller writes the Markdown report under globalStorageUri/reports          │
 └───────────────────────────────┬───────────────────────────────────────────────┘
                                 │  user cancels  (vscode.CancellationToken)
                                 ▼
 ┌─ CANCEL (cooperative, coarse) ─────────────────────────────────────────────────┐
 │ controller checks token.isCancellationRequested before each emit/finish;         │
 │ in-flight awaits resolve naturally; no mid-phase kill (engine CLOSE assembles a   │
 │ valid partial UnitResult). There is no remote process to terminate.              │
 └───────────────────────────────┬───────────────────────────────────────────────┘
                                 ▼
 EXTENSION DEACTIVATE  →  dispose inherited panels. No child process exists to reap;
 a live CLI-connector subprocess (if mid-call) is bounded by its own per-call timeout
 and is killed on expiry by the connector itself (§5.5), independent of deactivate.
```

**No version-match, no degraded-mode reconnect.** Because the engine is the same
compiled bundle as the host, there is no protocol/engine version handshake to fail and
no "reconnect notice" to surface — those concerns vanished with the sidecar. A faulty
event sink can never abort a run: every `emit` from the engine's log sink is wrapped in
a `try/catch` that swallows sink exceptions (`engine.ts log()`), preserving engine
purity.

### 3.1 Multi-turn CONFIRM_PLAN gate (controller state)

VS Code's chat provider returns one streaming response per request, but the plan-then-
debate flow is inherently two-turn. `controller.ts` (B1) implements a small,
in-memory state machine keyed on a **stable cross-turn session identity = the
conversation's first user message** (`firstUserText`). The pending plan is held in a
`Map<sessionKey, {domain, points, edges}>`.

```
STATE (controller.ts B1; one transition per VS Code chat request)

 autoConfirmPlan === true  ───────────────────────────────────────────────┐
   │ single-turn: engine.runSession(buildSessionParams(...))               │
   ▼                                                                       ▼
 ┌ NO PENDING PLAN ┐    decompose this message as the domain:        FINAL_REPORT
 │ engine.decompose │ → store plans.set(sessionKey, {domain,points,edges}) │
 │ stream the plan  │ → reply with formatted plan + "reply **go** to run"  │
 └────────┬─────────┘                                                       │
          ▼ (next turn, same sessionKey)                                    │
 ┌ PENDING PLAN + approval text ("go|run|proceed|yes|…") ┐                  │
 │ engine.executePlan(buildExecuteParams(...stored...))  │ ─────────────────┘
 │ plans.delete(sessionKey)                              │
 └───────────────────────────────────────────────────────┘
   (a non-approval next turn is treated as a refined domain → re-plan)
```

If decomposition yields `< 2` points or any validation problem, the controller does
**not** proceed: it reports the problem and asks for a broader/narrower topic
(matching the engine's floor of 2 points). The closing chat response is the redacted
Markdown report, also saved to disk (§9).

## 4. In-process EngineService API (replaces the sidecar protocol)

There is **no JSON-RPC and no Content-Length framing.** The former RPC methods are now
**direct async methods** on `EngineService`; the former `event/*` notifications are now
plain `EngineEvent` objects forwarded to the live board through an injected `emit`
callback.

### 4.1 Construction

```ts
// engineService.ts
export interface EngineEvent { method: string; params: any }
export type EmitEngineEvent = (event: EngineEvent) => void;
export type SecretsAccessor = () => Record<string, string>;   // connectorId -> api key (in-memory)

export class EngineService {
  constructor(
    emit: EmitEngineEvent,            // EngineEvent → live board (wired in extension.ts)
    secretsAccessor: SecretsAccessor, // in-memory provisioned secrets (S2)
    executors: EngineServiceExecutors = {},  // injectable for tests (no network)
  ) { /* … */ }
}
```

`secretsAccessor` is the **in-memory replacement for the stdio secrets handshake**: it
returns the snapshot the controller collected one-shot from SecretStorage at the start
of the run (`controller.getSecrets()`), read into memory only while a session runs and
never serialized.

### 4.2 Async methods (former RPC methods)

| Method (async)                       | Params (snake_case dict, from `connectorRegistry`)                                  | Returns (dict)                                   | Notes |
|--------------------------------------|-------------------------------------------------------------------------------------|--------------------------------------------------|-------|
| `runGroup(params)`                   | `{connectors, role_map, point, mode, session_id, research_enabled, allow_remote}`    | `interimConclusionToDict(...)` or `{group_id, error}` | one group; builds guarded clients, runs one `UnitEngine.run()` |
| `decompose(params)`                  | `{domain, connectors, role_map, max_points, session_id, allow_remote, …}`            | `{points:[{id,text,kind,rationale}], edges:[{src,dst,kind}], problems:[…]}` | domain → points + DAG (NO debates); TS holds the plan |
| `executePlan(params)`                | `decompose params + {points, edges}` (the approved plan)                             | report dict (`{domain, mode, markdown, …}`) or `{error, problems}` | runs debates for an already-approved plan |
| `runSession(params)`                 | `decompose params (no points/edges)`                                                 | report dict, or `{error, problems, points}`      | decompose + execute in ONE call (single-turn / `autoConfirmPlan`) |

Each public method calls its injectable executor with `(params, this.secretsAccessor(),
this.groupEmit())`. The default executors are exported for wiring/tests:
`defaultExecutor` / `defaultDecomposeExecutor` / `defaultExecuteExecutor` /
`defaultSessionExecutor`, wrapping the shared helpers `buildConnectors` /
`roleMapFromParams` / `psetFromParams` / `decomposeImpl` / `executeImpl`.

### 4.3 The EngineEvent stream (replaces `event/*`)

The orchestrator emits `GroupEvent`s; `EngineService.groupEmit()` bridges each to an
`EngineEvent` (`{ method: \`event/${event.kind}\`, params: groupEventToDict(event) }`)
and forwards it to the board. The `kind` strings are preserved from the sidecar design:

| EngineEvent `method`        | Payload (sketch)                                                   | Grain |
|-----------------------------|-------------------------------------------------------------------|-------|
| `event/decompose.progress`  | `{stage, proposer?}` (`enumerate`/`edges`/`cycle-resolved`/`rejected-injection`) | decompose ticks (bespoke) |
| `event/decompose.points`    | `{points:[{id,text,kind}], edges:[{src,dst,kind}]}`               | decompose result |
| `event/schedule.plan`       | `{layers:[[pointId]], points:[{id,kind}]}`                        | schedule (group grain) |
| `event/group.start`         | `{point, kind, mode}` (panel adds `debaters`)                     | group grain (native) |
| `event/group.phase`         | `{action, phase, description?}` (PREP/OPEN/PROPOSE/CLASH/RECOMMEND/CLOSE ticks) | **phase grain via `onEvent`** |
| `event/group.interim`       | `interimConclusionToDict(...)` (incl. `participation`, `sigmaSi`) | group grain (on `run()` return) |
| `event/group.error`         | `{error}`                                                         | group grain |
| `event/budget`              | `{stopped, reason, spent}` (BudgetGovernor)                       | session grain (absolute cap) |
| `event/aggregate.progress`  | `{stage:"done", groups_run, groups_failed}`                      | chief scribe — **status labels ONLY** |

**Honest streaming granularity.** `group.start`/`group.interim`/`schedule.plan`/
`budget` are **native group/session grain**, driven by the orchestrator *between*
`UnitEngine.run()` calls. `group.phase` is **phase grain**, plumbed from the engine's
single log sink (`engine.ts log()`) through the `onEvent` hook (§8.4). **Per-seat
micro-progress and live mid-run σ_SI are NOT emitted** — σ_SI is computed at CLOSE and
surfaced per group inside `group.interim` as a **diversity** signal (R-STREAM in §10).
`aggregate.progress` emits **status labels only** — never draft report content,
intermediate scribe reasoning, or candidate report text; only the **final report**
(§6 stage [7]) is returned as the method result.

### 4.4 Budget & cancellation (in-process)

- **Absolute session budget governor.** `BudgetGovernor(maxTotalTokens)` (`scheduler.ts`)
  accumulates each completed group's `totalTokens` and **stops scheduling new groups**
  once the cap is reached, emitting `event/budget {stopped:true}` (cost-DoS control,
  R-COST/S9). This is the absolute ceiling above the engine's per-round
  `BudgetTracker`.
- **Per-call timeout at the I/O level.** Every model/embedding/research call is an
  `async fetch` with an `AbortController` timeout (`http.ts fetchJson`, default 60 s;
  the engine passes `timeout*1000`). The CLI connector adds its own per-call timeout
  and output cap and **kills** a hung subprocess (§5.5).
- **Fail-fast on 4xx.** `HttpError` carries `.status`; the agent/anthropic retry loops
  retry **only** network/timeout + 5xx (with backoff), and a 4xx throws immediately —
  matching Python's `raise_for_status` placement.
- **Cooperative cancel (coarse).** The controller checks the VS Code
  `CancellationToken` before each emit/finish; in-flight awaits complete and the engine
  CLOSE phase always assembles a valid partial result. There is no remote process to
  forcibly terminate.

## 5. Connector Abstraction

The connector layer is the single mechanism that makes the egress guard total: the
ported engine's `build()` (`engine.ts`) constructs a default client for a slot **only
when one is not injected**. **BrainStrom injects a connector-built client for every
slot** — `agentA`, `agentB`, `judge`, `embeddings`, `research`, and the harvester (with
its two extractors) — so the engine **never constructs an unguarded client** (§5.3,
§6). Every client therefore routes through `validateEgress` (O9b) at construction and
before each build. **This is a PROVEN property**: the trap-client test
(`src/test/totalEgress.test.ts`) patches the engine's default constructors to throw and
asserts a group still runs, so a missed slot fails the test rather than silently
bypassing the guard (cross-ref ENGINEERING.md adversarial test matrix).

### 5.1 ConnectorInterface (TS)

```ts
// connectors/base.ts
export interface MakeAgentClientArgs {
  model: string; temperature?: number; systemPrompt?: string;
  modelFamily?: string; agentLabel?: string;
}
export interface ConnectorInterface {
  kind: string;                                   // "openai" | "anthropic" | "openai-compatible" | "cli"
  makeAgentClient(args: MakeAgentClientArgs): AgentClient;
  capabilities(): ConnectorCapabilities;          // {kind, supportsSystemPrompt, streaming:false}
}

// connectors/egress.ts
export function validateEgress(
  baseUrl: string, allowRemote?: boolean, allowlist?: ReadonlySet<string>,
): void;  // throws EgressError on: no host; cloud-metadata host; remote while !allowRemote;
          // off-allowlist remote; plain-HTTP remote. Loopback/private/link-local always allowed.
export function makeGuardedFetch(
  inner?: FetchLike, allowRemote?: boolean, allowlist?: ReadonlySet<string>,
): FetchLike; // wraps a FetchLike so every request URL is validateEgress-checked before the network.
```

`BaseConnector` (the OpenAI-compatible base) also exposes `makeEmbeddingsClient(args)`
— used by the group runner to build the egress-guarded embeddings slot. Both
`makeAgentClient` and `makeEmbeddingsClient` re-run `validateEgress` on every build, so
a config change since construction cannot open a hole.

### 5.2 Adapters

```ts
// OpenAI-compatible base (LM Studio / llama.cpp / Ollama; loopback-default)
class BaseConnector implements ConnectorInterface {
  kind = 'openai-compatible';
  constructor(connectorId, baseUrl, { apiKey, allowRemote=false, allowlist, timeout=120, maxRetries=2 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    validateEgress(this.baseUrl, this.allowRemote, this.allowlist);   // fail fast (S4/S5)
  }
  makeAgentClient(args) {
    validateEgress(this.baseUrl, this.allowRemote, this.allowlist);    // re-validate each build
    return new (this.clientCls())({ endpoint:this.baseUrl, apiKey:this.apiKey, …args });
  }
}

class OpenAIConnector extends BaseConnector {            // kind = "openai" (Codex-style persona seat)
  // remote by nature; allowlist (api.openai.com) + https still enforced by egress.
}

class AnthropicConnector extends BaseConnector {         // kind = "anthropic" (Claude-Code-style seat)
  override kind = 'anthropic';
  constructor(opts) { super(connectorId, baseUrl ?? 'https://api.anthropic.com/v1',
                            { ...opts, allowRemote: opts.allowRemote ?? true }); }
  protected override clientCls() { return AnthropicAgentClient; }
}

class AnthropicAgentClient extends AgentClient {
  // Overrides ONLY chat() (+ populates lastUsage). speak/requestSlips/requestMove all
  // funnel through chat(), so nothing else changes. Messages API: POST {endpoint}/messages,
  // x-api-key + anthropic-version, system separated out, max_tokens required,
  // reads content[].text + usage.input_tokens/output_tokens. Retries only 5xx + network/timeout.
}
```

The Anthropic override **also applies to the harvester's second extractor** when that
seat resolves to an Anthropic connector — the verifier-family ≠ author rule (LD8;
control S10) is satisfied by binding a verifier to a different provider family from the
authoring agents (`engine.ts verifyInsights` enforces a disjoint verifier family).

**Default-seat naming.** The two DEFAULT debate seats are the **OpenAI (Codex-style
persona)** seat and the **Anthropic (Claude-Code-style persona)** seat — both ordinary
API connectors above, configured with a coding-agent persona system prompt. The names
are persona labels; the product does **not** drive the CLI products in the default
path.

### 5.3 Client-injection mechanism (the total-egress guarantee)

```ts
// groupRunner.ts — clientsFromConnectors(roleMap, connectors, { researchEnabled })
const ca = connectors[roleMap.agentA.connectorId];
const cb = connectors[roleMap.agentB.connectorId];
const cj = connectors[roleMap.judge.connectorId];

const agentA = ca.makeAgentClient({ model: roleMap.agentA.model, temperature, systemPrompt: persona, modelFamily, agentLabel:'A' });
const agentB = cb.makeAgentClient({ model: roleMap.agentB.model, … , agentLabel:'B' });
const judgeClient = cj.makeAgentClient({ model: roleMap.judge.model, … , agentLabel:'J' });
const emb   = cj.makeEmbeddingsClient({ model:'nomic-embed-text', cacheDir });   // budgeted egress
const judge = new JudgeEngine({ config:{model,modelFamily,rigorTier}, client: judgeClient, embeddings: emb });
// Harvester extractors are connector-built too: primary = judge client, second = agentB client
// (the engine's intended default mapping, but ALWAYS explicitly injected — never the engine default).
const harvester = new Harvester(judgeClient, emb, agentB);
// research is ALWAYS injected. When external research is OFF (default, S5), inject NoopKnowledgeEngine —
// NEVER let build() construct the default KnowledgeEngine.
const research  = researchEnabled ? new KnowledgeEngine() : new NoopKnowledgeEngine();

return makeGroupClients({ agentA, agentB, judge, embeddings: emb, research, harvester });

// runGroup then constructs:
const engine = new UnitEngine({ agentA, agentB, judge, embeddings, research, harvester, onEvent: sink, rngSeed });
const result = await engine.run(cfg);   // every slot pre-injected → build() never default-constructs.
```

**Correct UnitEngine API (FROZEN).** The ported engine signature is:

```ts
class UnitEngine {
  constructor(opts: {
    agentA?; agentB?; judge?; embeddings?; research?; harvester?;
    rngSeed?: number;
    onEvent?: (e: AuditEvent | Record<string, unknown>) => void | null;  // N1 additive surface
  });
  async run(config: UnitConfig): Promise<UnitResult>;
}
```

Always construct with clients in the **options object** and pass `UnitConfig` to
`run()` only. The clients are injected at construction; the config is per-run.

### 5.4 Seat / Role / Mode / Connector schema (TS)

```ts
SeatConfig    { seatId, connectorId, model, role:'agentA|agentB|judge|harvester',
                persona, temperature, family, order, criticizeFirst, critiqueHarder, collectsReport }
RoleMap       { agentA, agentB, judge, harvester?, debaters? }   // >2 debaters → panel (O4)
GroupSpec     { groupId, point, mode, roleMap?, predecessors, sessionId, priorContext }
KnowledgePoint{ id, text, kind:'atomic|lens', rationale }
DependencyEdge{ src, dst, kind:'requires|informs' }              // requires = hard (order); informs = soft (context)
ConnectorDef  { id, kind:'openai|anthropic|openai-compatible|cli', base_url, allow_remote, …extra }
                // NO secret in the def; key in SecretStorage by id; cli carries NO key (own login)
ModeProfile   { maxRounds, proposeClashSplit:[number,number], objective, rigorTier, generatorTemp, verifierTemp }
```

**Three logical moderator roles.** The single underlying "moderator" is split into
three logical roles recorded in provenance with model family: **(1) intake/
decomposition moderator** (drives §3.1 + the bespoke `decompose` O1), **(2) per-group
judge/referee** (the engine `judge` slot per group), **(3) chief scribe/verifier** (O5
cross-group synthesis). One underlying model **may** fill multiple logical roles
provided provenance records which model/family served which role; **different-family
verification is preferred where feasible** (extends P5/LD8; S10/S11).

**Pairing & participation (honesty).** The default pairing is **two seats debate each
point** (`pair-per-point`); `all-pairs-per-point` and `tournament-per-point` are
modelled in `PairingPolicy` for future use. For **every** group the system reports
which model families participated (`InterimConclusion.participation`, carried in
`event/group.interim` and the report's per-point metrics) so the "multiple models"
promise is honest about per-point coverage. **>2 debaters in one group is delivered**
by the panel engine (O4), routed automatically when a RoleMap carries `> 2` debater
seats.

### 5.5 CLI-subprocess connector (`kind:"cli"`, `connectors/cli.ts`)

```ts
class CliConnector {                       // kind = "cli"  (built by factory.makeConnector('cli', …))
  constructor(connectorId, { command, promptVia='stdin', cwd=null, timeout=120,
                             maxOutputChars=100_000, envPassthrough=null, allowFileTools=false }) {
    this.command = Array.isArray(command) ? command : tokenizeCommand(command);  // shell-free tokenizer
  }
  makeAgentClient(args) { return new CliAgentClient({ command:this.command, promptVia:this.promptVia,
                            cwd:this.cliCwd, timeout:this.cliTimeout, maxOutputChars:this.maxOutput,
                            envPassthrough:this.envPassthrough, …args }); }
  makeEmbeddingsClient() { return new EmbeddingsClient({ mockVectors:{} }); }   // no embeddings over CLI (lexical only)
}

class CliAgentClient extends AgentClient {  // overrides ONLY chat()
  protected override async chat(messages, _temperature) {
    const argv = […this.command, …(promptVia==='arg' ? [prompt] : [])];
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,                         // S3: no shell, no interpolation — argv list only
      cwd: this.cliCwd ?? os.tmpdir(),      // bounded temp cwd (never the workspace)
      env: this.env(),                      // inherits user env so the CLI finds its OWN login;
                                            //   BrainStrom API keys are NEVER placed in env
      stdio: ['pipe','pipe','pipe'],
    });
    // per-call timeout → SIGKILL on expiry; hard output cap; ENOENT → clear "CLI not found".
  }
}
```

**CLI controls (FROZEN, R-CLI):** `spawn(shell:false)` with an **argv list** (no shell
interpolation); **bounded/temporary cwd** (the OS temp dir by default, never the
workspace); **inherits the user environment** so the CLI uses its own stored login —
**no BrainStrom-managed API key is ever placed in argv or env** (keys live in
SecretStorage); **per-call timeout** kills a hung CLI on expiry; **hard output cap**
truncates runaway output; single-shot "print" invocation only (`allowFileTools`
defaults to false; the temp cwd bounds any stray writes). This is the equivalent total
boundary for the one egress family that does not transit the HTTP guard (§1 invariant
note). The CLI reports no token usage, so the engine's estimator handles its budget.

## 6. Data Flow (per stage)

```
[1 INTAKE / TURN]  controller.ts (B1) reads the latest user message as the domain.
            autoConfirmPlan ? single-turn → [stage 5]; else propose the plan first.
            Secrets snapshot collected one-shot (S2) before any engine call.
                  │
                  ▼
[2 DECOMPOSE]  decompose.ts (O1) — the BESPOKE decomposition (NOT a UnitEngine.run();
            does NOT inherit Unit Cell guarantees): ENUMERATE (each proposer suggests
            points) → DEDUP + sanitize (detectInjection isolates/skips injected text,
            never makes it a point) → emit TWO kinds (atomic + lens) → EDGES (moderator
            proposes a DAG over the given ids) → resolveCycles (drop REQUIRES edges until
            acyclic) BEFORE returning, so the plan shown == the plan executed.
            → engine.decompose(params)   ⇢ event/decompose.progress, event/decompose.points
                  │
                  ▼
[3 CONFIRM_PLAN]  controller stores the pending {domain,points,edges} keyed by the
            first-message identity; replies with the formatted plan + "reply **go**".
            On approval → [stage 5] via executePlan; EXECUTED PLAN == APPROVED PLAN.
                  │
                  ▼
[4 SCHEDULE]  scheduler.ts (O2) — KnowledgePointSet.topoLayers() (Kahn over REQUIRES
            edges) → same-layer groups run via Promise.all (capped by maxConcurrency),
            cross-layer sequential; each downstream group gets its predecessors' interims
            as a QUARANTINED "prior claims" block (security.quarantinePriorClaims, Flaw 3);
            BudgetGovernor stops scheduling at the absolute cap.
            → (inside runSession/executePlan) ⇢ event/schedule.plan   (GROUP grain)
                  │
                  ▼
[5 GROUP_RUNNER]  groupRunner.ts (O3) — per group: point + RoleMap + mode →
            modeProfile() → UnitConfig → clientsFromConnectors → injected
            UnitEngine.run(). ALL 7 engine slots injected (agentA, agentB, judge,
            embeddings, research[Noop when OFF], harvester primary + second extractor) —
            proven by the trap-client test. >2 debater seats route to the panel (O4).
            → engine.runSession/executePlan ⇢ event/group.start    (GROUP grain)
                                            ⇢ event/group.phase    (PHASE grain via onEvent)
                                            ⇢ event/group.interim  (GROUP grain, on run() return; + participation)
                                            ⇢ event/group.error    (GROUP grain)
                                            ⇢ event/budget          (session grain; absolute cap)
                  │
                  ▼
[6 CHIEF_SCRIBE]  chiefScribe.ts (O5) — cross-group dedup of validated key points,
            contradiction/uncertainty PRESENTED (not auto-resolved), per-point conclusions
            in topological order (each with a mandatory Flagged-candidates block),
            "What we are NOT sure about", provenance & metrics. The exec synthesis prompt
            is built with a single-pass regex replacer (no $-sequence / sequential-bleed bug).
            → engine.<...> aggregate         ⇢ event/aggregate.progress  (status labels ONLY)
                  │
                  ▼
[7 REPORT / PERSIST]  the report dict (brainstormReportToDict) is returned by the engine
            method; controller streams the Markdown to chat AND saves it under
            globalStorageUri/reports/<slug>-<ts>.md. sessionState.ts (O6) can persist
            redacted per-group interims under the session dir (§9).
```

**Total-egress injection at the group seam.** Stage [5] is where the total-egress
guarantee is realized: `groupRunner` injects all seven engine slots for every group, so
no slot is left for the engine's `build()` to default-construct, so no unguarded client
is ever created. This is **proven**, not asserted, by the trap-client test
(`totalEgress.test.ts`).

**Honest streaming granularity at the seam (restated).** Only stage [5] emits at two
grains: `group.*`/`budget` are native group/session grain, while `group.phase` is phase
grain via `onEvent`. There is **no per-seat event** and **no live σ_SI** — σ_SI arrives
inside `group.interim` at CLOSE, labeled a diversity signal. Stage [6] aggregate
progress is **labels only**.

## 7. Reuse-vs-Extend Matrix (ported engine)

For each ported `engine/` module: **PORT-FAITHFUL** (behaviour preserved, used as-is),
**EXTEND** (the one additive surface it receives), or **WRAP** (driven only through
connector-injected clients). The verified-fact column carries the load-bearing ground
truth from the source.

| Engine module    | Stance       | What changes / how it is driven                                                                 | Verified fact (drives the stance) |
|------------------|--------------|-------------------------------------------------------------------------------------------------|-----------------------------------|
| `engine.ts`      | **EXTEND**   | + `onEvent` hook (inside `log()`) and `proposeClashSplit` + `objective` read in `roundPlan()`/config; **2 surfaces only**. Driven via the correct API: `new UnitEngine({agentA,…,onEvent}).run(cfg)` | `log()` appends an AuditEvent then, if `onEvent`, calls it inside a `try/catch` — a faulty sink never aborts a run |
| `types.ts`/`config.ts` | **EXTEND** (data) | `UnitConfig` gains `proposeClashSplit:[number,number]?` and `objective:string?`; both default to current behaviour | `objective` is a LABEL the engine does not act on (honesty) |
| `agent.ts`       | **WRAP**     | stock `AgentClient` (OpenAI-shaped `chat`); `AnthropicAgentClient`/`CliAgentClient` override only `chat`; retries only 5xx + network/timeout, 4xx fails fast (HttpError.status) | `speak`/`requestSlips`/`requestMove` all funnel through `chat()` |
| `judge.ts`       | **WRAP** (PORT-FAITHFUL) | judge client connector-injected; generative/evaluative split unchanged; verifier family ≠ author enforced | injected via constructor; `build()` uses `this._judge ?? default` |
| `harvester.ts`   | **WRAP**     | injected; **both extractors** connector-built and ALWAYS explicitly constructed (primary = judge client, second = agentB client) — never the engine default | harvester code-point length uses spread, not UTF-16 units (fidelity fix) |
| `ledger.ts`      | **PORT-FAITHFUL** | dedup/MMR/novelty used as-is by the engine; chief scribe reuses the concepts at session scope | embeddings client injected, never constructed by the engine |
| `metrics.ts`     | **PORT-FAITHFUL** | σ_SI computed at CLOSE; surfaced per group as a **diversity** signal                            | σ_SI is a diversity metric (LD4), not a quality score |
| `research.ts`    | **WRAP**     | `KnowledgeEngine` injected; external search **OFF by default** → inject `NoopKnowledgeEngine`, never the default | `NoopKnowledgeEngine.routeSearch` returns `''` (zero network) |
| `budget.ts`      | **PORT-FAITHFUL** | per-round guard reused; `BudgetGovernor` (O2) adds an absolute cap above it                     | guarded at PROPOSE/CLASH round boundaries (cancel latency = up to one round) |
| `embeddings.ts`  | **WRAP**     | connector-injected; cosine/jaccard fallback + `degraded` flag preserved; cache dir set under `globalStorageUri` (never the repo) | only the connector holds the secret; cache path is caller-set |

**Bespoke decomposition vs Unit Cell.** The decomposition stage (O1) is **NOT** in this
matrix because it is **not a Unit Cell run** — it is the bespoke `decompose` workflow.
It does not inherit Unit Cell guarantees (phase machine, σ_SI, ledger semantics,
per-round budget guard); it carries its own proposers, dedup, injection guard, and a
plan validator (`KnowledgePointSet.validate`). It may reuse ledger *concepts*
(dedup/MMR) but it never calls `UnitEngine.run()`.

**Verified cross-cutting facts.** The opener **alternates by design** (Thue-Morse:
`thueMorseOrder(n)` = parity of `popcount(k)` per round) → "who critiques first" is an
opening-order *tendency*, documented honestly (R-OPENER; CONSTITUTION.md §6).
**Token/cost numbers are estimates** — `chargeAgent` uses provider `lastUsage` else
`BudgetTracker.estimateTokens`, often zero for non-conformant endpoints. Determinism is
provided by the **seeded mulberry32 RNG** (`rng.ts makeRng`) replacing Python
`random.Random`, and **node:crypto SHA-256** (`util.ts sha256hex`) replacing `hashlib`.

## 8. Key Algorithms (pseudocode, TS)

### 8.1 Decomposition + DAG build + cycle resolution

```ts
// decompose.ts — BESPOKE workflow (NOT a UnitEngine.run()).
async function decompose(domain, { proposers, moderator, maxPoints=6, emit }) {
  const raw = [];
  for (const pr of proposers) {                         // 1. ENUMERATE
    try {
      const out = await pr.speak([{ role:'user', content: PROPOSE_PROMPT.replace('{domain}', domain) }]);
      const parsed = extractJson(out);                  // tolerant JSON parse
      if (Array.isArray(parsed)) for (const x of parsed) if (isPlainObject(x)) raw.push(x);
    } catch { /* one proposer failing must not abort decomposition */ }
  }
  const seen = new Set(), points = [];
  for (const item of raw) {                             // 2. DEDUP + sanitize (DATA-only, F11)
    const text = String(item.text ?? '').trim(); if (!text) continue;
    if (detectInjection(text)) { emit('decompose.progress', {stage:'rejected-injection'}); continue; }
    const key = norm(text); if (seen.has(key)) continue; seen.add(key);
    const kind = String(item.kind).toLowerCase() === 'lens' ? PointKind.LENS : PointKind.ATOMIC;
    points.push(makeKnowledgePoint({ id:`p${points.length+1}`, text:text.slice(0,300), kind, rationale }));
    if (points.length >= maxPoints) break;
  }
  const pset = new KnowledgePointSet(points, []);
  if (moderator && points.length >= 2) {               // 3. EDGES (only given ids; src≠dst)
    const parsed = extractJson(await moderator.speak([{ role:'user', content: EDGES_PROMPT.replace('{points}', json(points)) }]));
    if (Array.isArray(parsed)) for (const e of parsed)
      if (validEdge(e, ids)) pset.edges.push(makeDependencyEdge({ src:e.src, dst:e.dst, kind:edgeKind(e) }));
  }
  resolveCycles(pset, emit);                            // 4. acyclic BEFORE return (CONFIRM_PLAN == executed)
  emit('decompose.points', { points: pset.points, edges: pset.edges });
  return pset;
}

function resolveCycles(pset, emit) {                    // drop REQUIRES edges (last-added first) until acyclic
  while (pset.hasCycle()) {
    const req = pset.edges.filter(e => e.kind === EdgeKind.REQUIRES);
    if (req.length === 0) break;                        // a soft-only cycle does not gate order
    const dropped = req[req.length - 1];
    pset.edges.splice(pset.edges.findIndex(e => sameEdge(e, dropped)), 1);
    emit('decompose.progress', { stage:'cycle-resolved', dropped:`${dropped.src}->${dropped.dst}` });
  }
}
```

`KnowledgePointSet.validate()` (the plan gate) returns a problem list (empty == valid):
duplicate ids, `< 2` points (floor), empty text, invalid kind, edges referencing
unknown points, invalid edge kind, and a residual REQUIRES cycle. The controller blocks
CONFIRM_PLAN on any problem.

### 8.2 Scheduler — topological waves + Promise.all + absolute budget cap

```ts
// scheduler.ts
async function runSession(pointSet, runOne, { emit, maxConcurrency=4, budget }) {
  const layers = pointSet.topoLayers();                 // Kahn over REQUIRES edges
  const leftover = pointSet.points.filter(p => !placed(layers, p.id)).map(p => p.id);
  if (leftover.length) layers.push(leftover);           // any soft-cycle remainder gets one final layer
  emit('schedule.plan', { layers, points: pointSet.points.map(p => ({id:p.id, kind:p.kind})) });

  const results = new Map();
  for (const layer of layers) {
    if (budget?.exhausted()) { emit('budget', {stopped:true, reason:'absolute token budget exhausted', spent:budget.spent}); break; }
    // Build each point's quarantined predecessor context from completed upstream interims.
    const tasks = layer.map(pid => [pid,
      pointSet.predecessors(pid)
        .map(src => results.get(src))
        .filter(r => r?.interim?.summary)
        .map(r => quarantinePriorClaims(r.interim.summary, r.groupId))
        .join('\n\n')]);
    const workers = Math.max(1, Math.min(maxConcurrency, tasks.length));
    // Parallel WITHIN the layer (bounded worker pool over Promise.all); sequential across layers.
    await runLayer(tasks, runOne, workers, (pid, res) => {
      results.set(pid, res);
      if (budget && res.unitResult) budget.charge(res.unitResult.totalTokens ?? 0);
    });
  }
  return pointSet.points.filter(p => results.has(p.id)).map(p => results.get(p.id));  // point order
}
```

A per-group failure is isolated into a `GroupResult.error` (the worker `try/catch`),
never aborting the layer (mirrors the former thread-pool `as_completed` semantics).

**Mixed-mode routing.** Modes are **presets over existing engine knobs, not new
science**; `objective` is a label. `modeProfile(mode, pointKind)` routes **Mixed**
(default) by point kind: `lens → heuristic`, `atomic → critical`. The canonical preset
table (Critical / Heuristic / Game-theoretic, with `maxRounds` / `proposeClashSplit` /
`rigorTier` / temps) lives in `orchestrator/types.ts modeProfile()` and is cross-
referenced from CONSTITUTION §Algorithms.

### 8.3 Chief scribe — present-not-resolve + enforced uncertainty

```ts
// chiefScribe.ts
async function aggregate(domain, mode, pointSet, results, { scribe, emit }) {
  const order = topoOrder(pointSet);                    // topological, soft-cycle leftovers appended
  const validated = [], seen = new Set(), candidates = [], perPoint = [];
  for (const pid of order) {
    const r = byGroup.get(pid); if (!r) continue;
    if (r.error || !r.interim) { perPoint.push({ id:pid, status:'failed', error:r.error }); continue; }
    for (const kp of r.interim.validatedKeyPoints) {     // cross-group dedup
      const k = norm(kp); if (!seen.has(k)) { seen.add(k); validated.push(kp); }
    }
    candidates.push(...r.interim.candidateInsights);     // LD7: never silently drop a candidate
    perPoint.push({ id:pid, status:r.interim.evidenceStatus, summary, validated, candidates,
                    sigmaSi, composite, participation });
  }
  // Single-pass replacer so $-sequences / a literal "{points}" in the domain cannot bleed.
  const exec = scribe && validated.length
    ? (await scribe.speak([{ role:'user',
        content: EXEC_PROMPT.replace(/\{domain\}|\{points\}/g, m => m === '{domain}' ? domain : validated.slice(0,8).join('; ')) }])).trim()
    : '';
  return makeBrainstormReport({ domain, mode, markdown: render(/* enforced-uncertainty structure */), validatedKeyPoints:validated, candidateInsights:candidates, perPoint });
}
```

The rendered report **structurally enforces** uncertainty: executive synthesis →
decomposition map → per-point conclusions (each with a mandatory "Flagged candidates
(unverified — kept, not dropped)" block) → cross-cutting findings → "What we are NOT
sure about" → provenance & metrics (σ_SI labeled a diversity signal; "validated" =
survived scrutiny; token/cost = estimates). Per-point participation falls back to
`'n/a'` on an empty join (fidelity fix); a failed group renders its error (a missing
error renders the literal `"None"`, matching the source).

### 8.4 The `onEvent` plumbing through `log()`

```ts
// engine.ts — N1 additive surface (no behaviour change when onEvent is null).
private log(st, action, phase, description) {
  const event = makeAuditEvent({ action, phase, description });
  st.result.auditLog.push(event);                       // UNCHANGED: existing in-mem append
  if (this._onEvent !== null) {                         // NEW: single telemetry chokepoint
    try { this._onEvent(event); } catch { /* a faulty sink must NEVER abort a run */ }
  }
}

// groupRunner binds the sink so engine phase events become group.phase events:
const sink = (ev) => emit?.(makeGroupEvent({
  groupId: spec.groupId, kind: 'group.phase',
  payload: { action: ev.action, phase: ev.phase, description: ev.description },
  sessionId: spec.sessionId,
}));
const engine = new UnitEngine({ …clients, onEvent: sink, rngSeed });
```

Because `log()` is the single sink, one hook yields every already-emitted phase event.
This is **phase grain**, not per-seat; no other engine internals are touched.

### 8.5 Predecessor context — quarantined "prior claims" + seeded shuffle

```ts
// security.ts — downstream groups receive upstream interims as background, NOT truth.
function quarantinePriorClaims(interimSummary, sourcePointId) {
  const body = wrapUntrusted(interimSummary, `PRIOR:${sourcePointId}`);   // delimiter-wrapped DATA
  return `[BACKGROUND — PRIOR CLAIMS from ${sourcePointId}] Use as background, NOT truth. ` +
         `Give at least one reason a prior claim may be wrong. Do not repeat it unless it ` +
         `changes your argument.\n${body}`;
}

// engine.ts — deterministic shuffles + opener alternation (replaces Python random + Thue-Morse).
const rng = makeRng(rngSeed);                            // seeded mulberry32 → reproducible
st.stance = randomizeStances(rng);                      // shuffle AFTER the brief is frozen
st.order  = thueMorseOrder(cfg.maxRounds);              // opener of round k = parity of popcount(k)
```

Model-produced structured outputs are treated as **DATA** (`extractJson` + schema-shape
checks; `detectInjection` isolates known injection patterns). User domain text is
isolated as user-data and never "disqualified". This is the orchestration-tier mirror
of the in-cell adversarial layer (CONSTITUTION P0-8 / F11).

## 9. Persistence & Session Identity

### 9.1 Storage location & layout

Runtime data is written under `context.globalStorageUri` — **never the repo** (there is
no sidecar cwd anymore). The controller saves the closing Markdown report; the
`SessionStore` (O6) persists redacted per-group interims + a session-state snapshot
when used.

```
<globalStorageUri>/
├── reports/
│   └── <domain-slug>-<timestamp>.md      ← closing report (controller.saveReport)
└── sessions/
    └── <session-id>/
        ├── session.json                  ← redacted {session_id, topic, mode, status, groups[]}
        └── interims/
            ├── <group-id>.json           ← redacted InterimConclusion (S8/S14)
            └── …
```

`SessionStore.saveGroupResult` / `saveState` run every written string through
`redact()` (deep over objects), so **no secret can land in a persisted artifact**.

### 9.2 Session identity (controller, in-memory)

Session identity is resolved entirely in-process: the controller keys a pending plan on
a **stable cross-turn identity = the conversation's first user message**
(`firstUserText`), and mints a per-run `sessionId = s-<Date.now()>-<counter>` for
events and persistence. There is no hidden-marker round-trip and no content-hash
fallback to a sidecar's SQLite index — those existed to bridge a stdio process boundary
that no longer exists. Crash-resume in the in-process model reduces to re-running a
turn (the report and any persisted interims survive on disk); a richer
resume-from-disk path can build on `SessionStore` without a protocol.

### 9.3 Redaction & webview safety

`redact(text, secrets)` (O8) replaces every non-empty secret value with
`***REDACTED***` and is applied over persisted session metadata and interim JSON (O6).
Secrets exist **only** in SecretStorage and in the in-memory `secretsAccessor`
snapshot for the duration of a run; they are never serialized, never in argv/env/logs/
reports/exports. The live board (`brainstormViewProvider.ts`, B3) is CSP-hardened —
`default-src 'none'`, nonce-gated `style-src`/`script-src`, **empty
`localResourceRoots`**, no remote content — and renders all model-produced text via
`textContent` (never `innerHTML`). Markdown is rendered as HTML **only** in the saved
report file, never in the webview (S7).

## 10. Security Architecture Cross-Reference

This section maps architectural **seams** to the controls **S1–S16** and risks
**R1–R-STREAM**. Full control text, requirement tiers (P0/P1/P2), and the risk register
live in CONSTITUTION.md §4 (controls + tiers), ENGINEERING.md (the adversarial test
matrix), and DASHBOARD.md (the live risk register). Identifiers here are FROZEN to those
documents; only the *mechanism* column is updated for the in-process TS runtime.

| Architectural seam                                                              | Controls            | Risks               | Where enforced (TS module) |
|---------------------------------------------------------------------------------|---------------------|---------------------|----------------------------|
| Secrets in SecretStorage only; in-memory accessor (no stdio handshake) (§3, §4.1)| S1, S2, S8          | R1, R5              | `secrets.ts` (B6), `engineService` secretsAccessor, `redact` |
| Egress guard: loopback-default + allowlist + https (§1, §5)                       | S4, S5              | R2, R7              | `connectors/egress.ts` (O9b), `connectors/base.ts` (O9a) |
| SSRF / cloud-metadata block (every egress incl. `research.ts`)                  | S5                  | R2                  | `connectors/egress.ts` (METADATA_HOSTS + IP classification) |
| Total-egress injection PROVEN by trap-client test (§5, §6)                        | S5                  | R2, R-EGRESS-BYPASS | `groupRunner.ts` (O3), `test/totalEgress.test.ts` |
| Guarded fetch wrapper (`makeGuardedFetch`) for every FetchLike (§5.1)            | S5                  | R2                  | `connectors/egress.ts` (O9b) |
| CLI-subprocess sandbox (shell:false, argv list, bounded cwd, no key in env, timeout+output cap, no file-tools default) (§5.5) | S3, S5, S8 | R-CLI | `connectors/cli.ts` (O9f) |
| Untrusted-text quarantine (decompose / inter-group / scribe) (§6, §8.1, §8.5)   | S6, S10, S11        | R3                  | `security.ts` (O8), O1, O2, O3, O5 |
| Model outputs DATA-only (extractJson + injection isolate) + quarantined prior-claims (§8.1, §8.5) | S6, S11 | R3 | `security.ts` (O8), O1, O3 |
| User text isolated as user-data, NEVER disqualified (§3.1, §8.5)                 | S6, S11             | R3                  | `security.ts` (O8), B1 |
| Webview hardening: CSP + nonce + empty localResourceRoots + `textContent` (§9.3) | S7, S8              | R6, R8              | `brainstormViewProvider.ts` (B3) |
| Central `redact()` on persisted session-meta / interims (§9)                     | S8                  | R1, R5              | `security.ts` (O8), `sessionState.ts` (O6) |
| Embeddings cache forced under `globalStorageUri`; opaque connector refs (§7, §9) | S8, S14             | R5                  | `connectors/base.ts` (O9a), O6 |
| Absolute budget governor + per-call fetch timeout + 4xx fail-fast (§4.4, §8.2)  | S9, S13             | R4, R-COST          | `scheduler.ts` BudgetGovernor (O2), `http.ts` (H1), O9d |
| Per-call timeout/backoff; retries only 5xx + network/timeout (§4.4)             | S12, S13            | R1, R4              | `agent.ts` (E4), `anthropic.ts` (O9d), `cli.ts` (O9f) |
| Verifier-family ≠ author at group AND scribe; 3 logical moderator roles (§5.2, §5.4, §8.3) | S10, S11 | R3 | `engine.ts verifyInsights` (E1), O9d, O3, O5 |
| Report save-path validated + scrubbed (§9.1)                                     | S14                 | R5                  | `controller.ts` saveReport (B1) |
| Decomposition plan validation before CONFIRM_PLAN (§8.1)                          | S11                 | R-DECOMP            | `decompose.ts` (O1), `KnowledgePointSet.validate` (O7), B1 |
| Synthetic model never touches a (non-existent) delegate (F2)                     | (correctness)       | (correctness)       | `modelLaneProvider.ts` (X2) |
| Streaming-granularity expectations honest (§4.3, §6)                              | (S-none; honesty)   | R-STREAM            | `engine.ts onEvent` (E1), B3 |
| Aggregate progress = labels/status only, never draft content (§4.3, §6)          | (honesty)           | (honesty)           | O5, B2 |
| CI supply chain + workspace re-confirm before remote egress                      | S15, S16            | R7                  | `tsc`+`node:test` gate, X2/B4 (allowRemote opt-in) |

**Risk seeds (FROZEN; full register in DASHBOARD.md).** R1 key-leak → S2/S8 · R2 SSRF/
metadata → S5 · R3 cross-agent injection → S6/S10/S11 · R4 DAG cost-DoS → S9/S13 · R5
secret-in-report/export → S8/S14 · R6 forged webview msg → S7 · R7 workspace-enables-
egress → S4/S16 · R8 stored-XSS → S7/S8 · **R-STREAM** streaming-granularity
expectations → `onEvent` + honest group-grain · **R-CLI** CLI subprocess execution
surface → `cli.ts` sandbox controls (§5.5) · **R-EGRESS-BYPASS** a missed injected slot
reaches the network → trap-client test (O3/`totalEgress.test.ts`) · **R-COST** coarse
cancel / already-started remote spend → absolute BudgetGovernor + per-call fetch
timeouts (O2/H1) · **R-DECOMP** bad decomposition gates the whole run → plan validation
+ CONFIRM_PLAN edit (O1/B1).

**Retired risk.** **R-PY** (Windows Python / deps bootstrap) is **removed** — there is
no Python interpreter, no `requests`, and no numpy in the in-process TS runtime, so the
risk no longer exists.

## 11. Build / Test / Package

- **Compiler.** `tsconfig.json`: `strict`, `module commonjs`, `target`/`lib` `ES2022`,
  `esModuleInterop`, `resolveJsonModule`, `outDir "out"`, `rootDir "src"`,
  `sourceMap true`. `npm run compile` = `tsc -p ./tsconfig.json`.
- **Manifest.** `package.json`: name `modellane-brainstrom-ts`, displayName
  "ModelLane-BrainStrom (TS)", version `0.3.0`, publisher `modellane`,
  `engines.vscode ^1.104.0`, `main ./out/extension.js`, `languageModelChatProviders`
  vendor `modellane-brainstrom`. Settings: `brainstrom.allowRemote`,
  `brainstrom.autoConfirmPlan` (**no `brainstrom.pythonPath`**).
- **Test.** `npm test` = `node --test "out/test/**/*.test.js"` (Node 24 needs the glob,
  not a bare directory; `pretest` runs `tsc`). Tests inject fake `fetch`/clients — zero
  network, zero tokens. **Result: `tsc` strict CLEAN (0 errors); 181 / 181 `node:test`
  pass** — the full former pytest suite ported to `src/test/*.test.ts`.
- **Gate harness (replaced).** The Python gate harness (`verify_gate.py`,
  `.gate_log/*.json`, ruff/pytest/mypy) is **replaced** by: `tsc --noEmit` (strict) +
  the `node:test` suite (181) + the adversarial fidelity audit.
- **Package.** `npx @vscode/vsce package --no-dependencies` ⇒
  `modellane-brainstrom-ts-0.3.0.vsix` (51 files, ~142 KB). Ships `out/**/*.js` + media
  + manifest; **excludes** `src/`, `**/*.ts`, `**/*.map`, `out/test/`.

## 12. Port Fidelity (engineering quality gates + dashboard verification log)

A 10-module adversarial audit was run against the Python source. **Faithful (no
behavioural discrepancies):** `engine`, `judge`, `scheduler`, `metrics`, `ledger`.

**Fixes applied to reach fidelity:**

- egress IPv4 `is_private` parity (added `0.0.0.0/8`, `192.0.0.0/24`, `192.0.2.0/24`,
  `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4`) + IPv4-mapped
  IPv6 reclassification + `2001:db8::/32`;
- chief-scribe exec-prompt built with a single-pass regex replacer (was a `String.
  replace` `$`-sequence + sequential-bleed bug);
- 4xx fail-fast (`HttpError.status`; `agent` + `anthropic` retry only network/timeout +
  5xx);
- judge `pyRepr` renders `True`/`False` + Python-style string quoting;
- harvester code-point length (spread, not UTF-16 units);
- chief-scribe participation falls back to `'n/a'` on an empty JOIN.

**Accepted LOW divergences (parser-driven + safe; documented, not "fixed"):**

- Node WHATWG `URL` normalizes legacy IPv4 literals (decimal/octal/hex) that Python
  `urlparse` leaves raw;
- IPv6 metadata compression differences;
- report per-point metric-key casing (`sigmaSi` vs Python `sigma_si`) in the serialized
  structured field;
- decompose null-text JSON value drops the item (TS) vs becomes the literal `"None"`
  (Python) — TS is the saner behaviour, intentionally not replicated.

## Revision History

| Version | Date       | Author                          | Description                                 |
|---------|------------|---------------------------------|---------------------------------------------|
| v0.1    | 2026-06-14 | architect + scientific-advisor  | Initial draft from approved plan            |
| v0.2    | 2026-06-14 | architect + scientific-advisor  | Incorporate ARCHITECTURE_AUDIT_REPORT findings F1–F16 + workflow-logic flaws 1–6; hybrid connector policy; node convention N0–N25. |
| v0.3    | 2026-06-15 | architect + scientific-advisor  | pure-TypeScript in-process port: engine + orchestration ported to `src/engine` + `src/orchestrator`; Python sidecar/JSON-RPC removed; `EngineService` in-process façade; `tsc` strict CLEAN; 181/181 `node:test`; packaged `modellane-brainstrom-ts-0.3.0.vsix`. |
