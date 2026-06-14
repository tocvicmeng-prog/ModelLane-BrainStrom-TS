# ModelLane-BrainStrom (TS) — Constitutional Document

> **Version: v0.3 · Date: 2026-06-15 · Status: DELIVERED (pure-TypeScript in-process port; in-editor runtime acceptance pending)**

> **Lineage.** This document sits second in the governance chain
> THEORY (Unit Cell, external) → **CONSTITUTION** → ARCHITECTURE → ENGINEERING →
> DASHBOARD. It inherits the deliberation-and-inquiry charter of the **Unit Cell**
> (external `chat/docs/01-architecture/CONSTITUTION.md` and `THEORY.md`) and adds
> the constitution for the *orchestration above the cell*: a VS Code extension that
> runs a multi-group LLM brainstorming session over a user-chosen knowledge domain.
> Inherited Unit Cell principles are cited by ID (P#/LD#) with a short gloss and a
> pointer to the external source; their full normative text lives in the Unit Cell
> THEORY.md/CONSTITUTION.md and is **not** restated here. Sibling docs are referenced
> by name and section, e.g. (ARCHITECTURE.md §3).

> **Runtime note (v0.3 — binding).** The original governance set (v0.1/v0.2) described
> a **Python sidecar** spawned by the TypeScript shell and spoken to over JSON-RPC 2.0.
> **That runtime no longer exists.** The Unit Cell engine and the entire BrainStrom
> orchestration layer have been **ported to TypeScript** and now run **in-process,
> inside the VS Code extension host**. There is **no Python, no sidecar subprocess, no
> JSON-RPC, and no Content-Length stdio framing** anywhere in the system. The former
> sidecar facade (`brainstrom/rpc_server.py`) is replaced by an in-process typed facade,
> `class EngineService` (`src/brainstorm/engineService.ts`), whose methods the controller
> calls with plain `await`. The **only** subprocess in the whole system is the optional,
> sandboxed **CLI connector** (`src/orchestrator/connectors/cli.ts`), spawned via
> `node:child_process` to drive the `codex`/`claude` CLIs. Every fact below has been
> updated to this reality; the debate science, honesty stances, security *principles*,
> debate modes, roles, and aggregation logic are unchanged.

---

## 1. Mission Statement

Build **ModelLane-BrainStrom** — a VS Code extension that lets a developer run a
structured, multi-LLM **brainstorming / critical / heuristic / game-theoretic
debate** over a chosen knowledge domain, entirely from inside the editor, and walk
away with one savable, logically-structured Markdown report.

Selecting the synthetic **"🧠 Brainstorm Debate Model"** in VS Code's model picker
launches a session: a **local moderator** privately interviews the user; the
moderator and the debate models **decompose** the domain into a set of debatable
knowledge points and a dependency DAG among them; each point becomes a debate
**group** — exactly **one `UnitEngine.run()`** of the ported **Unit Cell** engine
(BP4) — scheduled in parallel within a DAG layer and sequentially across layers; a
**chief scribe** aggregates every group's conclusions into a single structured
report; and all intermediate activity (except the private intake and the final
report) streams live to a sidebar.

The value proposition is fourfold. **(1) Reuse, not reinvention.** The hard
intellectual work — adversarial deliberation, cardinal scoring, insight capture,
first-principles verification, entropy instrumentation — already exists and is
proven in the Unit Cell; BrainStrom is the *pool layer the Unit Cell deliberately
deferred* (Unit Cell CONSTITUTION §2 "Out of Scope: Multi-unit orchestration"). The
engine is **ported, not forked** — translated faithfully from Python to TypeScript,
with only two additive surfaces (T1). **(2) Honesty over theater.** σ_SI is reported
as a **diversity** signal, not a quality score; "verification" means *survived
first-principles scrutiny*, never "true"; cost figures are labeled **estimates**;
debate modes are **presets** over existing engine knobs, not new science. **(3)
Security by construction.** Every model call — local or remote — flows through a
single TypeScript connector layer + egress guard; secrets live only in VS Code
SecretStorage and are read into engine memory once per run via an in-memory
secretsAccessor, never via argv/env/disk/logs. **(4) One language, one process.** The
whole system is **pure TypeScript running in the extension host** — there is no
interpreter to discover, no subprocess to spawn/crash/version-match, and no wire
protocol to frame. Types flow end-to-end, from the VS Code chat API through the
orchestrator to the engine internals; every I/O is a native `async fetch`.

BrainStrom does **not** fork the engine. The engine is *reused with two small
additive surfaces* (BP1 / §3 T1 / §7.5): an `onEvent` telemetry hook and two
optional `UnitConfig` fields (`proposeClashSplit`, `objective`). Everything else is
orchestration above an unchanged atom.

> **Default debate seats (HYBRID connector policy, BLD9 / F1).** The DEFAULT debate
> seats are **OpenAI (Codex-style persona)** and **Anthropic (Claude-Code-style
> persona)** — ordinary OpenAI- and Anthropic-**API** models configured with
> coding-agent personas. They are **not** the CLI/agent products and the extension
> does **not** drive those CLIs by default; the persona names are labels over API
> seats, stated honestly so no user believes the Codex or Claude Code CLI is being
> executed unless they explicitly enable the **CLI connector**. Additionally, a
> **sandboxed CLI connector** (`src/orchestrator/connectors/cli.ts`,
> `class CliConnector` / `class CliAgentClient`) is a **built, first-class connector
> kind** — no longer a vague deferral — that *can* drive the real `codex`/`claude`
> CLI agents as sandboxed subprocesses via their existing login/OAuth, under the full
> security controls of §2.3 / §3 T3 / BLD9. This resolves the audit's Critical
> Finding 1: the named "Codex + Claude Code" vision is satisfiable two ways —
> API-persona seats by default, real CLI agents when the user opts in.

---

## 2. Scope

BrainStrom is the orchestration tier above the Unit Cell atom. The atom's own scope
(one pair, one session, one standardized `UnitResult`) is fixed by the Unit Cell
CONSTITUTION and is **not** re-litigated here; this section governs the layer that
turns *many* such atoms into a session.

> **Module-inventory convention (replaces the former N0–N25 sidecar node convention,
> F12 / BLD12).** The runtime is no longer a Python sidecar with a `python/unit/` +
> `python/brainstrom/` split. The **binding inventory is now the TypeScript module
> map** (§2.4 below): the ported engine under `src/engine/`, the ported orchestration
> under `src/orchestrator/` (+ `connectors/`), and the extension glue under
> `src/brainstorm/` plus the shell (`src/extension.ts`, `src/modelLaneProvider.ts`).
> Where an N-style id aids the DAG or a table, it now refers to a TS module, **not** a
> Python node; the eliminated nodes are listed explicitly in §2.4. Progress
> denominators and gate counts are no longer "X of 25 sidecar nodes" — they are the
> `tsc --noEmit` strict result plus the **181 / 181** `node:test` suite plus the
> adversarial fidelity audit (ENGINEERING.md, DASHBOARD.md).

### 2.1 In Scope

The **full vision** is built in one program (Locked decision LD-PLAN-3), and as of
v0.3 it is **built end-to-end in TypeScript**:

- **Synthetic "🧠 Brainstorm Debate Model"** — a pseudo-model injected into the
  ModelLane provider's model list (`src/modelLaneProvider.ts`, ARCHITECTURE.md §2) so
  it appears in the picker **unconditionally**, even when no local model is loaded;
  the synthetic entry is injected **after the sort**, and **both** the
  response-generation branch **and** the token-count branch handle it before any
  real-delegate call, because it has **no** delegate (F2, ARCHITECTURE.md §2). It
  surfaces under its own provider group (`languageModelChatProviders` vendor
  `modellane-brainstrom`, package.json).
- **Moderator intake** — a local moderator model privately interviews the user for
  domain, constraints, audience, and **debate mode** (G / C / H / Mixed). This Q&A
  is the *only* multi-turn exchange and is kept **off** the live board (BP10 /
  §3 T5). Session state for the intake is **persisted independently of the chat
  transcript**: the controller keeps the pending decomposition plan keyed on the
  conversation's **first user message** as a stable cross-turn identity
  (`src/brainstorm/controller.ts`); resumable session state lives in
  `src/orchestrator/sessionState.ts`. Hidden chat markers are an **optimization, not
  the source of truth** (F7 / BLD13).
- **Decomposition workflow** — moderator + debate models run a **bespoke decompose
  step** (`src/orchestrator/decompose.ts`; `DECOMP_PREP → ENUMERATE → CRITIQUE →
  DEDUP → RANK → EMIT`, §7.2) that turns the domain into **N debatable knowledge
  points** plus a **dependency DAG**; cycles are resolved **before** the approval gate
  (BP6 / BLD5). Decomposition is **NOT a `UnitEngine.run()`** and does **not** inherit
  Unit Cell guarantees; it carries its own seats, budget, injection guard, and a
  **schema validator** (`KnowledgePointSet.validate()`) for points and DAG edges that
  must pass **before** `CONFIRM_PLAN` (F6 / BLD11). Decomposition yields **two point
  types** (Flaw2 / BP11): **atomic debate points** and **cross-cutting lenses /
  themes** — the latter preserve the broad ambiguity that brainstorming needs and let
  the chief scribe surface cross-point emergent findings.
- **Parallel + sequential DAG execution** — the scheduler
  (`src/orchestrator/scheduler.ts`) maps the DAG to **build waves**: same-layer groups
  run **concurrently with `Promise.all`** under a concurrency cap; cross-layer groups
  run **sequentially**, passing quarantined upstream conclusions downstream as context
  (§7.3, ARCHITECTURE.md §6).
- **Configurable intra-group roles** — R-OPENER, R-CHALLENGER, R-SYNTHESIZER,
  R-REFEREE are **bindings onto the four existing engine slots** (agentA, agentB,
  judge, harvester); no new agents are introduced (§3 T1, §7).
- **Three logical moderator roles** — the single "moderator" function is split into
  **three logical roles** (Flaw1 / BP12): **intake/decomposition moderator**,
  **per-group judge/referee**, and **chief scribe/verifier**. Each role's identity
  and **model family** are recorded in provenance; **different-family verification**
  is enforced wherever feasible (extends inherited P5/LD8). One underlying model
  **MAY** fill multiple logical roles in v0.3 **only if** provenance records it.
- **Chief-scribe aggregation** — cross-group dedup, contradiction **detection +
  presentation** (never auto-resolution), emergent-finding surfacing, into one
  structured report with a mandatory "What we are NOT sure about" section
  (`src/orchestrator/chiefScribe.ts`, §7.4).
- **Live sidebar** — DAG view + per-group accordions render **group-grain** and
  **phase-grain** events as they occur (`src/brainstorm/brainstormViewProvider.ts`,
  §8, ARCHITECTURE.md §3 streaming). Events reach the board as plain `EngineEvent`
  notifications (`{ method, params }`) forwarded through the `EngineService` `emit`
  callback — the in-process replacement for the former `event/*` JSON-RPC
  notifications.
- **Savable Markdown report** — the report is both the closing chat response **and**
  an auto-saved Markdown file under `context.globalStorageUri/reports/`
  (`controller.saveReport`); the per-group `UnitResult` projection is exportable in
  **redacted** form.
- **Secure multi-LLM admin** — an admin console
  (`src/brainstorm/adminConsolePanel.ts`) for seats / roles / modes / connectors /
  budgets that **never displays or stores secrets** (keys entered via
  password-masked input, persisted only to SecretStorage via `src/brainstorm/secrets.ts`).
- **Connector abstraction** — one connector interface
  (`src/orchestrator/connectors/base.ts`), adapters for OpenAI API
  (`openai.ts`), Anthropic API (`anthropic.ts`), OpenAI-compatible local servers
  (`openaiCompatible.ts`), **and the sandboxed CLI connector (`cli.ts`)** as a
  **first-class connector kind**, all built through a `factory.ts`; each debate
  **seat** = (connector + model + role + persona/temperature/order) (§6,
  ARCHITECTURE.md §5).
- **Sandboxed CLI connector (`src/orchestrator/connectors/cli.ts`)** — a **built,
  first-class connector kind** (no longer a vague deferral) that drives the real
  `codex`/`claude` CLI agents as sandboxed subprocesses via their **existing
  login/OAuth**. Its security controls are **fully specified and implemented** (§2.3,
  §3 T3, BLD9): spawn `shell: false` with an **argv list** (no shell, no
  interpolation), a **bounded temp cwd** (`os.tmpdir()` by default, never the
  workspace), **no** BrainStrom-managed key in argv/env, a **per-call timeout**
  (SIGKILL on expiry) and a **hard output cap**, single-shot "print" invocation only
  (`allowFileTools` defaults to false). It inherits the user environment so the CLI
  finds its **own** stored login.
- **>2-debater panel** — running **more than two debate models inside one group** is
  **built** (`src/orchestrator/multiDebate.ts`); the executor routes to the panel
  engine when the role map carries more than two debater seats. (The two-debater
  Unit Cell `UnitEngine.run()` remains the default per-group engine; the panel is an
  additional orchestrator-tier capability, **not** a fork of the Unit Cell phase
  machine.)

### 2.2 Out of Scope / Deferred

The v0.2 deferral list has **shrunk to almost nothing** — the two items the original
governance set flagged as the headline deferrals are now **built**. The remaining
out-of-scope items are inherited Unit Cell deferrals and the single open security
hardening item:

> **No longer deferred (now BUILT):**
> - The **CLI connector** is a **first-class, implemented connector kind**
>   (`connectors/cli.ts`) with the full sandbox controls of §2.3 / BLD9 — see §2.1.
> - **>2 debaters in one group** is **built** (`orchestrator/multiDebate.ts`) — the
>   former "engine fan-out" deferral is resolved at the orchestrator tier without
>   forking the Unit Cell engine.
> Neither remains on the Out-of-Scope list.

- **OPEN P1 — DNS-rebinding egress hardening.** The egress guard
  (`connectors/egress.ts`) classifies a base URL's **hostname** without resolving
  DNS, so a DNS name that resolves to a private/metadata IP at connection time is not
  re-checked. This is the **one open security hardening item**: a resolve-and-recheck
  pass is a **P1** task (Risk R2 / control S5). It is **documented in the source, not
  silently ignored**; the allowlist + https + explicit `allowRemote` requirements
  bound the remote surface in the meantime.
- **Any engine change beyond the two additive surfaces.** Only the `onEvent` hook and
  the `proposeClashSplit` + `objective` config fields (§7.5) extend the ported
  `src/engine/` copy. Anything requiring a behavioral change to the engine's phase
  machine, scoring, or two-agent wiring is out of scope for the engine itself (the
  >2-debater panel lives in the **orchestrator**, not the engine — §2.1).
- Inherited Unit Cell deferrals (model training, distributed compute, pool-level
  MAP-Elites/DPP/Bradley–Terry aggregation, cross-swap into *new* pairs mid-session,
  etc.) remain deferred per Unit Cell CONSTITUTION §2; BrainStrom consumes the export
  contract, it does not implement those mechanisms.

### 2.3 Export / Interface Contract

Each layer guarantees a hard boundary the others may rely on. **The former "Sidecar
boundary" row is replaced by the "In-process EngineService boundary"** — there is no
process boundary to cross, so the guarantee is about the typed in-memory facade and
its in-memory secrets snapshot rather than a stdio handshake.

| Layer | Guarantee (binding) |
|-------|---------------------|
| **Extension shell (TypeScript)** | Owns VS Code UX, config, secrets, lifecycle, the live sidebar, *and* the engine. Renders LLM text via `textContent` only — Markdown is rendered as HTML **only** in the saved report file, never in the webview (S7). The synthetic model is injected after the sort and handled before any delegate access in **both** the response-generation **and** the token-count branches (F2, `modelLaneProvider.ts`). |
| **In-process EngineService boundary** | The former Python sidecar (`rpc_server.py`) is replaced by `class EngineService` (`src/brainstorm/engineService.ts`). The former RPC methods are now **direct async methods** — `runGroup(params)`, `runSession(params)`, `decompose(params)`, `executePlan(params)` — called by the controller with plain `await` (no JSON-RPC envelope, no Content-Length framing, no process). Secrets are read into memory **once per run** via the injected **`secretsAccessor`** (`SecretsAccessor = () => Record<string,string>`): the controller refreshes a `currentSecrets` snapshot from SecretStorage at the start of each run and the `EngineService` reads it through the accessor — never argv, env, disk, stdout, logs, or reports (S1/S2/S8). Engine telemetry is forwarded to the board as plain `EngineEvent` (`{ method, params }`) through the injected `emit` callback (BLD3). Executors (`defaultExecutor` / `defaultSessionExecutor` / `defaultDecomposeExecutor` / `defaultExecuteExecutor`) are **injectable** so every path is unit-testable with a fake fetch/client (no network). |
| **Connector layer (TypeScript)** | **All** model traffic — agentA, agentB, judge, embeddings, harvester (and its **two** extractors: primary + second), research — is built by a connector and **injected** into the engine. The engine's `build()` **never** constructs a default *unguarded* client for an injected slot, so the **egress guard is total**. This is a **proven** property, not a claim: a **trap-client** test (`src/test/totalEgress.test.ts`) makes the engine raise if it ever reaches a default constructor, and a `NoopKnowledgeEngine` replaces the research client when research is disabled (F4, S4/S5, BP3). |
| **Group boundary** | One knowledge point = one debate **group** = exactly **one `UnitEngine.run()`** (BP4), constructed via the frozen options object and called with config passed to `run()`, **never** to the constructor: `const engine = new UnitEngine({ agentA, agentB, judge, embeddings, research, harvester, onEvent }); const result = await engine.run(cfg);` (F3 / BLD15). The three logical moderator roles bind to engine slots with their model family recorded in provenance (Flaw1 / BP12). Groups never share mutable engine state. The >2-debater **panel** (`multiDebate.ts`) is a sibling per-group runner selected by seat count; it is orchestration, not an engine fork. |
| **CLI connector boundary (`connectors/cli.ts`)** | The CLI connector drives `codex`/`claude` agents as **sandboxed subprocesses** via their existing login/OAuth. Binding controls: spawn `shell: false` with an **argv list**; **no** shell interpolation of any model- or user-supplied text; a **bounded/temporary** cwd (`os.tmpdir()` default); inherits the user environment so the CLI finds its **own** login, but **no** BrainStrom-managed API key is ever placed in argv or env; an optional `envPassthrough` allowlist; a **per-call timeout** (SIGKILL) + **max-output cap**; single-shot print mode (`allowFileTools=false`). The CLI connector's surface is **process execution**, governed by these sandbox controls; it does not open a second network egress path (BLD9, risk R-CLI). |
| **Report boundary** | The per-group interim is a **projection** of `UnitResult` (no new engine fields). The report and any exported `UnitResult` JSON are redacted (S8). Save paths are validated and slugged; all report/session paths live under `context.globalStorageUri`, **never** the repo or a process cwd (F5, `controller.saveReport`). |

### 2.4 Module inventory (replaces the Python sidecar node map N0–N25)

The runtime is now a single TypeScript extension. The binding inventory:

- **Ported engine** (was `python/unit/`) → **`src/engine/`**: `types`, `config`,
  `budget`, `embeddings`, `agent`, `research`, `ledger`, `metrics`, `judge`,
  `harvester`, `engine`; plus **NEW** helpers `http.ts`
  (`type FetchLike`, `fetchJson`, `class HttpError` with `.status`), `rng.ts`
  (seeded mulberry32 `makeRng`), and `util.ts` (`sha256hex` via `node:crypto`,
  `estimateTokens`, `clamp`). The engine entry point is `UnitEngine.run(config):
  Promise<UnitResult>`.
- **Ported orchestration** (was `python/brainstrom/`) → **`src/orchestrator/`**:
  `types`, `security`, `decompose`, `scheduler`, `chiefScribe`, `groupRunner`,
  `multiDebate`, `sessionState`; and **`connectors/`**: `base`, `egress`, `openai`,
  `anthropic`, `openaiCompatible`, `cli`, `factory`.
- **Extension glue** → **`src/brainstorm/`**: `engineService` (the in-process facade,
  replacing `rpc_server.py`), `controller` (CONFIRM_PLAN gate), `brainstormViewProvider`
  (live board), `adminConsolePanel`, `connectorRegistry`, `secrets`. **Shell**:
  `src/extension.ts` + `src/modelLaneProvider.ts` (synthetic "🧠 Brainstorm Debate
  Model" injected after sort, with response/token-count branch). **Inherited ModelLane
  files** (reused as-is): `lmStudioApi`, `chatPanel`, `agentRunner`, `codeActions`,
  `inlineCompletion`, `languageModelProvider`, `localModelProvider`, `statusBar`.
- **Critical path:** `engine/types` → `engine/*` → `orchestrator/*` →
  `brainstorm/engineService` → `brainstorm/controller` + `extension`.

**Eliminated vs the v0.2 sidecar design (all removed):** `sidecarManager.ts`;
`rpc_server.py`; JSON-RPC 2.0 + Content-Length stdio framing; the
`session.provisionSecrets` stdio handshake; Python-interpreter discovery/bootstrap
(former node N21); `python/requirements.txt`; the `requests` dependency; the `numpy`
concern; the `brainstrom.pythonPath` setting; and **Risk R-PY** (Windows Python
bootstrap) — none of these exist in the TS runtime.

---

## 3. Core Design Tenets

> Six BrainStrom-specific tenets (**T1–T6**) plus inherited cross-cutting tenets. Each
> binds the architecture below; violations are gate failures (ENGINEERING.md,
> DASHBOARD.md risk register).

### T1 — Engine purity, minus two additive surfaces
The `src/engine/` copy is a **faithful port** of the Unit Cell engine — **ported, not
forked**. The *only* permitted extensions are the two additive, backward-compatible
surfaces of §7.5: the `onEvent` hook and the `proposeClashSplit`/`objective` config
fields. Both default to **current behavior** (`onEvent` null, fields `null`); with
defaults, the engine reproduces the Unit Cell's `UnitResult` output (behavioral parity
tests, ENGINEERING.md). Honesty stance: the reuse claim is *"ported with two small
additive surfaces,"* not *"untouched."* (BP1). The engine's **constructor signature is
FROZEN** to an options object `new UnitEngine({ agentA, agentB, judge, embeddings,
research, harvester, rngSeed=1234, onEvent })` with `run(config: UnitConfig):
Promise<UnitResult>` (F3 / BLD15); no doc, test, or call site may pass `config` to the
constructor.

### T2 — Zero subprocess except the sandboxed CLI connector; one in-process typed engine
*(Replaces the v0.2 "One process, one protocol" tenet.)* The engine and orchestration
run **in the extension host** as ordinary TypeScript — there is **no** long-lived
Python sidecar, **no** wire protocol, **no** stdio framing, and **no** HTTP server
inside the extension. The **only** subprocess in the entire system is the optional,
explicitly-sandboxed **CLI connector** (`connectors/cli.ts`), spawned via
`node:child_process` to drive a `codex`/`claude` CLI. That subprocess is itself routed
through the single connector layer under the §2.3 sandbox controls — it is **not** a
second engine or a second egress path, only one connector kind that spawns a sandboxed
child process. All other model/embedding/research traffic is a native `async fetch`
through an injectable `FetchLike` (§ASYNC). The engine holds no OS handle to clean up;
the CLI subprocess is short-lived (single-shot, per-call timeout, SIGKILL on expiry)
and is bounded to a temp cwd (S3).

### T3 — Secrets are never uninvited
A secret value exists in exactly two places: VS Code **SecretStorage** (at rest, OS
keychain) and the **extension host's process memory** (in use). It is read into memory
**once per run** via the in-memory **`secretsAccessor`** — the controller refreshes a
`currentSecrets` snapshot from SecretStorage at the start of each run
(`controller.collect` → `getSecrets`) and the `EngineService` reads it through the
accessor. There is **NO stdio secrets handshake** (no sidecar; the former
`session.provisionSecrets` is gone). A secret is never written to settings.json, argv,
env, disk, logs, the report, or any exported JSON (S1/S2/S8, BP2). BrainStrom's
connector config carries **opaque connector ids only**; real secrets exist solely
inside connector-built clients in memory (F5). For the CLI connector, the child agent
authenticates via its **own existing login/OAuth** — BrainStrom passes **no**
managed key via argv/env (F1/F5/BLD9).

### T4 — A group is one `run()`
Every knowledge point maps to exactly **one** `UnitEngine.run()`. The orchestrator
sits *between* `run()` calls (scheduling, context passing, aggregation); it never
reaches *inside* a run. This is what lets BrainStrom inherit every Unit Cell
guarantee (scoring, capture, verification, σ_SI) for free, per group (BP4 / T1). The
**decompose step (`decompose.ts`) is explicitly NOT a `run()`** — it is a bespoke
orchestrator step with its own seats/budget/guard/validator and does **not** inherit
Unit Cell guarantees (F6 / BLD11). The >2-debater **panel** (`multiDebate.ts`) is a
distinct per-group runner chosen by seat count; the default two-debater path is a
single `UnitEngine.run()`.

### T5 — Stream everything except the two private exchanges
Everything streams live to the sidebar **except** (a) the moderator↔user **intake**
Q&A and (b) the **final report** assembly — the two "private" exchanges. Streaming
is **group-grain + phase-grain** via the `onEvent` hook (forwarded as `EngineEvent`
notifications through the `EngineService` `emit`); it is **not** per-seat
micro-progress and **not** "live σ_SI mid-run." σ_SI is computed at CLOSE and shown
per group when it completes (honesty stance, §8, BP9). Aggregate progress events
carry **stage labels + non-sensitive status only**; they **NEVER** stream draft
report content or scribe reasoning. Only the **final redacted report** is sent as the
closing chat response and saved Markdown (F8).

### T6 — Three logical moderator roles, family-separated where feasible
The "moderator" function is **not** one omnipresent role. It is split into **three
logical roles** — **intake/decomposition moderator**, **per-group judge/referee**,
and **chief scribe/verifier** — to prevent evaluation contamination (a single model
that decomposes, guides, scores, and summarizes can steer the whole session toward
its own framing). Each role's identity and **model family** are recorded in
**provenance**; **different-family verification** is enforced wherever feasible,
extending inherited **P5** (judge generative/evaluative separation) and **LD8**
(verifier family ≠ author family) to the orchestration tier. In v0.3 one underlying
model **MAY** fill multiple logical roles **only if** provenance records it
(Flaw1 / BP12 / S10).

### Modularity (inherited cross-cutting)
Every TypeScript file has a single responsibility; dependencies form a strict DAG
(ARCHITECTURE.md §2 module table, §2.4 above). The connector layer
(`orchestrator/connectors/`), the orchestration layer (`orchestrator/`), and the
engine (`engine/`) are independently testable. Inherits Unit Cell "Modularity."

### Observability (inherited cross-cutting)
Every orchestration action is logged (S12, actions not secrets). The `onEvent`
hook surfaces the engine's own audit events to the live board at phase grain. Inherits
Unit Cell "Observability."

### Honesty / Quantifiability (inherited + extended — see §8)
Numbers are reported with their true meaning and their true confidence. σ_SI is a
diversity signal; per-premise `p_estimate` is never presented as confidence; cost is
an estimate. Inherits Unit Cell "Quantifiability" + "Incentive Compatibility";
extended for the orchestration tier in §8.

### Adversarial Robustness (inherited + extended)
The Unit Cell already treats debater text as untrusted *inside* a group (P4). At the
orchestration tier, **all cross-layer text** — decomposition output, inter-group
context passing, chief-scribe input — is quarantined (`orchestrator/security.ts`):
wrapped untrusted + injection detection; a hit **disqualifies** that contribution and
triggers a user-visible notice + re-plan (S6, BP6). All model-produced **structured
outputs are DATA-ONLY**: schema-parsed, with extra/executable fields rejected;
predecessor interims are wrapped with **provenance + instruction-stripping**; **user
domain text is isolated as user-data and is NEVER "disqualified"** (the user is not an
attacker); disqualification is **logged** and requires **explicit user confirmation
before re-planning** (F11). Verifier family ≠ author family is enforced at the group
**and** scribe tier (S10, inherits LD8, extended by T6).

---

## 4. Requirement Tiers

> Tiers mirror the Unit Cell P0/P1/P2 convention. Each P0 row maps to a security
> control (S1–S16). The "Maps to" column keeps the S# numbering; the **mechanism**
> behind each control has been updated to the in-process TS runtime (notably S2 and
> S3).
> Cross-refs: (S#) = security control; (M#)/(W#) = ENGINEERING.md milestone/wave.

### P0 — Mandatory (project fails without these)

| ID | Requirement | Maps to | Milestone / Wave |
|----|-------------|---------|------------------|
| P0-1 | Synthetic model injected **unconditionally** into the picker (after the sort); response **branched before delegate** in **both** the response-generation **and** the token-count paths (`modelLaneProvider.ts`, F2) | — | M1 · W1 |
| P0-2 | **No sidecar to spawn.** The engine runs in-process; the **only** subprocess is the sandboxed CLI connector, spawned `shell:false` + argv list, bounded temp cwd, per-call timeout (SIGKILL), output cap, no managed key in argv/env (`connectors/cli.ts`) | **S3** | M1 · W1 |
| P0-3 | Secrets **only** in SecretStorage; never settings/logs/reports/argv/env (`secrets.ts`) | **S1** | M1 · W0 |
| P0-4 | Secrets read into memory **once per run** via the in-memory `secretsAccessor` (controller snapshot → `EngineService`); nothing secret returned or persisted. **No stdio handshake** (the former `session.provisionSecrets` is removed) | **S2** | M1 · W1 |
| P0-5 | One group = one injected, egress-guarded `UnitEngine.run()`, constructed via the **frozen options object** `new UnitEngine({ … , onEvent }).run(cfg)` (F3) | — | M1 · W1 |
| P0-6 | **Loopback/private allowed by default**; remote requires explicit `brainstrom.allowRemote` + host allowlist + https (`connectors/egress.ts`) | **S4** | M1 · W1 |
| P0-7 | **Egress guard on every fetch** (incl. `research.ts` + model-supplied URLs); research **off by default**; cloud-metadata always blocked (`egress.ts`) | **S5** | M1 · W1 |
| P0-8 | Untrusted-text quarantine + injection **disqualify** at decompose / inter-group / scribe; structured outputs **data-only**; user text isolated, never disqualified (`security.ts`, F11) | **S6** | M2 · W1 |
| P0-9 | Webview CSP `default-src 'none'` + nonce-gated scripts + empty `localResourceRoots`; LLM text via `textContent` only (`brainstormViewProvider.ts`, `adminConsolePanel.ts`) | **S7** | M4 · W1(slice) |
| P0-10 | Central `redact()` on all logs/errors/reports/exported JSON **and** persisted session metadata; all paths under `context.globalStorageUri` (F5) | **S8** | M1 · W1 |
| P0-11 | One group-grain interim rendered in the **real** sidebar from the **real** synthetic entry (the M1 **walking skeleton**) | — | **M1** · W1 |
| P0-12 | **Total-egress PROVEN by a trap-client test**: engine raises if it reaches a default constructor; `NoopKnowledgeEngine` when research disabled; all slots injected (`totalEgress.test.ts`, F4) | **S4/S5** | M1 · W1 |

> **M1 walking skeleton.** P0-1 … P0-12 together constitute the M1 deliverable: *"the
> real in-process engine, one OpenAI-compatible seat pair routed through the egress
> guard, `UnitEngine.run()` on a hard-coded point, one group-grain interim rendered in
> the real sidebar from the real synthetic model entry."* In the TS runtime, the top
> risk it falsified in v0.2 — **R-PY (Windows Python bootstrap)** — **no longer
> exists** (there is no interpreter to discover); the surviving M1 risks are
> R-STREAM (streaming granularity) and engine↔connector egress routing. See
> ENGINEERING.md for the gate protocol (now `tsc --noEmit` strict + `node:test`).

### P1 — Important (full DAG / roles / modes / admin / CLI connector / panel / DNS hardening)

| ID | Requirement | Maps to | Milestone / Wave |
|----|-------------|---------|------------------|
| P1-1 | Per-session **absolute** token budget + concurrency cap → abort (`BudgetGovernor`, scheduler `maxConcurrency`); per-call timeout at connector level; research + embeddings counted as budgeted egress (F10) | **S9** | M2 · W2 |
| P1-2 | Verifier-family ≠ author at group **and** scribe; **three logical moderator roles** recorded in provenance with family (inherits LD8, extended T6/Flaw1) | **S10** | M3 · W3 |
| P1-3 | N-way per-pass anonymization across seats | **S11** | M2 · W2 |
| P1-4 | Audit log of actions (not secrets) | **S12** | M3 · W3 |
| P1-5 | Timeouts + backoff; **4xx fail-fast, only network/timeout + 5xx retried** (matches Python `raise_for_status`; `agent.ts`/`anthropic.ts`, `HttpError.status`) | **S13** | M3 · W3 |
| P1-6 | Report/export **save-path validated + slugged**, under `globalStorageUri` (`controller.saveReport`) | **S14** | M4 · W4 |
| P1-7 | Full **decomposition → DAG** via the bespoke decompose step (cycles resolved pre-gate; schema validation of points + edges before `CONFIRM_PLAN`; two point types: atomic + lenses) (`decompose.ts`, F6/Flaw2) | — | M2 · W2 |
| P1-8 | Parallel + sequential **scheduler** (`Promise.all` per DAG layer; cross-layer sequential) with concurrency cap (`scheduler.ts`) | — | M2 · W2 |
| P1-9 | Configurable **intra-group roles** bound to 4 engine slots | — | M4 · W4 |
| P1-10 | **Debate modes** G/C/H/Mixed as presets over engine knobs (canonical mode table, §7.6) | — | M4 · W4 |
| P1-11 | **Chief-scribe** aggregation + report sections, with mandatory uncertainty structures (`chiefScribe.ts`, Flaw5/§8) | — | M3 · W3 |
| P1-12 | **Secure admin** console (seats/roles/modes/connectors/budgets) (`adminConsolePanel.ts`) | — | M4 · W4 |
| P1-13 | Crash-resume: replay completed groups, reschedule the rest; **session state persisted independently of chat transcript** (`sessionState.ts`, controller plan map, F7) | — | M3 · W3 |
| P1-14 | **Sandboxed CLI connector** — drives real `codex`/`claude` CLI agents via existing login/OAuth; full sandbox controls (§2.3, BLD9) — **BUILT** (`connectors/cli.ts`) | **S3/S6/S8** | **BUILT** |
| P1-15 | **Pairing policy / participation** surfaced at `CONFIRM_PLAN`; report which models did/didn't participate per group (F9) | — | M2 · W2 |
| P1-16 | **>2-debater panel** — more than two debate models in one group — **BUILT** (`orchestrator/multiDebate.ts`) | — | **BUILT** |
| P1-17 | **DNS-rebinding egress hardening** — resolve-and-recheck the egress host before connect (the single **OPEN** P1 security item; documented in `egress.ts`) | **S5** | **OPEN** |

### P2 — Enhancement (deferred to subsequent iterations)

| ID | Requirement | Maps to | Milestone / Wave |
|----|-------------|---------|------------------|
| P2-1 | Cert pinning + `npm audit` in CI + VSIX integrity | **S15** | W5 |
| P2-2 | Workspace re-confirm before enabling remote egress | **S16** | W5 |
| P2-3 | Re-audit inherited surfaces (`chatPanel.ts`, `lmStudioApi.ts`, `agentRunner.ts`) | **S16** | W5 |
| P2-4 | Polish: richer sidebar visualizations, transcript export ergonomics, theming | — | W5 |

---

## 5. Inherited Unit Cell Principles (apply INSIDE each group)

> These principles govern the deliberation **inside a single group's**
> `UnitEngine.run()`. BrainStrom inherits them unchanged by construction (T4: a group
> *is* a run), so they are cited by ID with a short gloss and a pointer to the
> external source — their full normative text lives in the Unit Cell THEORY.md and
> CONSTITUTION.md, **not** here. Do not treat the glosses as authoritative
> definitions. The port preserves them: the engine, judge, scheduler, metrics, and
> ledger modules passed a 10-module adversarial fidelity audit as **faithful, with no
> behavioral discrepancies** (ENGINEERING.md, DASHBOARD.md).

| ID | Gloss (short) | External source |
|----|---------------|-----------------|
| **P1** | Deliberation **+ inquiry**, not a persuasion contest — CONCEDE/RETRACT/merge are rewarded moves; the goal is the best idea, not a winner | Unit Cell THEORY.md P1 |
| **P2** | **Simultaneous Round-0 solo drafting** — A and B draft independently, committed before either sees the other's | Unit Cell THEORY.md P2 |
| **P5** | Judge **generative / evaluative separation** — the judge never authors content it later scores | Unit Cell THEORY.md P5 |
| **P8** | **MMR redundancy control** — distillation uses MMR/k-DPP so duplicates cannot inflate the output; redundancy invariance | Unit Cell THEORY.md P8 |
| **P9** | **Scores withheld from agents in PROPOSE** — no verdict/score feedback during divergence | Unit Cell THEORY.md P9 |
| **P10** | **Asymmetric knowledge injection** — overlapping-but-distinct knowledge packets per agent | Unit Cell THEORY.md P10 |
| **P11** | **Stability-based stopping** — phases exit on novelty-rate floor + score stability, not a fixed round count | Unit Cell THEORY.md P11 |
| **P16** | **First-principles verification** — insights decomposed to atomic premises, checked against basic logic + external knowledge | Unit Cell THEORY.md P16 |
| **P17** | **Reliable innovation capture + verify** — continuous harvest across PROPOSE/CLASH/RECOMMEND; audited recall, never "complete" | Unit Cell THEORY.md P17 |
| **LD1** | **Cardinal anchored rubric** — 0–10 per dimension, two channels; W/L/D derived from totals | Unit Cell CONSTITUTION §5 (LD1) |
| **LD4** | **Idea ledger + entropy (σ_SI)** — per-idea provenance/novelty/diversity; σ_SI is the **primary** objective | Unit Cell CONSTITUTION §5 (LD4) |
| **LD7** | **Never silently drop a breakthrough** — two-tier output: gated key-points **+** flagged high-novelty unverified candidates | Unit Cell CONSTITUTION §5 (LD7) |
| **LD8** | **Verifier family ≠ author family** — the model that verifies an insight differs in family from its author | Unit Cell CONSTITUTION §5 (LD8) |

**Orchestration-tier consequences.** Because a group is one run (T4): per-group σ_SI,
verification status, and the two-tier validated output flow straight into the
chief-scribe projection (§7.4) with **no new engine fields** (LD4/LD7). BrainStrom
re-applies **LD8** a second time, at the **scribe** tier (S10), so cross-group
synthesis is not graded by the same family that authored the synthesized claims, and
extends LD8/P5 across the **three logical moderator roles** so the
intake/decomposition model, the per-group referee, and the chief scribe/verifier are
family-separated where feasible (T6/Flaw1). Debate modes (§6, canonical table §7.6)
tune **only** the engine knobs these principles already expose (rigor tier,
temperatures, propose/clash split) — they never weaken P1/P5/P9.

**Determinism (port-specific).** The Unit Cell's reproducible randomness is preserved
by a **seeded mulberry32 RNG** (`engine/rng.ts`, `makeRng`) that replaces Python's
`random.Random` for reproducible shuffles, and the Thue-Morse opener alternation is
computed by index. `node:crypto` SHA-256 (`engine/util.ts`, `sha256hex`) replaces
Python's `hashlib`. The default `rngSeed` is `1234` (engine constructor).

**Harvester extractor mapping (F14).** BrainStrom **always constructs the harvester
explicitly** with connector-built, injected extractors and **never relies on engine
defaults** — required for total-egress containment (F4) and verified by the
trap-client test (`totalEgress.test.ts`). The harvester's code-point length uses a
spread (true code points), not UTF-16 units, matching the Python source (a fidelity
fix applied during the port).

---

## 6. BrainStrom Principles (BP) and Locked Decisions (BLD)

> Derived from the approved plan's locked decisions and resolutions. **BP#** are
> standing principles; **BLD#** are concrete, frozen decisions. Both bind the
> architecture (ARCHITECTURE.md) and the build (ENGINEERING.md). Decisions whose
> *mechanism* changed in the TS port are annotated **[ported]**.

### BrainStrom Principles

| ID | Principle |
|----|-----------|
| **BP1** | **Engine reuse is additive only.** The engine is *ported with two small additive surfaces* (§7.5) — never forked. The honest claim is "ported + 2 surfaces," not "untouched." (→ T1) |
| **BP2** | **Secrets are never uninvited.** In-memory `secretsAccessor` snapshot (read once per run); `redact()` everywhere; connector config holds opaque ids only. (→ T3, S1/S2/S8, F5) **[ported: was a one-shot stdio handshake]** |
| **BP3** | **Total egress containment is PROVEN.** Every client is connector-built and injected; the engine constructs no default unguarded client; one egress guard (`makeGuardedFetch` + `validateEgress`) covers all traffic; a **trap-client** test makes the engine raise if a default constructor is reached. (→ S4/S5, F4) |
| **BP4** | **A group is one `run()`.** Orchestration lives between runs, never inside; the decompose step is the explicit exception — bespoke, not a run; the >2-debater panel is a sibling per-group runner, not an engine fork. (→ T4, F6) |
| **BP5** | **The executed plan == the approved plan.** Decomposition + DAG (schema-validated) are confirmed at the `CONFIRM_PLAN` gate; what runs is exactly what the user approved. `brainstrom.autoConfirmPlan=true` opts into a single-turn `runSession`. (→ BLD4, F6) |
| **BP6** | **Cross-layer text is untrusted; the user is not.** Quarantine + disqualify model-produced cross-layer text at decompose / inter-group / scribe (structured outputs data-only); isolate **user** domain text as user-data and never disqualify it; disqualification is logged + requires explicit user confirmation before re-plan. (→ S6, F11) |
| **BP7** | **Deferrals are flagged, not buried.** The former headline deferrals are now **built**: the **CLI connector** and the **>2-debater panel**. The single remaining open item — **DNS-rebinding egress hardening** — is named explicitly as the open P1. (→ §2.1/§2.2) |
| **BP8** | **Every model participates.** For N > 2 models the orchestrator either round-robin-pairs two seats per group or routes to the >2-debater panel; participation is reported per group. (→ BLD6, BLD10, F9) |
| **BP9** | **σ_SI is diversity, not quality.** Reported per group at CLOSE, labeled a diversity signal; never a quality score, never "live." (→ §8) |
| **BP10** | **Research is off by default.** External search (`research.ts`) is a privacy + egress surface; disabled unless explicitly enabled + allowlisted; when disabled, `NoopKnowledgeEngine` is injected. (→ S5, BLD8, F4) |
| **BP11** | **Decomposition yields two point types.** The decompose step emits **atomic debate points** AND **cross-cutting lenses/themes**; useful ambiguity is preserved and the scribe surfaces cross-point emergent findings. (→ §7.2, Flaw2) |
| **BP12** | **Three logical moderator roles.** Intake/decomposition moderator, per-group judge/referee, and chief scribe/verifier are distinct logical roles recorded in provenance with model family; different-family verification is enforced where feasible; one model may fill multiple roles in v0.3 only if provenance records it. (→ T6, S10, Flaw1, inherits P5/LD8) |

### Locked Decisions

| ID | Decision (frozen) |
|----|-------------------|
| **BLD1** | **Runtime = in-process TypeScript.** One VS Code extension owns UX/config/secrets/sidebar **and** the engine; the ported engine (`src/engine/`) + orchestration (`src/orchestrator/`) run in the extension host behind the `EngineService` facade. **No Python, no sidecar subprocess.** **[ported: was "Python sidecar"]** |
| **BLD2** | **Pluggable connector abstraction.** One interface (`connectors/base.ts`); adapters for OpenAI / Anthropic / OpenAI-compatible local **and the sandboxed CLI connector**, built via `factory.ts`; seat = (connector + model + role + persona/temperature/order); credentials in SecretStorage (CLI agents use their own login/OAuth). |
| **BLD3** | **In-process events, no framing.** Engine telemetry reaches the board as plain `EngineEvent` (`{ method, params }`) through the `EngineService` `emit` callback; event method strings stay `event/group.start` \| `event/group.phase` \| `event/group.interim` \| `event/group.error`. **No JSON-RPC, no Content-Length framing.** **[ported: was JSON-RPC 2.0 / Content-Length stdio]** |
| **BLD4** | **`CONFIRM_PLAN` gate.** The controller streams the decomposition plan (points + DAG) to chat/board and waits for an approval reply before any group runs; the decomposition output is schema-validated (`KnowledgePointSet.validate()`) before this gate. `autoConfirmPlan` opts into single-turn `runSession`. |
| **BLD5** | **Cycles resolved before approval.** The decompose step merges/softens cyclic dependencies so the approved DAG is acyclic; executed == approved. |
| **BLD6** | **Round-robin pairing for N > 2 (default), with a built panel option.** Two seats per group rotated across the roster by default; **>2 debaters in one group is BUILT** as the `multiDebate.ts` panel (no longer deferred). **[ported: was deferred]** |
| **BLD7** | **`onEvent` for streaming.** The single additive hook in the engine's log sink drives phase-grain streaming; group-grain events are emitted by the orchestrator between runs; aggregate progress is stage-label + status only, never draft content (F8). |
| **BLD8** | **Research off by default.** Off for privacy; allowlisted when explicitly enabled; `NoopKnowledgeEngine` injected when off. |
| **BLD9** | **Hybrid connector policy (F1).** DEFAULT debate seats are **OpenAI (Codex-style persona)** + **Anthropic (Claude-Code-style persona)** — **API** models with coding-agent personas, NOT the CLI products, and the extension does not drive those CLIs by default. The **sandboxed CLI connector** (`connectors/cli.ts`) is a **built, first-class connector kind** that *can* drive the real `codex`/`claude` CLI agents via their existing login/OAuth, under fully specified, implemented sandbox controls: spawn `shell:false` + argv list, NO shell interpolation, bounded temp cwd, no managed key via argv/env, per-call timeout (SIGKILL) + max output, single-shot print mode (`allowFileTools=false`). |
| **BLD10** | **Participation is user-visible (F9).** Surfaced at `CONFIRM_PLAN`; the report records which models did and did not participate per group. |
| **BLD11** | **Decomposition is bespoke, not a Unit Cell run (F6).** `decompose.ts` is **not** `UnitEngine.run()`; it does not inherit Unit Cell guarantees and carries its own seats, budget, injection guard, and a schema validator for points + DAG edges that must pass before `CONFIRM_PLAN`. |
| **BLD12** | **Module-inventory convention (F12).** The Python node map N0–N25 is **replaced** by the TS module map (§2.4): `src/engine/`, `src/orchestrator/` (+`connectors/`), `src/brainstorm/`, shell. Progress is measured by `tsc` strict + the 181-test suite + the fidelity audit, not by a sidecar node count. **[ported]** |
| **BLD13** | **Session state persisted outside the transcript (F7).** Cross-turn session identity is keyed on the conversation's first user message (controller plan map), with resumable state in `sessionState.ts`, independent of chat-transcript metadata; hidden chat markers are an optimization, never the source of truth. The multi-turn intake protocol (new-session detection → plan proposal → `CONFIRM_PLAN` approval → execute / re-plan → final-report turn) is binding (ARCHITECTURE.md). |
| **BLD14** | **Total egress proven by trap-test (F4).** The orchestrator injects **all** engine slots (agentA, agentB, judge, embeddings, research, harvester primary extractor, harvester second extractor) — adding `NoopKnowledgeEngine` when research is off; the engine raises if it reaches a default constructor (`totalEgress.test.ts`). |
| **BLD15** | **Engine API frozen to the real signature (F3).** `new UnitEngine({ agentA, agentB, judge, embeddings, research, harvester, rngSeed=1234, onEvent })` then `await engine.run(cfg)`. Never `new UnitEngine(cfg)`; never pass `cfg` to the constructor. All docs/tests/call sites conform. **[ported: options object replaces Python kwargs]** |
| **BLD16** | **`numpy` concern eliminated (F13).** The TS port has **no** numpy, no `requests`, and no `requirements.txt` — the engine uses `node:crypto`, a seeded mulberry32 RNG, and `fetch`. The former "numpy dropped from metadata" task is moot. **[ported: removed]** |
| **BLD17** | **`handover/DESIGN.md` required before UX surfaces (F16).** A `handover/DESIGN.md` (visual system, interaction density, sidebar layout, typography, accessibility) is required before implementing the live board (`brainstormViewProvider.ts`) and admin console (`adminConsolePanel.ts`). |
| **BLD18** | **HTTP / async contract (port-specific).** Every model/embedding/research call is an `async fetch` through an injectable `FetchLike` (`engine/http.ts`; default `httpFetch → globalThis.fetch`); timeouts via `AbortController`; non-2xx throws `HttpError(status)`; **4xx fails fast, only network/timeout + 5xx are retried with backoff** (matches Python `raise_for_status`). **[new in TS]** |

---

## 7. Algorithms & Computational Structures (compact)

> Compact forms below; exact pseudocode + diagrams live in ARCHITECTURE.md §4/§6.
> Notation reuses the Unit Cell phase names (OPEN/PROPOSE/CLASH/RECOMMEND/CLOSE).

### 7.1 Session phase machine

```
INTAKE        moderator privately interviews user (domain, constraints,
              audience, mode); OFF the live board (T5); session identity
              keyed on the first user message, state in sessionState.ts,
              NOT the transcript (F7)                                    ──►
DECOMPOSE     bespoke decompose step → N points (atomic +
              cross-cutting lenses) + dependency DAG; cycles resolved
              here (BLD5); schema validation of points+edges
              (KnowledgePointSet.validate(), F6); NOT a UnitEngine.run() ──►
CONFIRM_PLAN  controller streams points + DAG; user replies "go" /
              refined topic; executed == approved (BP5/BLD4/BLD10);
              autoConfirmPlan=true skips to single-turn runSession      ──►
SCHEDULE      DAG → build waves; assign seats (round-robin if N>2, or
              the >2 panel); concurrency cap + absolute token budget
              (BudgetGovernor, S9, F10)                                  ──►
GROUP DEBATES each point → one UnitEngine.run() via the frozen options
              object new UnitEngine({…,onEvent}).run(cfg) (T4/F3);
              same-layer groups parallel via Promise.all, cross-layer
              sequential (interim → quarantined downstream context);
              group/phase events stream via onEvent (T5)                ──►
AGGREGATE     chief scribe/verifier: dedup + contradiction
              detect/present + emergent + report; OFF the live board;
              aggregate progress is stage-label only (T5/F8)            ──►
REPORT        closing chat response + auto-saved Markdown (redacted,
              path-validated, under globalStorageUri); redacted
              UnitResult projection exportable
```
Cancellation is **group-grain**: not-yet-started groups are skipped; the VS Code
`CancellationToken` is checked at turn boundaries (controller). The budget governor
short-circuits scheduling when the absolute token cap is exhausted, and per-call
connector timeouts (`AbortController`) bound already-started remote spend (F10). No
mid-phase kill (honors "never lose generated data"); coarse latency is stated
honestly (§8).

### 7.2 Decomposition workflow (bespoke — NOT a Unit Cell run, BLD11/F6)

```
DECOMP_PREP → ENUMERATE → CRITIQUE → DEDUP → RANK → EMIT
Two point types are emitted (Flaw2/BP11):
  • ATOMIC debate points    = debatable ∧ atomic ∧ self-contained ∧ distinct
                              (ledger θ + MMR) ∧ material ∧ tractable.
  • CROSS-CUTTING lenses/themes = a frame debated ACROSS several points;
                              preserves useful ambiguity; the chief scribe
                              surfaces cross-point emergent findings.
N is budget-driven (floor 2). If < 2 admissible points → moderator asks the
  user to BROADEN rather than pad (degenerate path is explicit, never invented).
Edges: requires = HARD edge (sequential);  informs = SOFT edge (pass interim).
Cycles resolved (merge/soften) BEFORE CONFIRM_PLAN (BLD5).
KnowledgePointSet.validate() checks points + DAG edges BEFORE CONFIRM_PLAN (F6);
  malformed output fails the gate, it does not silently proceed.
Own seats / budget / injection guard — this workflow does NOT inherit Unit Cell
  guarantees and is NOT UnitEngine.run() (BLD11).
Reuses helper machinery where useful: guarded research (off by default, BP10),
  dedup, MMR, swap-scored ranking.
NOTE: a null-text JSON point is DROPPED (TS), the saner behavior — intentionally
  NOT replicating the Python literal "None" item (accepted LOW divergence).
```

### 7.3 DAG → waves scheduling

```
topo-sort the acyclic DAG into layers L0, L1, …  (a "wave" = one layer).
reserve the per-group budget before scheduling (BudgetGovernor, F10).
for each layer in order:
    run all groups in the layer CONCURRENTLY via Promise.all,
        bounded by the concurrency cap and the absolute token budget (S9);
    on completion, feed each group's interim conclusion to its
        `informs`/`requires` successors as downstream context.
Downstream context is a QUARANTINED "prior claims" block (Flaw3):
   "use as background, NOT truth; give one reason it may be wrong;
    do not repeat unless it changes the argument" — wrapped untrusted (S6),
    with provenance + instruction-stripping (F11, security.ts).
An optional "parallel independent first pass" mode runs groups WITHOUT predecessor
   context first (anti-fixation), before any dependency context is injected (Flaw3).
The absolute token budget aborts the session before a cost-DoS DAG can execute (R4).
```

### 7.4 Chief-scribe aggregation (in BrainStrom, NOT the engine)

```
input  = list of Interim (each a PROJECTION of a group's UnitResult; no new fields)
steps  = cluster across groups → classify pairs {agree | contradict}
         → DOWN-WEIGHT same-family agreement (S10/LD8/T6)
         → two GROUNDED opposing claims = genuine tension → report BOTH
         → surface emergent (cross-group) findings (incl. cross-cutting lenses, BP11)
report sections (fixed order):
  Executive synthesis → Decomposition map (points + DAG)
  → Per-point in TOPOLOGICAL order (each with a mandatory "Flagged candidates" block, LD7)
  → Cross-cutting findings → Contradictions table → "What we are NOT sure about"
  → Provenance & metrics (per key point; role/family per logical moderator role, T6)
Each claim carries an EVIDENCE STATUS; GROUNDED conclusions are SEPARATED from
  high-novelty candidates (Flaw5/§8).
Contradictions are DETECTED + PRESENTED, never auto-resolved (honest fallback).
confidence_label is DERIVED, never a fabricated %; σ_SI labeled diversity (BP9).
The exec-prompt is built with a single-pass regex replacer (a fidelity fix: the
  Python String.replace $-sequence + sequential-bleed bug is corrected); an empty
  participation JOIN falls back to 'n/a' (chiefScribe.ts).
```

### 7.5 The two engine surfaces (additive, backward-compatible)

```
// TOMBSTONE: an engine FORK (per-seat streaming, live σ_SI, >2 debaters INSIDE the
//            engine) is REJECTED. Only these two additive surfaces touch src/engine/.
//            (The >2-debater PANEL lives in src/orchestrator/multiDebate.ts — it is
//            orchestration, not an engine change.)
// FROZEN real signature (F3/BLD15):
//   new UnitEngine({ agentA, agentB, judge, embeddings, research, harvester,
//                    rngSeed = 1234, onEvent })
//   await engine.run(config: UnitConfig): Promise<UnitResult>
//   ALWAYS construct via the options object; NEVER new UnitEngine(cfg); NEVER pass
//   cfg to the constructor.

Surface 1 — onEvent hook (BLD7)
  new UnitEngine({ ..., onEvent?: (e) => void | null })
  invoked inside the engine's single log sink (the one telemetry chokepoint):
      if (this._onEvent !== null) { this._onEvent(event); }   // yields already-
      // emitted phase events: brief_frozen, round0_committed, insight_harvested,
      // stability_stop, keypoint_distilled, budget warnings, …
  onEvent null  ⇒  ZERO behavior change (behavioral parity test, T1).

Surface 2 — config presets (engine/types.ts UnitConfig)
  proposeClashSplit: [number, number] | null = null   // (proposeFrac, clashFrac)
  objective:         string | null            = null   // debate-mode LABEL
  When proposeClashSplit is set, the engine's propose/clash envelope reads the
  override; absent (null) ⇒ identical current behavior (engine.ts). `objective`
  is a LABEL the engine does NOT act on (honest framing — modes are presets, §7.6).
```

### 7.6 Canonical debate-mode preset table (Flaw6)

> **Honesty caveat (binding).** Modes are **PRESETS over existing engine knobs, NOT
> new science**; `objective` is a **label** the engine does not act on (§7.5
> Surface 2). Sibling docs reference this as "CONSTITUTION §(Algorithms) mode table";
> the CONSTITUTION embeds it in full here.

| Mode | Purpose | Engine knobs (UnitConfig) | Role/persona defaults | Report emphasis |
|------|---------|---------------------------|------------------------|-----------------|
| Critical | find flaws & assumptions | rigor_tier=standard; proposeClashSplit≈(0.4,0.6) longer CLASH; verifier_temp≈0.2; objective="assumptions-overturned" | challenger stronger (colder; REBUT/UNDERCUT bias) | risks & objections |
| Heuristic | generate broad idea space | proposeClashSplit≈(0.65,0.35) longer PROPOSE; generator_temp≈0.9; verify telemetry-only; preserve candidate insights; objective="σ_SI diversity + good-idea-count" | synthesizer stronger | options & analogies |
| Game-theoretic | incentive/strategy analysis | rigor_tier=high_stakes; proposeClashSplit≈(0.5,0.5); temp≈0.4; verify all disputed; objective="validity-under-verification" | adversarial payoff personas | equilibria, incentives |
| Mixed (default) | point-type routed | atomic→Critical, lens→Heuristic | standard | balanced synthesis |

---

## 8. Honesty & Quantifiability Policy

> The orchestration tier inherits the Unit Cell tenets **Incentive Compatibility**,
> **Quantifiability**, and **Adversarial Robustness** (Unit Cell CONSTITUTION §3)
> and adds the following BrainStrom-specific obligations. Each is a release gate; a
> violation is a correctness defect, not a cosmetic one.

1. **σ_SI is a DIVERSITY signal, not a quality score.** It is computed at CLOSE,
   shown **per group** when that group completes, and always labeled "diversity."
   There is **no** live/mid-run σ_SI and **no** per-seat σ_SI (BP9 / T5). Presenting
   σ_SI as quality, or as live, is a violation.

2. **Verification = survived scrutiny, never "true."** A `GROUNDED`/`SCRUTINIZED`
   label asserts the insight *survived first-principles scrutiny by a different-family
   verifier* (LD8/P16/T6) — not truth. `UNVERIFIABLE` never outranks `VERIFIED`. The
   per-premise `p_estimate` is **export-only telemetry** and must never be rendered as
   confidence (inherits Unit Cell §3 tenet).

3. **Estimates are labeled.** Token/USD figures are **estimates** (the engine uses
   provider usage when present, else estimates via `estimateTokens`, often zero for
   non-conformant endpoints; CLI seats report zero usage and let the estimator
   handle budget). The `CONFIRM_PLAN` cost figure is shown as a labeled estimate
   (BLD4). Never present an estimate as a measured cost.

4. **Never fabricate confidence.** `confidence_label` is **derived** from
   `UnitResult` fields, never a made-up percentage. The report's "What we are NOT
   sure about" section is **mandatory**; flagged high-novelty unverified candidates
   are always carried forward, never silently dropped (LD7 / BP6).

5. **Contradictions are presented, not resolved.** Two GROUNDED opposing claims are
   reported as a genuine tension; same-family agreement is down-weighted (S10). The
   scribe does **not** auto-pick a winner (honest fallback, §7.4).

6. **Streaming granularity is stated honestly.** The board is **group-grain +
   phase-grain** via `onEvent` — not per-seat, not live-σ_SI. Aggregate progress
   events carry **stage labels + non-sensitive status only**, never draft report
   content or scribe reasoning; only the **final redacted report** is sent (F8).
   Cancellation latency is coarse (up to one round / one unguarded phase) and is
   **stated**, not hidden (§7.1).

7. **Reuse + deferrals are stated honestly.** "Engine **ported** with two additive
   surfaces" (BP1); "modes are presets over existing engine knobs" (BLD7, §7.6);
   "research off by default" (BP10). The former headline deferrals are now **built**
   and named as such: the **CLI connector** drives the *real* CLI agents only when
   the user opts in (the DEFAULT seats are **API models with coding-agent personas**,
   not the CLI products, F1), and the **>2-debater panel** is built at the
   orchestrator tier (`multiDebate.ts`). The single **open** item — **DNS-rebinding
   egress hardening** (P1-17) — is named as open, not hidden. Over-promising any of
   these, or claiming a built feature is still deferred, is a documentation defect.

8. **Total egress is a PROVEN property, not a claim.** "All model traffic is
   connector-built and injected; the engine constructs no default unguarded client"
   is **demonstrated by a trap-client test** (`totalEgress.test.ts`) in which the
   engine raises if it ever reaches a default constructor (F4/BLD14). Stating
   total-egress containment without the passing trap-test is a documentation defect.

9. **The final report MUST enforce uncertainty (Flaw5).** Beyond the mandatory "What
   we are NOT sure about" section, the report **must** carry: an **evidence status per
   claim**; a **contradictions table**; **provenance per key point** (including the
   role/family of each of the three logical moderator roles, T6); and a clear
   **separation of grounded conclusions from high-novelty candidates**. A polished
   report that overstates certainty is a correctness defect, not cosmetic.

10. **Port fidelity is stated honestly (port-specific).** A 10-module adversarial
    audit against the Python source found **engine, judge, scheduler, metrics, and
    ledger faithful** (no behavioral discrepancies). Fidelity **fixes applied** are
    documented, not hidden: egress IPv4 `is_private` parity (added 0.0.0.0/8,
    192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,
    240.0.0.0/4, IPv4-mapped IPv6 reclassification, 2001:db8::/32); chiefScribe
    single-pass exec-prompt replacer; 4xx fail-fast; judge Python-style repr;
    harvester code-point length; chiefScribe participation 'n/a' fallback. Accepted
    **LOW** divergences are documented as such, not "fixed": WHATWG URL normalizes
    legacy IPv4 literals that Python `urlparse` leaves raw; IPv6 metadata-compression
    differences; report perPoint metric-key casing (`sigmaSi` vs `sigma_si`);
    null-text decompose point dropped (TS) vs literal "None" (Python) — TS is the
    saner behavior, intentionally not replicated.

---

## 9. Revision History

| Version | Date | Author | Description |
|---------|------|--------|-------------|
| v0.1 | 2026-06-14 | architect + scientific-advisor | Initial draft from approved plan |
| v0.2 | 2026-06-14 | architect + scientific-advisor | Incorporate ARCHITECTURE_AUDIT_REPORT findings F1–F16 + workflow-logic flaws 1–6; hybrid connector policy; node convention N0–N25. |
| v0.3 | 2026-06-15 | architect + scientific-advisor | pure-TypeScript in-process port: engine + orchestration ported to src/engine + src/orchestrator; Python sidecar/JSON-RPC removed; EngineService in-process facade; tsc strict CLEAN; 181/181 node:test; packaged modellane-brainstrom-ts-0.3.0.vsix. |

---

## Appendix A — Genesis & Vision

### A.1 Background — the ModelLane + Unit Cell merge, now in one language

BrainStrom is assembled from two existing, independently-proven trees, then **ported
into a single TypeScript codebase**, not built from scratch:

```
┌ ModelLane (TS extension) ─────────────┐     ┌ Unit Cell (Py engine) ───────────┐
│ lmstudio-vscode-agent                 │     │ open code/chat/src/unit           │
│  • publisher "modellane"              │     │  • pure Python 3.11+              │
│  • registerLanguageModelChatProvider  │     │  • UnitEngine.run(cfg)->UnitResult│
│  • provider builds + sorts the model  │     │  • _prep→_open→_propose→_clash→    │
│    list  (injection point)            │     │    _recommend (try/except) →_close │
│  • delegates response to a real model │     │  • only 3rd-party dep: requests   │
│    (synthetic entry has NO delegate → │     │  • exactly two debaters (a/b)     │
│     branch before the delegate call)  │     │                                   │
└───────────────┬───────────────────────┘     └───────────────┬───────────────────┘
                │     MERGE + PORT (Python → TypeScript)        │
                ▼                                              ▼
        ┌───────────────────────────────────────────────────────────┐
        │  ModelLane-BrainStrom (TS)                                  │
        │   src/                = forked ModelLane shell + brainstorm/│
        │   src/engine/         = PORTED Unit Cell (the 2 surfaces;   │
        │                         node:crypto + mulberry32 + fetch;   │
        │                         no numpy, no requests)              │
        │   src/orchestrator/   = PORTED orchestration (decompose +   │
        │                         scheduler + chiefScribe + groupRunner│
        │                         + multiDebate + security + connectors│
        │                         incl. the sandboxed cli connector)  │
        │   src/brainstorm/     = engineService (in-process facade) +  │
        │                         controller + board + admin + secrets │
        │   docs/01-architecture/ = this governance set               │
        └───────────────────────────────────────────────────────────┘
```

The merge is deliberate, and the **port is the payoff**: the **ModelLane** shell
already solves VS Code model-picker integration, local-model discovery, and chat
plumbing; the **Unit Cell** already solves disciplined adversarial deliberation with
quantified output. BrainStrom welds them **into one TypeScript process** — the shell
drives UX/secrets/sidebar; the **ported** engine runs each group **in-process**; the
**ported** orchestration turns one atom into a session. The result is **end-to-end
type safety** (one type system from the VS Code API to the engine internals) and
**native async I/O** (`Promise`/`async`/`fetch`, no stdio framing, no process to
spawn, crash, or version-match).

### A.2 The deferred pool layer this realizes

The Unit Cell CONSTITUTION (§2 "Out of Scope") deliberately deferred *multi-unit
orchestration and result aggregation* to "the consumer," while its THEORY.md sketched
a **Future Horizon**: "N agents pair into parallel Unit Cells, their standardized
outputs are aggregated and compared, agents cross-swap into new pairs, and the process
iterates." The Unit Cell built the **atom** and froze an **export contract** precisely
so a future pool layer could consume it.

**BrainStrom is that consumer.** It is the first concrete realization of the deferred
pool layer:

- **"N agents pair into parallel Unit Cells"** → the DAG scheduler runs same-layer
  groups in parallel via `Promise.all` (§7.3), with round-robin pairing assigning
  seats across the roster (BP8/BLD6) — and, when the user wants more than two voices
  in one group, the **built >2-debater panel** (`multiDebate.ts`).
- **"standardized outputs are aggregated and compared"** → the chief scribe consumes
  the `UnitResult` export contract as `Interim` projections (§7.4), with **no new
  engine fields** required.
- **"high-complexity topics route to deeper analysis; low-confidence results flag
  for human review"** → debate modes route per point type (Mixed, §6/§7.6), and the
  mandatory "Flagged candidates" / "What we are NOT sure about" sections surface
  low-confidence findings for the human (LD7, §8).

What BrainStrom deliberately does **not** yet realize from that horizon — cross-swap
into *new* pairs mid-session, and pool-level MAP-Elites/DPP/Bradley–Terry aggregation
— remains deferred (§2.2), consistent with the Unit Cell's own staging and with
BrainStrom's honesty stance (BP7): the atom is **ported and reused**, the pool is
realized one disciplined layer at a time, and every deferral is named. (The CLI
connector and the >2-debater panel, formerly deferred, are now **built**; the single
remaining open item is DNS-rebinding egress hardening, P1-17.)
