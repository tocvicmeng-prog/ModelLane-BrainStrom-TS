# ModelLane-BrainStrom (TS) — Engineering Document (Construction Plan)

**Version: v0.3 · Date: 2026-06-15 · Status: DELIVERED (pure-TypeScript in-process port; tsc strict CLEAN, 181/181 node:test, packaged vsix)**

> Authored as a collaboration of the **/architect** (design authority) and
> **/scientific-advisor** (debate-theory + methodology) roles. This document is the
> **construction plan** for ModelLane-BrainStrom: how the work modules are built,
> gated, parallelised, and verified. It is the fourth document in the lineage
> **THEORY (Unit Cell, external) → CONSTITUTION.md → ARCHITECTURE.md → ENGINEERING.md
> → DASHBOARD.md**. It inherits build discipline (Definition of Done, quality gates,
> model tiers, the gate-verification protocol + module state machine) from the Unit
> Cell ENGINEERING document and applies it to a **two-tree merge + Python→TypeScript
> port** rather than a greenfield build.
>
> **Runtime change in v0.3 (the headline).** The v0.1/v0.2 plan built *two cooperating
> processes* — a TypeScript extension host and a **Python sidecar** joined by one
> JSON-RPC stdio seam. **That seam is gone.** The Unit Cell engine and the entire
> BrainStrom orchestration layer are now **ported to TypeScript and run IN-PROCESS in
> the single extension-host process.** There is **no Python interpreter, no sidecar
> subprocess, no JSON-RPC envelope, and no Content-Length stdio framing anywhere.** The
> former Python `rpc_server.py` is replaced by an in-process façade,
> **`EngineService` (`src/brainstorm/engineService.ts`)**, whose async methods the
> controller calls with plain `await`. The **only** subprocess in the whole system is
> the optional, sandboxed **CLI connector** (`codex`/`claude`) spawned through
> `node:child_process`. The pay-off is **end-to-end type safety** and **native async
> I/O** (`Promise`/`async`, no stdio framing, no process to spawn, crash, or
> version-match).
>
> **Module-inventory convention (FROZEN — replaces the v0.2 N0–N25 sidecar nodes).**
> The runtime is no longer a `python/unit/` + `python/brainstrom/` split spoken to over
> stdio. The binding inventory is now the **TypeScript module map** of §2: the ported
> engine under `src/engine/`, the ported orchestration under `src/orchestrator/`
> (+ `connectors/`), the extension glue under `src/brainstorm/`, and the inherited
> ModelLane shell. An **N-style id scheme is kept where it aids the DAG/tables**, but
> every id now names a **TypeScript module under `src/`** (mirroring ARCHITECTURE.md §2:
> shell `R1–R8`, glue `X1/X2`+`B1–B6`, orchestration `O1–O9g`, engine `E1–E11`+`H1–H3`).
> The **eliminated sidecar nodes are listed explicitly in §2.6**. **Progress is no
> longer "x/25 gated nodes."** The build is gated by **`tsc --noEmit` (strict, 0 errors)
> + the `node:test` suite (181/181) + the adversarial port-fidelity audit** (§1.2, §6,
> §8.4). All denominators and gate counts use those three artefacts.
>
> **Honesty stance (carried verbatim in spirit from the approved plan).** The Unit Cell
> engine (`src/engine/`) is **ported with two small additive surfaces** — *not*
> "untouched" and *not* forked further: an `onEvent` hook and the `proposeClashSplit`
> + `objective` config presets (§8). Streaming is **GROUP-grain + phase-grain via
> `onEvent`**, *not* per-seat / live-σ_SI. **σ_SI is a DIVERSITY signal, not a quality
> score.** Debate modes (G/C/H/Mixed) are **PRESETS over existing engine knobs**, not new
> mechanisms — the binding CANONICAL MODE PRESET TABLE lives in CONSTITUTION §7.6 and is
> referenced from here. Cost numbers are **ESTIMATES**. **Total egress containment is a
> PROVEN property** via the trap-client test `src/test/totalEgress.test.ts` (§6 / R-EGRESS-BYPASS),
> not merely a claim. **">2 debaters in one group" is now DELIVERED** at the
> orchestrator tier (`multiDebate.ts`), no longer a deferral. The **CLI-subprocess
> connector** (`connectors/cli.ts`) is a built, first-class connector kind with fully
> specified sandbox controls (§2 O9f / §9.1). See CONSTITUTION.md §8 (Honesty /
> Quantifiability policy) for the binding statements.
>
> **Connector policy (FROZEN — HYBRID).** Default debate seats are **OpenAI + Anthropic
> *API* models configured with coding-agent personas**, named to avoid implying we drive
> the CLI products by default — e.g. **"OpenAI (Codex-style persona)"** /
> **"Anthropic (Claude-Code-style persona)"**. ADDITIONALLY, a sandboxed
> **CLI-subprocess connector (`connectors/cli.ts`, `kind:"cli"`)** is a first-class
> connector that drives the real `codex` / `claude` CLI agents as sandboxed subprocesses
> via their existing login/OAuth, with its security controls fully specified (§9.1).

---

## 1. Build Strategy

All code in ModelLane-BrainStrom (TS) is decomposed according to the same five
principles inherited from the Unit Cell ENGINEERING doc, with one port-specific
addition (#6):

1. **Single responsibility** — each TypeScript file does exactly one thing.
2. **Dependency fence** — dependency direction is strictly acyclic (see the DAG in §2.6
   and ARCHITECTURE.md §2.6).
3. **Module granularity** — each module is completable within one agent session
   (≈≤300 lines; orchestration-heavy modules `scheduler.ts`/`chiefScribe.ts`/
   `engineService.ts` and the pure-data `types.ts` modules may exceed with a documented
   granularity exception).
4. **Precondition verification** — every module must pass regression (`tsc` strict +
   `node:test`) on its dependencies before being considered complete.
5. **Replaceable** — any module can be repaired in isolation without affecting others.
6. **Engine purity-minus-two** *(port rule)* — the ported `src/engine/` tree is modified
   **only** by the two additive surfaces (E1/E3, §8). Any other behavioral edit to
   `src/engine/` is a constitutional violation (CONSTITUTION.md §3, T1). The faithful
   port itself is enforced by the **port-fidelity audit** (§6.4 / §8.4).

### 1.1 Definition of Done (DoD)

Every module is **done** only when ALL six of the following are satisfied. Criteria 3
and 5 are the load-bearing change from v0.2: the Python `ruff`/`mypy`/`pytest`/
`verify_gate.py` stack is **replaced** by `tsc --noEmit` strict + `node:test` + the
fidelity audit.

| # | Criterion | Description |
|---|-----------|-------------|
| 1 | ✅ Code complete | All classes/functions/exports for this module are implemented at the signatures fixed in ARCHITECTURE.md (§2, §5) and §2 below. |
| 2 | ✅ Verification passed | The module's specific numbered verification steps (§2) execute without error under `node:test`. |
| 3 | ✅ Quality gate passed | **`tsc --noEmit -p ./tsconfig.json` (strict) → 0 errors** for the whole project (TypeScript has no separate lint/type split — the strict compiler IS the type+lint gate). |
| 4 | ✅ Tests exist | Test file(s) created under `src/test/*.test.ts` (§1.3) with ≥1 `test()` per public function; security/egress modules also have an adversarial test. |
| 5 | ✅ Regression checked | The **full `node:test` suite still passes (181/181)**; for the engine specifically the **behavioral-parity (golden) test** (`bsN1.test.ts`, §8) still passes; the **port-fidelity audit** (§6.4) shows no new behavioral discrepancy. |
| 6 | ✅ Committed | Code committed to git with a descriptive message; `tsc` strict + `node:test` green in the working tree (there is **no `.gate_log/`** — the compiler and the test runner ARE the evidence; §7.3). |

### 1.2 Quality Gates

Each module must pass through these gates before its output is accepted by downstream
modules. The Python six-stage flow (`lint → type → unit → integration → regression →
committed`) **collapses** in TypeScript to a three-artefact gate, because the strict
compiler subsumes lint+type and there is no second process to integration-test across:

```
[Code Complete] → [tsc --noEmit strict] → [node:test (181)] → [fidelity audit] → [Committed] ✓
                                                                                      │
                                                                                      ▼
                                                                              Next module begins
```

| Gate | Tool / Method (TS) | Replaces (Python v0.2) | Who runs |
|------|--------------------|------------------------|----------|
| **Type+Lint** | `tsc --noEmit -p ./tsconfig.json` (strict; ES2022; commonjs) → 0 errors | `ruff check python/` **and** `mypy python/` | Developer (CI later) |
| **Unit** | `node --test "out/test/**/*.test.js"` (after `pretest`=`tsc`) → all pass; fake `FetchLike` + fake clients, zero network, zero tokens | `pytest tests/ -v` (T3 mock) | Developer |
| **Integration** | *folded into Unit* — there is **no sidecar round-trip** to test; the engine is in-process, so the `pipeline.test.ts` end-to-end and `engineServiceRpc.test.ts` façade tests run at the same zero-cost tier as units | `pytest -m integration` (T1 loopback) + sidecar round-trip harness | Developer |
| **Regression** | re-run the full `node:test` suite (181) + the engine behavioral-parity test (§8) | re-run all upstream verifications + §8 golden | Developer |
| **Fidelity** | the 10-module adversarial port audit vs the Python source (§6.4) — faithful or documented-divergence | *(did not exist in v0.2)* | Developer |
| **Committed** | `git commit` with `tsc` + `node:test` green | `git commit` + `.gate_log` PASS | Developer |

> **Note on the integration gate.** In v0.2 the integration gate existed to test the
> JSON-RPC sidecar round-trip against a real loopback model. **That gate is gone** —
> there is no process boundary to cross and no wire protocol to frame. What it tested
> (the engine producing a valid `UnitResult` end-to-end) is now covered **in-process and
> at zero token cost** by `pipeline.test.ts` (domain → report, fake clients) and
> `engineServiceRpc.test.ts` (the façade methods). A *real* loopback/remote model run is
> the **single remaining manual sign-off** (the in-editor runtime acceptance, §4.2 M4),
> not an automated gate.

### 1.3 Test File Convention

Tests live under a single tree, **`src/test/*.test.ts`**, compiled by `tsc` to
`out/test/**/*.test.js` and run by `node --test`. Every file ports the corresponding
former pytest module faithfully (byte-faithful fixtures, same assertions), using only
the Node built-ins — **no test framework dependency**:

- **`import { test } from 'node:test';`** — the runner (Node 24 built-in).
- **`import assert from 'node:assert/strict';`** — strict equality/throws/rejects.
- **fake `FetchLike`** — every networked client takes an injectable `FetchLike`
  (`engine/http.ts`); tests inject a fake or install a `globalThis.fetch` trap, so
  **zero network, zero tokens**.
- **fake `AgentClient` / `EmbeddingsClient` / extractors / `KnowledgeEngine`** —
  duck-typed fakes (`FakeAgent`, `FakeExtractor`, `FakeResearch`, `JudgeEngine` with
  `mockResponses`, `EmbeddingsClient` with `mockVectors`) mirror the former pytest
  `_bs_fakes`, so a group runs with canned JSON and **no I/O**.
- **seeded determinism** — `makeRng(seed)` (`engine/rng.ts`, mulberry32) replaces the
  Python `random.Random(seed)`; the same seed yields reproducible shuffles, so the
  parity test is stable.

```
src/test/                                  ← node:test suite (181 tests, 27 files; ported from pytest)
│  (each file: import {test} from 'node:test'; import assert from 'node:assert/strict')
│
├── ENGINE (src/engine/*) — ported Unit Cell behavioral suite
│   ├── engine.test.ts            (16)  ← phase machine; PREP→…→CLOSE; onEvent surface; proposeClashSplit
│   ├── judge.test.ts             (25)  ← cardinal rubric (LD1); swap; generative/evaluative split (P5); pyRepr
│   ├── agent.test.ts             (12)  ← AgentClient chat/speak/requestSlips/requestMove; 4xx fail-fast (HttpError.status)
│   ├── types.test.ts             (12)  ← UnitConfig/UnitResult; Move/IdeaRecord; enums
│   ├── config.test.ts           (10)  ← validateConfig; proposeClashSplit + objective fields
│   ├── budget.test.ts           (10)  ← BudgetTracker per-phase guard; estimateTokens
│   ├── research.test.ts         (10)  ← KnowledgeEngine OFF-by-default; guarded search
│   ├── metrics.test.ts           (9)  ← entropy / σ_SI (diversity); coverage; fixation
│   ├── ledger.test.ts            (8)  ← IdeaLedger dedup / MMR / novelty (P8)
│   ├── harvester.test.ts         (7)  ← two extractors; code-point length (spread, not UTF-16)
│   └── embeddings.test.ts        (7)  ← cosine/jaccard fallback; degraded flag
│
├── ORCHESTRATION (src/orchestrator/*)
│   ├── scheduler.test.ts         (3)  ← topo waves; Promise.all within a layer; per-group error isolation
│   ├── decompose.test.ts         (2)  ← bespoke decompose; injection isolated; null-text dropped (TS divergence)
│   ├── chiefScribe.test.ts       (2)  ← cross-group dedup; contradiction present; enforced-uncertainty report; 'n/a' fallback
│   ├── multiDebate.test.ts       (3)  ← >2-debater panel routing
│   ├── security.test.ts          (5)  ← detectInjection; wrapUntrusted; quarantinePriorClaims; redact; NoopKnowledgeEngine
│   ├── egress.test.ts            (6)  ← loopback-default; remote needs allowRemote+allowlist+https; metadata blocked
│   ├── connectors.test.ts        (5)  ← base/openai/anthropic/openaiCompatible; AnthropicAgentClient chat + lastUsage
│   ├── cli.test.ts               (6)  ← CLI sandbox: shell:false + argv; bounded cwd; no key in env; timeout/output cap
│   └── groupRunner.test.ts       (3)  ← point + RoleMap + mode → injected UnitEngine.run(); all-slots injection
│
├── EXTENSION GLUE (src/brainstorm/*) + façade
│   ├── engineServiceRpc.test.ts  (6)  ← EngineService async methods (former RPC); EngineEvent emit; snake_case params
│   ├── service.test.ts           (4)  ← runGroup/runSession façade behavior; injectable executors
│   ├── planService.test.ts       (2)  ← decompose params → points + edges + problems (validate)
│   └── sessionService.test.ts    (1)  ← executePlan over an approved plan
│
├── ADVERSARIAL / CONTRACT (mandated suites)
│   ├── totalEgress.test.ts       (2)  ← MANDATED (R-EGRESS-BYPASS): fetch-trap proves the engine never default-builds a client
│   └── bsN1.test.ts              (4)  ← MANDATED (T1): the two additive surfaces — onEvent fires; defaults reproduce baseline
│
└── END-TO-END
    └── pipeline.test.ts          (1)  ← MANDATED: domain → schedule → groups → report, fully in-process, fake clients
                                          (the in-process replacement for the v0.2 sidecar e2e)
                                  ──────
                                   181 total (node --test, all pass; zero network / zero tokens)
```

> **Mock strategy (inherited, ported).** Every connector adapter and every engine client
> accepts an injectable `FetchLike`/`mockResponses`/`mockVectors`; when set, no HTTP call
> is made. The **behavioral-parity** suite (`bsN1.test.ts`) pins the engine's two additive
> surfaces to "default = current Unit Cell behavior" (§8). Fixtures (the former
> `mock_judge_responses.json` / `mock_harvest.json` / `mock_verification.json`) are inlined
> byte-faithfully in the tests that need them.
>
> **Trap strategy (ported, F4 → R-EGRESS-BYPASS).** Python rebinds the engine's
> module-level default constructors to raising subclasses; TypeScript ESM/CommonJS
> bindings can't be monkeypatched that way, so the TS realization makes **the network
> boundary itself the trap**: `totalEgress.test.ts` installs a `globalThis.fetch` trap
> that throws on *any* call. An unguarded default client is, by definition, one whose only
> behavior is to reach the wire — so a missed slot fires the trap. The test asserts (a) a
> **negative control** — the engine's own default `AgentClient`/`EmbeddingsClient`/
> `KnowledgeEngine`, built exactly as `UnitEngine.build()` does, all hit the trap (the trap
> is real and total); and (b) **full injection** via `runGroup(makeSpec(), makeClients())`
> with all six `GroupClients` slots filled by zero-network fakes → the trap **never fires**
> and a valid interim is still produced (`res.error === null`, `res.interim !== null`).
> This converts "total egress containment" from a *claim* into a *proven property*.

### 1.4 Model-Tier / Runtime Strategy

BrainStrom routes traffic through the connector layer (`connectors/*`, incl. the `cli`
connector), so model choice is a *seat* decision, not a code decision. Some seats
genuinely need the strongest model; most modules need no LLM at all.

| Tier | Cost | Model role | Used by (seats / modules) |
|------|------|-----------|----------------------------|
| **T0 — None** | Zero | No LLM needed | every module that is pure logic / async-`fetch` plumbing / subprocess control / orchestration: `engine/{http,rng,util,types,config,budget,ledger,metrics,embeddings}`, `orchestrator/{types,security,scheduler}`, all `connectors/*`, all `brainstorm/*`, the shell, the synthetic-model provider branch |
| **T1 — Fast** | Low | Debate seats `agentA`/`agentB` (DEFAULT pair = **OpenAI (Codex-style persona)** + **Anthropic (Claude-Code-style persona)**, API-backed; or the CLI connector seats) | `groupRunner` debate turns; `decompose` ENUMERATE/CRITIQUE proposers |
| **T2 — Capable** | Medium | **The strongest model** is required for: **judge** (rubric/swap/synthesis), **harvester** (extraction + verification), and the **chief scribe** (cross-group dedup, contradiction classification, emergent-finding surfacing) | the `judge` engine slot; `chiefScribe`; the harvester second extractor (verifier family ≠ author family — **LD8**) |
| **T3 — Mock** | Zero | Fake `FetchLike` / fake clients / canned JSON | all `src/test/*` (every suite incl. the total-egress trap + the parity suite) |

**Why judge / harvester / chief-scribe need T2.** These three are the
quality-determining seats. The judge applies the cardinal anchored rubric (**LD1**) with
swap double-pass and generative/evaluative separation (**P5**); the harvester must
capture-and-verify breakthroughs without silently dropping them (**P17**, **LD7**); the
chief scribe must *detect and present* contradictions across groups without
auto-resolving them — all reasoning-heavy. Debate seats can run T1.

> **Three logical moderator roles (T6 / Flaw 1).** The single "moderator" concept is split
> into **three logical roles**, each recorded in provenance with its **model family**:
> (a) **intake/decomposition moderator** (`controller.ts` §3.1 + `decompose.ts`),
> (b) **per-group judge/referee** (the engine `judge` slot), and (c) **chief
> scribe/verifier** (`chiefScribe.ts`). Where feasible, enforce **different-family
> verification** (extends inherited **P5 / LD8**). One underlying model **MAY** fill
> multiple logical roles in v0.3 **only if provenance records it**.

**Testing token-cost ladder:** all automated tiers are **T3 (zero token)** — the entire
181-test suite runs with fake fetch/clients, no network. The only T1/T2 cost is incurred
at the **manual in-editor runtime acceptance** (M4), which is not an automated gate. Cost
figures surfaced to the user are **estimates** (CONSTITUTION.md §8); the engine's
`chargeAgent` uses provider `lastUsage` when present and falls back to `estimateTokens`
otherwise (often zero for non-conformant endpoints; CLI seats report zero usage).

---

## 2. Work Module Inventory

Tags: **[R]** reuse (inherited ModelLane shell) · **[E]** extend (additive,
backward-compatible) · **[N]** new/ported. Ids follow ARCHITECTURE.md §2. The inventory
**replaces** the v0.2 Python sidecar node list (N0–N25); the **eliminated** sidecar nodes
are enumerated in §2.6. The build is gated by **`tsc --noEmit` strict + `node:test` (181)
+ the fidelity audit**, not by per-node `.gate_log` files (§7).

### 2.0 Module Topology (DAG)

```
                ┌──────────────── ONE TypeScript process ─────────────────────────┐
  engine/types ─┼─► engine/{config,agent,judge,harvester,ledger,metrics,           │
   H1 http ═════╪═►    research,budget,embeddings} ─► E1 engine/engine (UnitEngine) │
   H2 rng ──────┤            ▲ (E* clients injected by O3, never default-built)     │
   H3 util ─────┘   O9b connectors/egress ═╗                                        │
                    O9a connectors/base ═══╬═► {openai,anthropic,openaiCompatible}┐  │
                    O9f connectors/cli ────╝       (validateEgress on each build) │  │
                    O1 decompose ─┐                                       O3 groupRunner│
                    O8 security ──┤                                        │   │       │
                          ▼       ▼                                        │   ▼       │
                    O7 types ─► O2 scheduler ═(Promise.all per layer)═════►│  O4 panel │
                          │            │                                   │           │
                          │            ▼                                   ▼           │
                          └──► O5 chiefScribe ◄──────────── group interims             │
                    O6 sessionState ◄──┘ (redacted persistence)                        │
                                       ▼                                                │
                    B2 engineService  ◄═(decompose / runSession / executePlan)         │
                          ▲   │ emit(EngineEvent)                                       │
                    B5 registry  B6 secrets ─► B1 controller ─► B3 board                │
                          ▲                         ▲             ▲                      │
                          └─────────────────────────┴── X1 extension.ts ──┘            │
                                                        └─► X2 modelLaneProvider [E]    │
                    (inherited shell R1–R8 reused, not re-gated)                        │
                └──────────────────────────────────────────────────────────────────────┘

   Build gate spans all gated modules: tsc --noEmit (strict) + node:test (181) + fidelity audit.
```

**Critical path (frozen):** `engine/types` → `engine/*` → `orchestrator/*` →
`brainstorm/engineService` → `brainstorm/controller` + `extension.ts`. The CLI connector
(O9f) and the panel engine (O4) **extend, not gate**, the minimal critical path.

### Module E1: `engine/engine.ts` — phase machine + two additive surfaces [E]

| Field | Value |
|-------|-------|
| **Dependencies** | `engine/{types,config,agent,judge,harvester,ledger,metrics,research,budget,embeddings}`, `rng`, `util` |
| **Lang** | TypeScript |
| **Key exports** | `class UnitEngine` — **FROZEN signature** `new UnitEngine({ agentA?, agentB?, judge?, embeddings?, research?, harvester?, rngSeed=1234, onEvent? })`; `async run(config: UnitConfig): Promise<UnitResult>`. The **2 additive surfaces**: `onEvent` inside `log()`; `proposeClashSplit`+`objective` read in the propose/clash envelope. `build()` constructs a default client for a slot **only when one is not injected** (the seam the trap test exploits). |
| **Risk** | 🔴 — a wrong edit silently changes every downstream group; the one place engine purity can break. |
| **Verification** | ① `onEvent` receives the already-emitted phase events (`brief_frozen`, `round0_committed`, `insight_harvested`, `stability_stop`, `keypoint_distilled`, budget warnings) — `bsN1.test.ts`. ② With `onEvent=null` AND both presets absent → engine reproduces the baseline `UnitResult` (the §8 parity test). ③ `proposeClashSplit=[p,c]` overrides the default split; absent → unchanged. ④ `objective` is stored/surfaced as a **label** only. ⑤ a faulty `onEvent` sink is swallowed in a `try/catch` and **never aborts a run**. ⑥ `tsc` strict clean over the engine tree. |
| **Notes** | Always `new UnitEngine({…clients, onEvent}); await engine.run(cfg)` — **never** `new UnitEngine(cfg)` (BLD15/F3). |

### Module E2–E11: ported Unit-Cell engine internals [N]

| Module | Stance | Key export(s) | Verification (node:test file) |
|--------|--------|---------------|-------------------------------|
| `types.ts` (E2) | port | `UnitConfig`/`UnitResult`, `Move`, `IdeaRecord`, enums, `makeUnitConfig` | shapes round-trip; enums exhaustive (`types.test.ts`) |
| `config.ts` (E3) [E] | extend | `UnitConfig` + `proposeClashSplit:[number,number]?` + `objective:string?`; `validateConfig` | defaults reproduce current behavior; `objective` is inert (`config.test.ts`) |
| `agent.ts` (E4) | wrap | `class AgentClient` (OpenAI-shaped `chat`, overridable); `requestSlips`/`requestMove`/`speak`; `extractJson` | `speak/requestSlips/requestMove` funnel through `chat()`; **4xx fails fast** (`HttpError.status`), retry only 5xx + network/timeout (`agent.test.ts`) |
| `judge.ts` (E5) | port-faithful | `class JudgeEngine` (generative+evaluative split P5); attack-graph; `pyRepr` | rubric LD1; swap pass; `pyRepr` renders `True/False` + Python-style quoting (`judge.test.ts`) |
| `harvester.ts` (E6) | wrap | `class Harvester`, `type Extractor` (two extractors) | both extractors connector-built + explicitly injected; **code-point length via spread** (`harvester.test.ts`) |
| `ledger.ts` (E7) | port-faithful | `class IdeaLedger` (dedup/MMR/novelty) | dedup θ + MMR; novelty (`ledger.test.ts`) |
| `metrics.ts` (E8) | port-faithful | entropy / σ_SI / coverage / fixation | σ_SI is a **diversity** metric (LD4), computed at CLOSE (`metrics.test.ts`) |
| `research.ts` (E9) | wrap | `class KnowledgeEngine` (external search OFF by default) | OFF-by-default; guarded; `NoopKnowledgeEngine.routeSearch` returns `''` (`research.test.ts`, `security.test.ts`) |
| `budget.ts` (E10) | port-faithful | `class BudgetTracker` (per-phase guard, token estimate) | guarded at PROPOSE/CLASH round boundaries (`budget.test.ts`) |
| `embeddings.ts` (E11) | wrap | `class EmbeddingsClient` (cosine/jaccard fallback, `degraded`) | injected; cosine/jaccard fallback + `degraded` flag (`embeddings.test.ts`) |

### Module H1: `engine/http.ts` — FetchLike + fetchJson + HttpError [N]

| Field | Value |
|-------|-------|
| **Dependencies** | (none — Node built-ins) |
| **Key exports** | `type FetchLike = typeof fetch`; `const httpFetch: FetchLike` (→ `globalThis.fetch`); `async fetchJson(url, init, timeoutMs=60000, fetchImpl=httpFetch)`; `class HttpError extends Error` with `.status`. |
| **Risk** | 🟡 — the single async I/O chokepoint; injectable for tests; the trap-test boundary. |
| **Verification** | ① `fetchJson` aborts via `AbortController` on timeout. ② a non-2xx throws `HttpError(status, …)` carrying `.status` (so retry loops distinguish 4xx fail-fast from 5xx — matches Python `raise_for_status`). ③ `httpFetch` delegates to the runtime global; tests inject a fake `FetchLike` or trap `globalThis.fetch` (`agent.test.ts`, `totalEgress.test.ts`). |

### Module H2: `engine/rng.ts` — seeded mulberry32 RNG [N]

| Field | Value |
|-------|-------|
| **Dependencies** | (none) |
| **Key exports** | `interface Rng { next; int; shuffle; pick }`; `function makeRng(seed): Rng` (mulberry32 on a uint32 state). |
| **Risk** | 🟢 — pure, deterministic. |
| **Verification** | ① same seed ⇒ reproducible `next()`/`shuffle()`/`pick()` (replaces Python `random.Random`); ② used by the engine for stance shuffles after the brief is frozen, keeping the §8 parity test stable. |

### Module H3: `engine/util.ts` — node:crypto + estimators [N]

| Field | Value |
|-------|-------|
| **Dependencies** | `node:crypto` |
| **Key exports** | `sha256hex(s)` (via `createHash('sha256')` — replaces Python `hashlib`); `estimateTokens(s)` (≈ chars/4); `clamp(x, lo, hi)`. |
| **Risk** | 🟢. |
| **Verification** | ① `sha256hex` matches the Python `hashlib.sha256().hexdigest()` for fixed inputs; ② `estimateTokens` matches the engine budget estimator; covered transitively by `budget.test.ts` + engine tests. |

### Module O1: `orchestrator/decompose.ts` — domain → points + DAG (BESPOKE) [N]

| Field | Value |
|-------|-------|
| **Dependencies** | O7 `types`, O8 `security`, connector-built proposers/moderator |
| **Key exports** | `async decompose(domain, { proposers, moderator, maxPoints=6, emit, sessionId })` — **explicitly NOT a `UnitEngine.run()`** (F6/BLD11). Stages `DECOMP_PREP → ENUMERATE → CRITIQUE → DEDUP → RANK → EMIT`; emits a `KnowledgePointSet` with **TWO point kinds — `atomic` AND `lens`** (Flaw 2/BP11) + a dependency DAG (`requires` hard edge, `informs` soft edge); `resolveCycles` drops REQUIRES edges (last-added first) until acyclic **before** return. Carries its **own** proposers / injection guard / plan validator (`KnowledgePointSet.validate`); does **not** inherit Unit Cell guarantees. |
| **Risk** | 🟡 — admissibility heuristics + cycle resolution are subtle; a bad decomposition gates the whole run (R-DECOMP). |
| **Verification** | ① domain → N admissible points (debatable + atomic + self-contained + distinct + material + tractable) PLUS cross-cutting lenses. ② `KnowledgePointSet.validate()` validates points + DAG edges **before** `CONFIRM_PLAN`; an invalid plan returns problems and blocks the gate (executed == approved). ③ cycles resolved before return. ④ degenerate path: `< 2` admissible points → ask the user to broaden (does **not** pad). ⑤ injected text is **isolated/skipped** by `detectInjection`, never made into a point (DATA-only, F11); user domain text isolated, not disqualified. ⑥ a null-text JSON value is **dropped** (TS), the saner behavior — intentionally NOT the Python literal `"None"` item (accepted LOW divergence, §6.4). (`decompose.test.ts`, `planService.test.ts`) |

### Module O2: `orchestrator/scheduler.ts` + `BudgetGovernor` — DAG → waves [N]

| Field | Value |
|-------|-------|
| **Dependencies** | O7 `types`, O8 `security`, O3 `groupRunner` (via the injected `runOne`) |
| **Key exports** | `async runSession(pointSet, runOne, { emit, maxConcurrency=4, budget })`; `class BudgetGovernor(maxTotalTokens)`. `KnowledgePointSet.topoLayers()` (Kahn over REQUIRES) → **same-layer groups run concurrently via `Promise.all`** (bounded by `maxConcurrency`); cross-layer **sequential** in topological order; each downstream group receives predecessor interims as a **quarantined "prior claims" block** (`quarantinePriorClaims`, Flaw 3); `BudgetGovernor` accumulates each group's `totalTokens` and **stops scheduling** at the absolute cap (cost-DoS control, R-COST/S9). |
| **Risk** | 🔴 — concurrency + budget correctness; cost-DoS surface (R4). |
| **Verification** | ① same-DAG-layer groups run **in parallel** (`Promise.all`); cross-layer **sequentially**. ② a per-group failure is isolated into `GroupResult.error` (worker `try/catch`), never aborting the layer (mirrors the former thread-pool `as_completed`). ③ the absolute `BudgetGovernor` cap stops scheduling and emits `event/budget {stopped:true}`. ④ results returned in point order. (`scheduler.test.ts`) |

### Module O3: `orchestrator/groupRunner.ts` — point → injected `UnitEngine.run()` [N]

| Field | Value |
|-------|-------|
| **Dependencies** | E1 `engine`, O9 `connectors`, O8 `security`, O7 `types`, O4 `multiDebate` |
| **Key exports** | `async runGroup(spec, clients, { emit? })`; `clientsFromConnectors(roleMap, connectors, { researchEnabled })`; `makeGroupClients(...)`; `runPoint(...)`. Maps `agentA/agentB → makeAgentClient` (persona→`systemPrompt`, temp, family), `judge → makeAgentClient`; builds the embeddings + `Harvester` (primary = judge client, second = agentB client) and `research` (or `NoopKnowledgeEngine` when OFF) — **all explicitly injected**; applies the mode preset; calls the engine with the **FROZEN F3 signature** `new UnitEngine({ agentA, agentB, judge, embeddings, research, harvester, onEvent: sink, rngSeed }); await engine.run(cfg)`. Routes `> 2` debater seats to the panel (O4). |
| **Risk** | 🔴 — on the critical path; the seam where connectors meet the engine; a missed injected slot is R-EGRESS-BYPASS. |
| **Verification** | ① one point + RoleMap + mode → exactly one `UnitEngine.run()` with **injected** clients (no default construction). ② **TOTAL-EGRESS trap (R-EGRESS-BYPASS):** every engine slot is connector-built and injected; the `globalThis.fetch` trap stays silent and a valid interim is still produced (`totalEgress.test.ts`). ③ research OFF → `NoopKnowledgeEngine` injected (never the default `KnowledgeEngine`). ④ predecessor interims passed as a **quarantined "prior claims" block**. ⑤ harvester built **explicitly** with injected extractors. ⑥ `Interim` returned is a projection of `UnitResult` only. (`groupRunner.test.ts`, `totalEgress.test.ts`) |

### Module O4: `orchestrator/multiDebate.ts` — >2-debater panel [N]

| Field | Value |
|-------|-------|
| **Dependencies** | E1 `engine` primitives, O7 `types` |
| **Key exports** | N-debater **panel** engine — running **more than two** debate models in one group, reusing the engine primitives. **Built**, no longer deferred (BP7/BLD6). Selected automatically by `groupRunner`/`engineService` when a `RoleMap` carries `> 2` debater seats. |
| **Risk** | 🟡 — off the minimal critical path; a sibling per-group runner, **not** an engine fork. |
| **Verification** | ① a RoleMap with `> 2` debaters routes to the panel; ② the default two-debater path remains a single `UnitEngine.run()`. (`multiDebate.test.ts`) |

### Module O5: `orchestrator/chiefScribe.ts` — cross-group synthesis [N]

| Field | Value |
|-------|-------|
| **Dependencies** | O7 `types`, scribe client |
| **Key exports** | `async aggregate(domain, mode, pointSet, results, { scribe, emit, sessionId })`. Cross-group dedup; contradiction **detect + present** (cluster; classify agree/contradict; down-weight same-family agreement; two GROUNDED opposing claims → report both); emergent-finding surfacing across lenses + points; a `Report` builder that **ENFORCES uncertainty** (evidence status per claim; "What we are NOT sure about"; contradictions table; provenance per key point with role + model family; grounded conclusions separated from high-novelty candidates). |
| **Risk** | 🔴 — synthesis quality is the product; T2 seat; honesty stakes highest here. |
| **Verification** | ① report sections in fixed order: Executive synthesis → Decomposition map → Per-point in topological order (each with a mandatory "Flagged candidates" block, LD7) → Cross-cutting findings → Contradictions table → "What we are NOT sure about" → Provenance & metrics. ② contradictions **never auto-resolved**. ③ σ_SI shown as a **diversity** signal; `confidence_label` derived, never fabricated. ④ grounded conclusions separated from high-novelty candidates. ⑤ the exec-prompt is built with a **single-pass regex replacer** (no `$`-sequence / sequential-bleed bug — fidelity fix, §6.4). ⑥ empty participation JOIN falls back to `'n/a'` (fidelity fix). (`chiefScribe.test.ts`) |

### Module O6: `orchestrator/sessionState.ts` — redacted persistence [N]

| Field | Value |
|-------|-------|
| **Dependencies** | O7 `types`, O8 `security` (`redact`) |
| **Key exports** | `class SessionStore`: `saveGroupResult` / `saveState` persist **redacted** per-group interims + a session-state snapshot under a base dir (`context.globalStorageUri`, **never the repo** — there is no sidecar cwd anymore). |
| **Risk** | 🟡 — never persist secrets. |
| **Verification** | ① every written string passes through `redact()` (deep over objects) → no secret in a persisted artifact (S8/F5). ② paths live under `globalStorageUri` only. (`security.test.ts`, `sessionService.test.ts`) |

### Module O7: `orchestrator/types.ts` — shared data model + DAG helpers [N]

| Field | Value |
|-------|-------|
| **Dependencies** | E2 `engine/types` (for the `UnitResult` projection) |
| **Key exports** | `KnowledgePoint{id,text,kind:'atomic'|'lens',rationale}`, `DependencyEdge{src,dst,kind:'requires'|'informs'}`, `class KnowledgePointSet` (`topoLayers`/`predecessors`/`hasCycle`/`validate`), `RoleMap{agentA,agentB,judge,harvester?,debaters?}`, `SeatConfig`, `GroupSpec`, `Interim`/`GroupResult`/`GroupEvent`, `ModeProfile`, `modeProfile(mode, pointKind)`, the dict serializers (`interimConclusionToDict`/`groupEventToDict`/`brainstormReportToDict`). The CANONICAL MODE PRESET TABLE selector lives in `modeProfile()`; full table in CONSTITUTION §7.6. |
| **Risk** | 🟢 — data + pure helpers (granularity exception). |
| **Verification** | ① `Interim` is a strict **projection of `UnitResult`** (no new engine fields). ② `SeatConfig.role` enum matches the four engine slots only. ③ `KnowledgePointSet.validate()` flags duplicate ids, `< 2` points, empty text, invalid kind, dangling edges, invalid edge kind, residual REQUIRES cycle. ④ `topoLayers` is Kahn over REQUIRES edges. (`types.test.ts`) |

### Module O8: `orchestrator/security.ts` — quarantine + redaction [N]

| Field | Value |
|-------|-------|
| **Dependencies** | O7 `types` |
| **Key exports** | `detectInjection(text)`, `wrapUntrusted(text, provenance)`, `quarantinePriorClaims(summary, sourcePointId)`, `redact(text|obj, secrets)`, `class NoopKnowledgeEngine`. |
| **Risk** | 🔴 — silent failure here is a correctness landmine (cross-agent injection, R3). |
| **Verification** | ① malicious decomposition / inter-group / scribe inputs are wrapped + isolated (with user-visible notice + explicit user confirmation before re-plan, F11). ② `redact()` strips secrets from logs/errors/reports/exports **and persisted session metadata** (S8/F5). ③ model structured outputs parsed DATA-only; extra/executable fields rejected. ④ user domain text isolated as user-data and **never disqualified**. ⑤ `NoopKnowledgeEngine.routeSearch` returns `''` (zero network). (`security.test.ts`) |

### Module O9a–O9g: `orchestrator/connectors/*` — connector layer + TOTAL egress guard [N]

| Module | Key export(s) | Verification (node:test file) |
|--------|---------------|-------------------------------|
| `base.ts` (O9a) | `interface ConnectorInterface`; `class BaseConnector` (OpenAI-compatible); `makeAgentClient`/`makeEmbeddingsClient` — `validateEgress` at construction **and each build** | a stub satisfies the interface; egress re-validated on every build (`connectors.test.ts`) |
| `egress.ts` (O9b) | `validateEgress(baseUrl, allowRemote?, allowlist?)`; `makeGuardedFetch(inner?, allowRemote?, allowlist?)`; `class EgressError`; IP classification | **THE total guard**: loopback/private/link-local allowed; remote requires `allowRemote` + allowlist + https; cloud-metadata always blocked (`egress.test.ts`) |
| `openai.ts` (O9c) | `class OpenAIConnector` (stock `AgentClient`, Codex-style persona seat) | remote-by-nature; allowlist + https enforced by egress (`connectors.test.ts`) |
| `anthropic.ts` (O9d) | `class AnthropicConnector` + `class AnthropicAgentClient` (overrides **only** `chat` + `lastUsage`) | Messages API shape; `usage.input_tokens/output_tokens` → `lastUsage`; retries only 5xx + network/timeout (`connectors.test.ts`) |
| `openaiCompatible.ts` (O9e) | local connector (LM Studio / llama.cpp / Ollama; loopback-default) | loopback default; remote blocked without opt-in (`connectors.test.ts`, `egress.test.ts`) |
| `cli.ts` (O9f) | `class CliConnector` + `class CliAgentClient` (overrides **only** `chat`) — sandboxed CLI subprocess | `shell:false` + argv list; bounded temp cwd; no managed key in argv/env; per-call timeout (SIGKILL) + output cap (`cli.test.ts`; §9.1) |
| `factory.ts` (O9g) | `makeConnector(kind, id, baseUrl, opts)` dispatch incl. `'cli'` | every `kind` dispatches to the right adapter (`connectors.test.ts`) |

### Module B1: `brainstorm/controller.ts` — chat-turn driver + CONFIRM_PLAN [N]

| Field | Value |
|-------|-------|
| **Dependencies** | B2 `engineService`, B5 `connectorRegistry`, B6 `secrets` |
| **Key exports** | `class BrainstormController`: the multi-turn **CONFIRM_PLAN** gate — new-session detection → `decompose` + propose plan → store pending plan keyed on the conversation's **first user message** (`firstUserText`) → on approval (`go|run|proceed|yes|…`) `executePlan`; `autoConfirmPlan=true ⇒` single-turn `runSession`. Collects secrets one-shot per run (`getSecrets`); saves the redacted Markdown report under `globalStorageUri/reports` (path-validated + slugged). |
| **Risk** | 🔴 — session-identity across VS Code chat turns; the CONFIRM_PLAN correctness gate. |
| **Verification** | ① `autoConfirmPlan` true → single-turn `runSession`; false → propose-then-execute. ② the executed plan == the approved plan. ③ `< 2` points or any validation problem → report + ask to broaden, do not proceed. ④ secrets snapshot collected before any engine call; report saved redacted under `globalStorageUri`. (covered by `service.test.ts`, `planService.test.ts`, `sessionService.test.ts`) |

### Module B2: `brainstorm/engineService.ts` — in-process façade (replaces `rpc_server.py`) [N]

| Field | Value |
|-------|-------|
| **Dependencies** | O1 `decompose`, O2 `scheduler`, O3 `groupRunner`, O5 `chiefScribe`, O9 `connectors`, O7 `types` |
| **Key exports** | `interface EngineEvent { method: string; params: any }`; `type EmitEngineEvent`; `type SecretsAccessor = () => Record<string,string>`; `class EngineService(emit, secretsAccessor, executors={})` with async `runGroup` / `runSession` / `decompose` / `executePlan`. Injectable executors `defaultExecutor` / `defaultSessionExecutor` / `defaultDecomposeExecutor` / `defaultExecuteExecutor` wrapping the shared helpers `buildConnectors` / `roleMapFromParams` / `psetFromParams` / `decomposeImpl` / `executeImpl`. `groupEmit()` bridges each `GroupEvent` to `{ method: 'event/'+kind, params: groupEventToDict(event) }`. |
| **Risk** | 🔴 — the boundary where the controller meets the engine; secrets live here in memory only (via the accessor). |
| **Verification** | ① each async method dispatches to its (injectable) executor with `(params, secretsAccessor(), groupEmit())`. ② `decompose` returns `{points, edges, problems}` (NO debates); `executePlan` runs an approved plan; `runSession` does decompose+execute in one call. ③ events carry `event/...` method strings preserved from the sidecar design. ④ params are snake_case dicts from `connectorRegistry`; nothing secret is ever returned or persisted (S2/F5). ⑤ a faulty `emit` never aborts a run. (`engineServiceRpc.test.ts`, `service.test.ts`) |

### Module B3–B6: extension glue (live board, admin, registry, secrets) [N]

| Module | Key export(s) | Verification |
|--------|---------------|--------------|
| `brainstormViewProvider.ts` (B3) | live board (DAG + group accordions); CSP `default-src 'none'` + nonce + empty `localResourceRoots`; `textContent`-only render | renders group/phase events; Markdown only in the saved file; forged postMessage rejected (S7) |
| `adminConsolePanel.ts` (B4) | seats/roles/modes/connectors/budgets editor; API keys via `showInputBox(password)` → SecretStorage; **no secret in the panel**; exposes the CLI connector kind + its sandbox toggles | edits persist via B5 (secret-free); secret captured only into B6; CLI sandbox `allowFileTools` OFF by default |
| `connectorRegistry.ts` (B5) | secret-free `ConnectorDef[]` catalog; `buildSessionParams` / `buildExecuteParams` (snake_case param shaping) | catalog carries `{id,kind,base_url,…}` only — no secret; CLI def carries no key (own login) |
| `secrets.ts` (B6) | SecretStorage wrapper; `collect(connectorIds)` into the in-memory snapshot read by `secretsAccessor` | store/retrieve by connectorId; plaintext never written to settings/logs; provided once per run only (S1/S2) |

### Module X1/X2: shell — activation + synthetic-model branch [E]

| Module | Key export(s) | Verification |
|--------|---------------|--------------|
| `extension.ts` (X1) | `activate`: constructs the in-process `EngineService` (`new EngineService(ev => board.postEvent(ev), () => controller.getSecrets())`) — **no spawn**; registers the `modellane-brainstrom` provider + view + commands; `deactivate()` reaps **no child** (the engine is in-process; a mid-call CLI subprocess is bounded by its own timeout) | provider/view/commands registered under `brainstrom.*`; no orphan process; `EngineService` wired to board + secretsAccessor |
| `modelLaneProvider.ts` (X2) [E] | inject the synthetic **🧠 Brainstorm Debate Model** **after the sort**; discriminated `kind:"brainstrom"`; **branch on `kind` in BOTH `provideLanguageModelChatResponse` AND `provideTokenCount`** before any delegate access; visible with **no local model loaded** | synthetic entry appears with no local model; response + token-count branch before delegate; delegate path intact (regression) (F2) |

### 2.6 ELIMINATED nodes (present in the v0.2 sidecar design, removed in v0.3)

These are stated as **removed**, not migrated. They have **no build table and no test**
in the TS runtime.

| Removed node (v0.2)                              | Why it is gone |
|-------------------------------------------------|----------------|
| `sidecarManager.ts` (was N15)                   | no subprocess to spawn / health-poll / cancel / restart / kill — the engine is in-process |
| `rpc_server.py` (was N12)                        | replaced by the in-process `EngineService` façade (B2) |
| JSON-RPC 2.0 + Content-Length stdio framing      | no wire protocol — methods are direct `await` calls; events are `emit(EngineEvent)` callbacks |
| `session.provisionSecrets` stdio handshake       | replaced by an in-memory `secretsAccessor` closure (B6 → controller snapshot → B2) |
| Python runtime bootstrap (was N21)               | no interpreter discovery; no `python/requirements.txt`; no `requests`; the numpy concern is moot |
| `brainstrom.pythonPath` setting                  | removed from `package.json` configuration |
| `verify_gate.py` + `.gate_log/*.json` harness    | replaced by `tsc --noEmit` strict + `node:test` (181) + the fidelity audit (§7) |
| Risk **R-PY** (Windows Python bootstrap)         | **retired** — there is no Python to bootstrap |

---

## 3. Parallel Build Strategy — Work Route Map (port waves)

### 3.1 Dependency Analysis

The build is a strict acyclic port. The **contract layer** (engine data model + the new
HTTP/RNG/util helpers) unblocks everything; the **leaf engine internals** and the
**connector + security** mid-layer feed the **group runner**; the orchestration converges
on the in-process **`engineService`** façade, which the controller and `extension.ts`
drive directly. There is **no stdio seam** — the former Python/TS boundary collapses into
a single in-process call edge.

```
  engine/types + H1 http + H2 rng + H3 util ── unblock ──► all engine internals + connectors
  engine/{config,agent,judge,harvester,ledger,metrics,research,budget,embeddings} ──► E1 engine
  connectors/egress ──► connectors/base ──► {openai,anthropic,openaiCompatible}; connectors/cli
  orchestrator/{types,security} ──► O1 decompose, O2 scheduler, O5 chiefScribe
  E1 + connectors + O8 ──► O3 groupRunner  ◄── convergence (critical-path knee)
  O3 ──► O2 scheduler ──► O5 chiefScribe                    (orchestration spine)
  O1,O2,O3,O5,O9 ──► B2 engineService  ──► B1 controller ──► X1 extension + X2 provider
  O4 multiDebate (panel) and O9f cli connector EXTEND O3, off the minimal critical path
  all ──► the test suite (src/test/*) + the fidelity audit
```

### 3.2 Build Waves — the actual port waves (ASCII timeline)

The waves are the **order the port was actually executed**, bottom-up along the
dependency DAG. Each wave's gate is `tsc --noEmit` strict clean for the wave's modules
plus the wave's `node:test` files green.

```
Wave   What is ported / built ──────────────────────────────────────────────────────────►
W0  ┌ CONTRACT ─────────────────────────────────────────────────┐
    │ engine/types  +  H1 http  +  H2 rng  +  H3 util            │  the type system + async/
    │   (FetchLike, fetchJson, HttpError; makeRng; sha256hex)    │  determinism contract
    └────────────────────────────────────────────────────────────┘
            │
W1          ┌ ENGINE LEAVES ───────────────────────────────────────────────────────┐
            │ orchestrator/types · config · budget · embeddings · agent · research   │
            │   (pure-data + the network leaves on the FetchLike)                    │
            └────────────────────────────────────────────────────────────────────────┘
                    │
W2                  ┌ MID-LAYER ────────────────────────────────────────────────────┐
                    │ ledger · metrics · orchestrator/security · connectors/egress    │
                    │   (dedup/MMR/σ_SI + quarantine/redact + the TOTAL egress guard) │
                    └──────────────────────────────────────────────────────────────────┘
                            │
W3                          ┌ VERIFIERS + CONNECTOR BASE ──────────────────────────┐
                            │ judge · harvester · connectors/base                   │
                            └────────────────────────────────────────────────────────┘
                                    │
W4                                  ┌ ENGINE CORE + CONNECTOR ADAPTERS ───────────┐
                                    │ engine/engine (UnitEngine, 2 surfaces)       │
                                    │ connectors/{openai,anthropic,openaiCompatible,cli,factory} │
                                    └────────────────────────────────────────────────┘
                                            │
W5                                          ┌ ORCHESTRATOR CORE ─────────────────┐
                                            │ decompose · scheduler · groupRunner │
                                            │ multiDebate · chiefScribe · sessionState │
                                            └──────────────────────────────────────┘
                                                    │
W6                                                  ┌ FAÇADE ───────────────┐
                                                    │ brainstorm/engineService│  (replaces
                                                    │   (the in-process facade)│   rpc_server.py)
                                                    └──────────────────────────┘
                                                            │
W7                                                          ┌ WIRING ──────────────────────┐
                                                            │ controller · connectorRegistry │
                                                            │ secrets · brainstormViewProvider│
                                                            │ adminConsolePanel · extension   │
                                                            │ modelLaneProvider (synthetic)   │
                                                            └──────────────────────────────────┘
                                                                    │
W8                                                                  ┌ TESTS + AUDIT ──────┐
                                                                    │ src/test/* (181)     │
                                                                    │ + port-fidelity audit│
                                                                    └────────────────────────┘
```

> **Why bottom-up.** A port must compile leaf-first: the engine data model + the
> async/determinism helpers (`http`/`rng`/`util`) are the contract every other module
> imports, so they go first; `engine/engine` cannot be ported until its verifiers
> (`judge`/`harvester`) and clients exist; the orchestrator cannot run a group until the
> connectors + the egress guard exist; the façade cannot exist until the orchestration
> does; the wiring cannot exist until the façade does; and the trap/parity/e2e tests are
> meaningful only once the whole stack is in place. Each wave is `tsc`-clean before the
> next begins.

### 3.3 Wave Detail

| Wave | Modules | Gate condition |
|------|---------|----------------|
| **W0** | `engine/types`, `http`, `rng`, `util` | `tsc` clean; `types.test.ts` green; `makeRng` reproducible |
| **W1** | `orchestrator/types`(*data*), `config`, `budget`, `embeddings`, `agent`, `research` | `tsc` clean; `config/budget/embeddings/agent/research.test.ts` green; 4xx fail-fast verified |
| **W2** | `ledger`, `metrics`, `orchestrator/security`, `connectors/egress` | `ledger/metrics/security/egress.test.ts` green; egress loopback-default + metadata-block proven |
| **W3** | `judge`, `harvester`, `connectors/base` | `judge/harvester.test.ts` green; code-point + pyRepr fidelity fixes in |
| **W4** | `engine/engine`, `connectors/{openai,anthropic,openaiCompatible,cli,factory}` | `engine.test.ts` (16) green; the **two-surface contract** (`bsN1.test.ts`) green; `connectors.test.ts`, `cli.test.ts` green |
| **W5** | `decompose`, `scheduler`, `groupRunner`, `multiDebate`, `chiefScribe`, `sessionState` | orchestration tests green; **`totalEgress.test.ts` green** (trap proven); `chiefScribe` single-pass replacer + 'n/a' fallback in |
| **W6** | `brainstorm/engineService` | `engineServiceRpc.test.ts`, `service.test.ts` green; events `event/*` preserved; secrets via accessor |
| **W7** | `controller`, `connectorRegistry`, `secrets`, `brainstormViewProvider`, `adminConsolePanel`, `extension`, `modelLaneProvider` | `planService/sessionService.test.ts` green; synthetic-model branch (F2); CONFIRM_PLAN gate |
| **W8** | `src/test/*` + the fidelity audit | full suite **181/181**; the 10-module audit faithful or documented-divergence; **package** the vsix |

### 3.4 Critical Path

```
   CRITICAL PATH (frozen):
   engine/types ═► engine/* ═► orchestrator/* ═► brainstorm/engineService ═►
                   brainstorm/controller + extension.ts
   ────────────────────────────────────────────────────────────────────────
   engine/types        (W0)
   H1 http             (W0)  ◄ the injectable async I/O contract (FetchLike)
   engine/engine       (W4)  ◄ the 2 additive surfaces (bsN1 parity)
   connectors/egress   (W2)  ◄ the TOTAL egress guard
   groupRunner         (W5)  ◄ connector↔engine seam (F3 signature; total-egress trap)
   scheduler           (W5)  ◄ Promise.all per layer + absolute BudgetGovernor
   chiefScribe         (W5)  ◄ synthesis (the product)
   engineService       (W6)  ◄ in-process façade (replaces rpc_server.py)
   controller          (W7)  ◄ intake + CONFIRM_PLAN (F7)

   The security branch (security → egress) and the data/serialization branch
   (orchestrator/types) run in parallel and feed groupRunner / engineService
   without setting the pace. chiefScribe and controller are the heaviest single
   modules. multiDebate (panel) and connectors/cli are off the critical path.
```

### 3.5 Parallelisation Rules

1. **Wave integrity** — all modules in a wave must reach `tsc`-clean + their tests green
   before the next wave begins.
2. **No partial handoff** — do not start a convergence module (`groupRunner`,
   `scheduler`, `chiefScribe`, `engineService`) until ALL its dependencies compile and
   pass.
3. **Agent independence** — each module in a parallel wave is assigned to a different
   agent; no shared mutable context.
4. **Bottom-up port order** — leaf contract first (`engine/types`+`http`/`rng`/`util`),
   then leaves, then mid, then verifiers, then engine core + adapters, then orchestrator
   core, then façade, then wiring, then tests + audit (§3.2).
5. **Engine purity lock** — only the two additive surfaces (E1/E3) may touch
   `src/engine/` behavior; any other behavioral change must instead orchestrate above it
   (T1). The faithful port is enforced by the fidelity audit (§6.4).
6. **Fallback to sequential** — if only 1 agent is available, follow the §5 build order
   linearly; the wave gates still apply.

---

## 4. Quality Checkpoints

### 4.1 Per-Module Gate Sequence

Every module passes through this sequence before its output is accepted (mirrors §1.2):

```
  ┌──────────┐   ┌──────────────────┐   ┌──────────────┐   ┌────────────────┐
  │ Code     │──►│ tsc --noEmit      │──►│ node --test   │──►│ Regression      │
  │ Complete │   │ (strict; 0 errors)│   │ (this module's│   │ (full 181 suite │
  └──────────┘   └──────────────────┘   │  *.test.ts)   │   │  + parity + audit)│
                                          └──────────────┘   └───────┬────────┘
                                                                     ▼
                                                              ┌────────────┐
                                                              │  ✅ Done    │
                                                              │ (committed) │
                                                              └────────────┘
```

Commands at each gate:

```bash
# any TS module
npx tsc --noEmit -p ./tsconfig.json          # type+lint gate (strict) — 0 errors
npm test                                       # pretest=tsc; node --test "out/test/**/*.test.js" (181)
#   (the module's own *.test.ts must be green; the FULL suite is the regression gate)
# fidelity audit: re-diff the touched engine module vs the Python source (§6.4)
```

There is **no `verify_gate.py`, no `.gate_log/`, no integration round-trip harness** —
those existed to gate the Python sidecar (§2.6, §7).

### 4.2 Milestone Gates M1–M4

The milestone semantics are preserved, but their **evidence** is now `tsc` + `node:test`
+ in-editor acceptance, and **M1's top v0.2 risk (R-PY) no longer exists** (there is no
interpreter to bootstrap).

| Milestone | Requirements | Evidence | Sign-off |
|-----------|--------------|----------|----------|
| **M1 — Walking skeleton** | Engine contract (W0) + leaves/mid/core enough to run one group: pick the synthetic model → **one OpenAI-compatible seat pair** routed through the **egress guard** → `new UnitEngine({ … , onEvent: sink }).run(cfg)` (F3) on a hard-coded point → **one `group.interim`** rendered in the real sidebar from the real synthetic entry. | `groupRunner.test.ts` + `totalEgress.test.ts` green for a single group; `bsN1.test.ts` parity green; `tsc` clean. **R-PY is retired** — the surviving M1 risks are R-STREAM (granularity) and engine↔connector egress routing. | Developer |
| **M2 — Orchestration (headless)** | `decompose` + `scheduler` + `engineService`: domain → N points (atomic + lenses) → parallel + sequential DAG executes **headless**; absolute `BudgetGovernor` cap honored; injected text isolated; `KnowledgePointSet.validate()` before CONFIRM_PLAN. | `scheduler.test.ts`, `decompose.test.ts`, `planService.test.ts`, `engineServiceRpc.test.ts`, `totalEgress.test.ts` green; `tsc` clean. | Developer |
| **M3 — Synthesis + façade** | `chiefScribe` + the full `engineService` + `sessionState` + the CLI connector + the panel: full pipeline in-process; `EngineEvent` stream + cooperative cancel; redacted persistence; CLI sandbox controls verified. | `pipeline.test.ts`, `chiefScribe.test.ts`, `service.test.ts`, `multiDebate.test.ts`, `cli.test.ts`, `sessionService.test.ts` green; `tsc` clean. (No "RPC observed over the wire" — events are in-process callbacks.) | Developer |
| **M4 — Ship-ready (end-to-end in VS Code)** | Full wiring: synthetic model selectable → intake → CONFIRM_PLAN → live board → saved report (uncertainty sections), end-to-end against LM Studio (local) and/or one remote connector, on the user's machine. | **`tsc` strict CLEAN (0 errors); 181/181 `node:test`; packaged `modellane-brainstrom-ts-0.3.0.vsix`** (the automated portion is DONE). The **live in-editor model run is the single remaining manual sign-off.** | Developer (manual) |

---

## 5. Build Order

```
W0 — Contract (leaf-first; unblocks everything)
  engine/types          → Gate: tsc clean; types.test.ts green
  engine/http (FetchLike, fetchJson, HttpError) → Gate: AbortController timeout; HttpError.status
  engine/rng  (makeRng mulberry32)              → Gate: reproducible shuffle for fixed seed
  engine/util (sha256hex node:crypto, estimateTokens, clamp) → Gate: hash matches hashlib

W1 — Engine leaves + data
  orchestrator/types (data + DAG helpers)  → Gate: Interim is a UnitResult projection; validate()
  config (proposeClashSplit/objective)     → Gate: defaults reproduce current behavior
  budget · embeddings · agent · research   → Gate: agent 4xx fail-fast; research OFF by default

W2 — Mid-layer
  ledger · metrics                         → Gate: dedup/MMR; σ_SI diversity
  orchestrator/security                    → Gate: wrap/detect/redact/Noop; user-data isolated
  connectors/egress                        → Gate: loopback-default + metadata block + https (the TOTAL guard)

W3 — Verifiers + connector base
  judge                                    → Gate: rubric LD1; swap; pyRepr fidelity
  harvester                                → Gate: two extractors; code-point length (spread)
  connectors/base                          → Gate: egress re-validated each build

W4 — Engine core + connector adapters
  engine/engine (UnitEngine, 2 surfaces)   → Gate: bsN1.test.ts parity + onEvent fires (§8)
  connectors/{openai,anthropic,openaiCompatible,cli,factory} → Gate: connectors.test.ts + cli.test.ts

W5 — Orchestrator core
  decompose (bespoke; NOT a run)           → Gate: two point kinds; cycles pre-resolved; validate before CONFIRM
  scheduler + BudgetGovernor               → Gate: Promise.all per layer; absolute cap; error isolation
  groupRunner                              → Gate: one injected UnitEngine.run() (F3); total-egress trap silent
  multiDebate (panel)                      → Gate: >2 debaters route to panel
  chiefScribe                              → Gate: present-not-resolve; uncertainty enforced; single-pass replacer
  sessionState                             → Gate: redacted persistence under globalStorageUri

W6 — Façade
  brainstorm/engineService                 → Gate: async methods (former RPC); EngineEvent emit; injectable executors

W7 — Wiring (UX + shell)
  controller (CONFIRM_PLAN)                → Gate: executed == approved; single-turn when autoConfirmPlan
  connectorRegistry · secrets              → Gate: secret-free catalog; one-shot in-memory snapshot
  brainstormViewProvider · adminConsolePanel → Gate: CSP + textContent; no secret in panel
  extension.ts · modelLaneProvider.ts      → Gate: in-process EngineService built (no spawn); synthetic branch (F2)

W8 — Tests & audit
  src/test/* (181)                         → Gate: full node:test suite green
  port-fidelity audit (10 modules)         → Gate: faithful or documented LOW divergence (§6.4)
  package                                  → Gate: npx @vscode/vsce package → modellane-brainstrom-ts-0.3.0.vsix
```

---

## 6. Verification Strategy

### 6.1 Layers Table

| Layer | Method | Tier | Coverage |
|-------|--------|------|----------|
| Type+Lint | `tsc --noEmit -p ./tsconfig.json` (strict, ES2022) | — | every module (0 errors) |
| Unit | `node --test` (isolated; fake `FetchLike` + fake clients) | T3 — Mock | every engine/orchestrator/glue module |
| In-process e2e | `pipeline.test.ts` (domain → report, fake clients) + `engineServiceRpc.test.ts` (façade) | T3 — Mock | the whole stack (replaces the v0.2 sidecar e2e) |
| Connector-contract | `connectors.test.ts`, `cli.test.ts` (fake fetch / fake subprocess) | T3 — Mock | base/openai/anthropic/local/cli adapters; Anthropic `chat`+`lastUsage` |
| **Total-egress (trap)** | `totalEgress.test.ts` — `globalThis.fetch` trap throws on any call | T3 — Mock | `groupRunner` all-slots injection; `NoopKnowledgeEngine` when research off |
| Decomposition-validate | `decompose.test.ts`, `planService.test.ts` — `KnowledgePointSet.validate()` | T3 — Mock | points (atomic + lenses) + edges; reject-before-CONFIRM_PLAN |
| Injection-adversarial | `security.test.ts`, `decompose.test.ts` — canned attack strings | T3 — Mock | quarantine + isolate; data-only parsing; user-data not disqualified |
| Scheduler/DAG | `scheduler.test.ts` | T3 — Mock | parallel layers + sequential deps; per-group error isolation; budget abort |
| Engine-parity (golden) | `bsN1.test.ts` | T3 — Mock | the two-surface contract (§8) |
| Manual runtime acceptance | live LM Studio / remote run in VS Code | T1 + T2 | M4 — the single non-automated sign-off |

### 6.2 Concrete Test Cases

- **Walking skeleton / M1 (the decisive test):** from VS Code, pick the synthetic model →
  one hard-coded point runs through an injected, egress-guarded OpenAI-compatible seat
  pair → one `group.interim` renders in the sidebar. The engine is called with the
  **verified F3 signature** `new UnitEngine({ … , onEvent: sink }).run(cfg)`. The
  automated proxy is `groupRunner.test.ts` + `totalEgress.test.ts`.
- **Connector-contract tests (fake fetch / fake subprocess):** OpenAI + Anthropic + local
  adapters produce engine-compatible clients; `AnthropicAgentClient.chat` populates
  `lastUsage` (`input_tokens`/`output_tokens`); the CLI connector frames a turn with
  `shell:false` + argv list and redaction (`connectors.test.ts`, `cli.test.ts`).
- **Total-egress trap tests (R-EGRESS-BYPASS):** (a) negative control — the engine's own
  default `AgentClient`/`EmbeddingsClient`/`KnowledgeEngine` all trip the `globalThis.fetch`
  trap (the trap is real and total); (b) full injection via `runGroup(makeSpec(),
  makeClients())` → the trap **never fires** and a valid interim is still produced
  (`trap.calls() === 0`, `res.error === null`, `res.interim !== null`). This makes **total
  egress containment a proven property**, not a claim (`totalEgress.test.ts`).
- **Decomposition-validate tests:** points (atomic + cross-cutting lenses) and DAG edges
  validate via `KnowledgePointSet.validate()` **before** CONFIRM_PLAN; an invalid plan
  returns problems and blocks the gate; a null-text JSON value is dropped (TS divergence,
  §6.4) (`decompose.test.ts`, `planService.test.ts`).
- **Injection-adversarial tests:** malicious decomposition / inter-group / scribe inputs
  are wrapped + isolated; model structured outputs are parsed DATA-only; **user domain
  text is isolated as user-data, not disqualified**; `redact()` strips secrets from
  persisted session metadata (`security.test.ts`).
- **Egress tests:** loopback/private allowed by default; remote blocked until
  `allowRemote` + allowlist + https; cloud-metadata (`169.254.169.254`) always blocked
  (`egress.test.ts`).
- **Budget/cancel:** the absolute `BudgetGovernor` cap stops scheduling and emits
  `event/budget {stopped:true}`; per-call `AbortController` timeout bounds I/O; 4xx fails
  fast (`HttpError.status`); cooperative cancel checks the VS Code `CancellationToken` at
  turn boundaries (no remote process to terminate) (`scheduler.test.ts`, `agent.test.ts`).
- **Scheduler/DAG tests:** parallel layers via `Promise.all` + sequential dependencies in
  topological order with predecessor context passed as a **quarantined prior-claims
  block**; a per-group failure is isolated, never aborting the layer
  (`scheduler.test.ts`).
- **Engine-parity tests (§8):** `onEvent=null` and absent presets reproduce the baseline
  `UnitResult`; `onEvent` fires the already-emitted phase events; `proposeClashSplit`
  overrides the split (`bsN1.test.ts`).
- **CLI-subprocess sandbox tests:** `shell:false` + argv list (no shell interpolation / no
  command injection); bounded temp cwd; no managed key in argv/env; per-call timeout +
  output cap (`cli.test.ts`; §9.1).
- **Synthetic-model branch tests (F2):** synthetic model appears with no local models
  loaded; the delegate path is intact; token-count branches before any missing-delegate
  access (covered by the provider wiring; X2).
- **In-process e2e:** full domain → report, in-process, fake clients (`pipeline.test.ts`);
  the **live** run against LM Studio / one remote connector is the M4 manual sign-off.

### 6.3 Suite Result (FROZEN)

```
$ npx tsc --noEmit -p ./tsconfig.json        →  0 errors (strict CLEAN)
$ npm test                                    →  ℹ tests 181 · pass 181 · fail 0 · skipped 0
                                                 (27 files; zero network, zero tokens; ~0.4 s)
```

This **replaces** the v0.2 Python gate harness (`verify_gate.py`, `.gate_log/*.json`,
`ruff`/`pytest`/`mypy`). The 181 tests are the full former pytest suite, ported to
`src/test/*.test.ts` with fake fetch/clients.

### 6.4 Port-Fidelity Audit (quality gate)

A **10-module adversarial audit** was run against the Python source — diffing the TS
behavior module-by-module against the original. This is a first-class quality gate (DoD
criterion 5; §1.2 Fidelity row) and is the TS replacement for the v0.2 "byte-identity
golden vs the vendored baseline" notion at the module grain.

**Faithful (no behavioral discrepancies):** `engine`, `judge`, `scheduler`, `metrics`,
`ledger`.

**Fixes APPLIED to reach fidelity (documented, not hidden):**

- **egress IPv4 `is_private` parity** — added `0.0.0.0/8`, `192.0.0.0/24`,
  `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4`,
  plus IPv4-mapped IPv6 reclassification and `2001:db8::/32` (`connectors/egress.ts`);
- **chiefScribe exec-prompt** built with a **single-pass regex replacer** (was a
  `String.replace` `$`-sequence + sequential-bleed bug);
- **4xx fail-fast** — `HttpError.status`; `agent` + `anthropic` retry only network/timeout
  + 5xx (matches Python `raise_for_status` placement);
- **judge `pyRepr`** renders `True`/`False` + Python-style string quoting;
- **harvester code-point length** uses spread (true code points), not UTF-16 units;
- **chiefScribe participation** falls back to `'n/a'` on an empty JOIN.

**Accepted LOW divergences (parser-driven + safe; documented, not "fixed"):**

- Node WHATWG `URL` normalizes legacy IPv4 literals (decimal/octal/hex) that Python
  `urlparse` leaves raw;
- IPv6 metadata-compression differences;
- report per-point metric-key casing (`sigmaSi` vs Python `sigma_si`) in the serialized
  structured field;
- a null-text JSON decompose value is **dropped** (TS) vs becomes the literal `"None"`
  (Python) — TS is the saner behavior, intentionally not replicated.

A failed fidelity diff on a `faithful` module is treated like a constitutional violation,
not a normal test failure (it means the port drifted from the Unit Cell behavior, T1).

---

## 7. Gate Verification Protocol — Construction-Supervision Handshake

### 7.1 Rationale

Every module in this document must pass a **formal gate** before it can be marked
`✅ GATES_PASSED` / `🏁 COMPLETED` in DASHBOARD.md. The protocol is inherited in structure
from the Unit Cell ENGINEERING doc, but its **mechanism is updated for the TS runtime**:
the gate is no longer `verify_gate.py` writing `.gate_log/*.json` — it is the **strict
TypeScript compiler + the `node:test` runner + the fidelity audit**, whose results are
the evidence. DASHBOARD status is **never updated optimistically** — only after a clean
`tsc` + a green `node:test` run (cited by their console output).

### 7.2 Module State Machine

Each module passes through these states, tracked in DASHBOARD.md:

```
     ⬜ TODO         — Not started; no code exists
       │
       ▼
     🔧 IMPLEMENTING — Code is being written; the module may not compile
       │
       ▼
     🔎 CODE_READY   — All classes/functions exist at the expected signature;
       │                the module is part of a `tsc`-clean project
       ▼
     🔬 IN_VERIFY    — `tsc --noEmit` + `node --test` are running; intermediate state
       │
       ├── [tsc errors OR a test fails] ──► ❌ VERIFY_FAILED (rollback to CODE_READY)
       │
       ▼  [tsc clean AND all tests pass AND fidelity audit OK]
     ✅ GATES_PASSED  — Verification confirmed by `tsc` exit 0 + `node:test` all-pass
       │
       ▼  [DASHBOARD.md updated by the approver, citing the tsc/test result]
     🏁 COMPLETED     — Approved and reflected in the supervision document
```

**State machine rules:**
1. A module advances **one state per transition** (no skipping).
2. `IN_VERIFY` is the only auto-transitioning state.
3. A `VERIFY_FAILED` module rolls back to `CODE_READY`; the implementer fixes the
   compiler error / failing test and re-runs `tsc` + `node:test`.
4. `COMPLETED` is irreversible except via the hotfix protocol (DASHBOARD.md).

### 7.3 Evidence + Lock-Step Rule (no `.gate_log`)

For a module to reach `GATES_PASSED`, the evidence is **the compiler and the test
runner**, not a JSON gate log:

```
┌──────────────────────────────────────────────────────────────────┐
│ npx tsc --noEmit -p ./tsconfig.json                                │
│   1. CHECK_TYPE+LINT  ──► strict compile of the whole project       │
│      exit 0 = no type/lint error anywhere (the type+lint gate)      │
│                                                                    │
│ npm test  (pretest = tsc; then node --test "out/test/**/*.test.js")│
│   2. CHECK_VERIFICATION ──► the module's *.test.ts pass             │
│   3. CHECK_REGRESSION   ──► the FULL suite (181) passes             │
│      summary: `ℹ tests 181 · pass 181 · fail 0`                    │
│                                                                    │
│   4. CHECK_FIDELITY     ──► touched engine module re-diffed (§6.4)  │
│   5. UPDATE_DASHBOARD   ──► set GATES_PASSED, citing the above       │
│                                                                    │
│ Pass criteria: tsc exit 0  AND  node:test fail == 0  AND  audit OK  │
└──────────────────────────────────────────────────────────────────┘
```

The former `.gate_log/{node}_{timestamp}.json` artefact is **eliminated** (§2.6). The
equivalent durable evidence is the CI/console transcript of `tsc` + `npm test` (and, in
CI, the test runner's exit code).

**Lock-step rule (binding, mirrors DASHBOARD.md):** a DASHBOARD module status **must
match** the latest `tsc` + `node:test` result. Marking a module green without a clean
`tsc` and an all-pass `node:test` is a **VIOLATION**, logged in DASHBOARD.md's risk
register, and the module is rolled back to its last verified state.

### 7.4 Enforcement Rules

1. **No optimistic marking** — a module MUST NOT be `✅ GATES_PASSED` / `🏁 COMPLETED`
   unless `tsc --noEmit` returns 0 **and** `node:test` reports `fail 0`.
2. **No manual status override** — DASHBOARD status reflects only a clean compile + a
   green suite (or the approver citing them). Hand-editing a status green without that
   evidence is a violation.
3. **Failure lock** — if `tsc` errors or any test fails, the module stays in
   `CODE_READY` / `VERIFY_FAILED` until the fix passes; dependents cannot start.
4. **3-round fix limit then escalate** — an implementer gets **at most 3 fix rounds** on
   a `VERIFY_FAILED` module. If it still fails after the third round, work **stops** and
   the module is **escalated** to the architect for a design review (the spec, not the
   implementation, may be the defect). This mirrors the Unit Cell 3-round discipline.
5. **Audit trail** — every status transition cites the `tsc` + `node:test` result (and,
   for engine modules, the fidelity-audit note).

---

## 8. The Two-Surface Engine-Change Contract

The ported `src/engine/` engine is **reused with two small additive surfaces** — **not
"untouched," not forked further.** Both are additive, backward-compatible, and **default
to current Unit Cell behavior**. They are the **only** permitted edits to `src/engine/`
behavior (T1).

> **Verified engine API (FROZEN, F3/BLD15).** The real `UnitEngine` signature (verified
> against `src/engine/engine.ts`) is an **options object**, with `config` passed only to
> `run()`:
>
> ```ts
> class UnitEngine {
>   constructor(opts: {
>     agentA?; agentB?; judge?; embeddings?; research?; harvester?;
>     rngSeed?: number;                                            // default 1234
>     onEvent?: (e: AuditEvent | Record<string, unknown>) => void | null;  // additive surface
>   });
>   async run(config: UnitConfig): Promise<UnitResult>;
> }
> ```
>
> Always: `const engine = new UnitEngine({ agentA, agentB, judge, embeddings, research,
> harvester, onEvent: sink }); const result = await engine.run(cfg);`.
> **NEVER** `new UnitEngine(cfg)` and **NEVER** pass `cfg` to the constructor. All
> examples below use this corrected form.

### 8.1 Surface 1 — `onEvent` hook

```ts
// engine/engine.ts — UnitEngine.log() (the single telemetry chokepoint).
private log(st, action, phase, description): void {
  const event = makeAuditEvent({ action, phase, description });
  st.result.auditLog.push(event);                  // UNCHANGED: existing in-mem append
  if (this._onEvent !== null) {                    // ← additive: single chokepoint
    try { this._onEvent(event); }                  //   yields already-emitted events
    catch { /* a faulty sink must NEVER abort a run */ }
  }
}
```

The callback receives the **already-emitted** phase events (`brief_frozen`,
`round0_committed`, `insight_harvested`, `stability_stop`, `keypoint_distilled`, budget
warnings, …). It is the source of **phase-grain** streaming (PREP/OPEN/PROPOSE/CLASH/
RECOMMEND/CLOSE + harvest/verify/stability). It does **not** add per-seat micro-progress
or live-σ_SI (dropped as not deliverable without forking — CONSTITUTION.md §8). When
`onEvent` is null there is **no behavior change**. `groupRunner` binds the sink so each
engine phase event becomes a `group.phase` event.

### 8.2 Surface 2 — `proposeClashSplit` + `objective` presets

```ts
// engine/types.ts / config.ts — UnitConfig (additive fields, both default null)
interface UnitConfig {
  // …
  proposeClashSplit?: [number, number] | null;  // (proposeFrac, clashFrac); default null
  objective?: string | null;                    // debate-mode LABEL; default null
}

// engine/engine.ts — read the override where the propose/clash envelope is computed
const split = cfg.proposeClashSplit ?? defaultSplit(cfg.maxRounds);  // ← unchanged default
```

`proposeClashSplit` lets the debate-mode **presets** (G/C/H/Mixed) tune the propose/clash
ratio over the **existing** knob; `objective` is a **label** the engine does not act on.
**Modes are presets over existing engine knobs — not new mechanisms** (CONSTITUTION.md
§7.6 mode table).

### 8.3 Parity (golden) Test — default behavior reproduces the baseline

The contract is enforced by `src/test/bsN1.test.ts` (the TS port of the Python
`test_bs_n1` two-surface suite). **All examples use the verified F3 call form — clients in
the options object, `cfg` passed only to `run()`:**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('onEvent=null AND no presets reproduce the baseline UnitResult', async () => {
  const cfg = makeUnitConfig({ /* NO proposeClashSplit, NO objective */ });
  const engine = new UnitEngine({ ...fakeClients, onEvent: null });   // null ⇒ no behavior change
  const result = await engine.run(cfg);                                // cfg → run(), NOT ctor
  assert.deepEqual(canonical(result), readBaseline());                 // behavioral parity
});

test('onEvent fires the already-emitted phase events when provided', async () => {
  const events: any[] = [];
  const engine = new UnitEngine({ ...fakeClients, onEvent: e => events.push(e) });
  await engine.run(cfg);
  const types = new Set(events.map(e => e.action ?? e.type));
  assert.ok(['brief_frozen', 'round0_committed', 'stability_stop'].every(t => types.has(t)));
});

test('proposeClashSplit overrides the default envelope', async () => {
  const cfg = makeUnitConfig({ maxRounds: 8, proposeClashSplit: [2, 6] });
  const engine = new UnitEngine({ ...fakeClients });                   // onEvent omitted ⇒ null
  const result = await engine.run(cfg);                                // cfg → run()
  assert.equal(countProposeRounds(result), 2);
  assert.equal(countClashRounds(result), 6);
});
```

- The baseline is captured from the **faithful port with defaults** on a **fixed
  `rngSeed`** (mulberry32, `engine/rng.ts`) so the comparison is deterministic.
- The parity test is part of **every** engine regression and is re-run whenever any agent
  touches `src/engine/` (DoD criterion 5). A diff here is a **constitutional violation**,
  not a normal test failure.

### 8.4 Determinism & the async cascade (porting rules)

The port preserves the engine's behavior while changing its substrate. The binding
porting rules are:

| Python (v0.2)                         | TypeScript (v0.3)                                              | Where |
|---------------------------------------|----------------------------------------------------------------|-------|
| synchronous `requests` call           | `async fetch` through an injectable `FetchLike`                 | `http.ts`, every networked client |
| `requests.get/post` (hard-wired)      | `httpFetch → globalThis.fetch`; tests inject a fake `FetchLike` | `http.ts` |
| `requests` timeout kwarg              | `AbortController` + `setTimeout` (`fetchJson`, default 60 s)    | `http.ts` |
| `raise_for_status()` on non-2xx       | `throw new HttpError(status, …)`; 4xx **fails fast**, only 5xx + network/timeout retried with backoff | `http.ts`, `agent.ts`, `anthropic.ts` |
| `ThreadPoolExecutor` / `as_completed` | **`Promise.all`** within a DAG layer (bounded worker pool); cross-layer sequential | `scheduler.ts` |
| `random.Random(seed)` shuffles        | seeded **mulberry32** `makeRng(seed)` (`next`/`int`/`shuffle`/`pick`) | `rng.ts` |
| Thue-Morse opener by `random`         | Thue-Morse opener **by index** (`popcount(k)` parity)          | `engine.ts` |
| `hashlib.sha256(...).hexdigest()`     | `node:crypto` `createHash('sha256')` (`sha256hex`)             | `util.ts` |
| module-level default-constructor patch (trap) | `globalThis.fetch` trap (the network boundary IS the trap) | `totalEgress.test.ts` |

Because every model/embedding/research call is an `async fetch` through an injectable
`FetchLike`, the **entire 181-test suite runs with a fake fetch / fake clients — zero
network, zero tokens** — and the total-egress property is provable by trapping the one
boundary all default clients share.

---

## 9. Windows / Node-24 Notes

The target machine is **Windows 11 / Node 24** (the bundled VS Code extension-host
runtime). **There is no Python interpreter to discover, no `requirements.txt`, no
`requests`, and no numpy** — the entire v0.2 §9 "Python interpreter discovery /
degradation" section is **eliminated** along with Risk **R-PY** (§2.6).

### 9.1 CLI-subprocess connector notes (the only subprocess)

The **only** subprocess in the system is the optional CLI connector
(`connectors/cli.ts`). It uses `node:child_process` `spawn` with FROZEN controls (R-CLI):

- `spawn(argv[0], argv.slice(1), { shell: false, … })` — an **argv list, no shell
  interpolation** of any model- or user-supplied text;
- **bounded / temporary cwd** (`os.tmpdir()` by default, never the workspace);
- **inherits the user environment** so the `codex`/`claude` CLI finds its **own** stored
  login/OAuth — **no BrainStrom-managed API key is ever placed in argv or env** (keys live
  in SecretStorage);
- **per-call timeout** → `SIGKILL` on expiry; **hard output cap** truncates runaway
  output; `ENOENT` → a clear "CLI not found" message;
- single-shot "print" invocation only (`allowFileTools` defaults to `false`; the temp cwd
  bounds any stray writes).

Output is `redact()`-ed (O8) before it enters logs, events, reports, or persisted state.
The CLI reports no token usage, so the engine's `estimateTokens` handles its budget. These
controls are the equivalent total boundary for the one egress family that does not transit
the HTTP guard (ARCHITECTURE.md §1 invariant note). Verified by `cli.test.ts`.

### 9.2 Async / I/O & the egress guard on Node 24

- Every model/embedding/research call is an `async fetch` through an injectable
  `FetchLike`; the default `httpFetch` delegates to Node 24's global `fetch`. Timeouts use
  `AbortController` (`fetchJson`, default 60 s).
- **The egress guard is total:** every client is built through the connector layer, which
  runs `validateEgress` at construction **and on each build**, and `makeGuardedFetch`
  wraps any `FetchLike` so every request URL is checked before the network. Loopback /
  private allowed; remote requires `allowRemote` + allowlist + https; cloud-metadata
  always blocked. Proven by `totalEgress.test.ts` (§6.2).
- **Known limitation (OPEN P1):** hostname classification without DNS resolution
  (DNS-rebinding is out of scope; a resolve-and-recheck pass is the single open hardening
  item, documented in `egress.ts`).

### 9.3 TS build + packaging set

- **Compiler.** `tsconfig.json`: `strict`, `module commonjs`, `target`/`lib` `ES2022`,
  `esModuleInterop`, `resolveJsonModule`, `outDir "out"`, `rootDir "src"`, `sourceMap
  true`. `npm run compile` = `tsc -p ./tsconfig.json`.
- **Manifest.** `package.json`: name `modellane-brainstrom-ts`, displayName
  "ModelLane-BrainStrom (TS)", version `0.3.0`, publisher `modellane`, `engines.vscode
  ^1.104.0`, `main ./out/extension.js`, `languageModelChatProviders` vendor
  `modellane-brainstrom`. Settings: `brainstrom.allowRemote`, `brainstrom.autoConfirmPlan`
  (**no `brainstrom.pythonPath`**).
- **Test.** `npm test` = `pretest` (`tsc`) then `node --test "out/test/**/*.test.js"`.
  **Node 24 needs the glob string, not a bare directory** — a bare `node --test out/test`
  will not discover the compiled `.test.js` files. Tests inject a fake `fetch`/clients —
  zero network, zero tokens. **Result: `tsc` strict CLEAN (0 errors); 181 / 181
  `node:test` pass.**
- **`.vscodeignore`** **ships** `out/**/*.js` + `media/**` + the manifest; **excludes**
  `src/**`, `**/*.ts`, `**/*.map`, `out/test/**`, `docs/**`, `handover/**`, `data/**`,
  `node_modules/**`, `tsconfig.json`.
- **Package.** `npx @vscode/vsce package --no-dependencies` ⇒
  `modellane-brainstrom-ts-0.3.0.vsix` (51 files, ~142 KB).
- `deactivate()` (X1) reaps **no child** — the engine is in-process; a mid-call CLI
  subprocess is bounded by its own per-call timeout, independent of deactivate.

---

## Cross-document lineage

| Direction | Document | Relationship |
|-----------|----------|--------------|
| ▲ upstream (external) | Unit Cell **THEORY.md / CONSTITUTION.md** | source of inherited principles **P1, P2, P5, P8, P9, P10, P11, P16, P17** and **LD1, LD4, LD7, LD8** (cited by ID + gloss; full text in the external Unit Cell docs) |
| ▲ upstream | **CONSTITUTION.md** | mission, scope (port with two additive surfaces; CLI connector + >2-debater panel now BUILT; deferred: DNS-rebinding hardening), tenets **T1–T6**, requirement tiers P0/P1/P2 ↔ S1–S16, honesty policy §8, **CANONICAL MODE PRESET TABLE in §7.6** |
| ▲ upstream | **ARCHITECTURE.md** | TS module table (§2: R1–R8 / X1–X2 / B1–B6 / O1–O9g / E1–E11 / H1–H3) + DAG (§2.6), in-process engine lifecycle (§3), the in-process `EngineService` API + `EngineEvent` stream (§4), connector abstraction (§5), key algorithms (§8), port-fidelity (§12) — this doc builds what ARCHITECTURE.md §2–§8 specify |
| ▼ downstream | **DASHBOARD.md** | consumes the module state machine (§7.2), the `tsc`+`node:test` evidence rule (§7.3), milestone gates M1–M4 (§4.2), the port waves W0–W8 (§3.2), and the risk register **R1–R8 / R-STREAM + R-CLI / R-EGRESS-BYPASS / R-COST / R-INTAKE / R-DECOMP** (R-PY **retired**) |

**Inherited Unit Cell principles applied inside each group** (cited by ID; see the
external Unit Cell THEORY.md / CONSTITUTION.md for full text): **P1** deliberation +
inquiry (not persuasion) · **P2** simultaneous round-0 drafting · **P5** judge
generative/evaluative separation · **P8** MMR redundancy control · **P9** scores withheld
from agents in PROPOSE · **P10** asymmetric knowledge injection · **P11** stability-based
stopping · **P16** first-principles verification · **P17** reliable innovation capture +
verify · **LD1** cardinal anchored rubric · **LD4** idea ledger + entropy (σ_SI) · **LD7**
never silently drop a breakthrough · **LD8** verifier family ≠ author family. The engine,
judge, scheduler, metrics, and ledger modules passed the 10-module fidelity audit as
**faithful** (§6.4), so these principles are preserved by construction.

**Risks tracked in v0.3** (full register in DASHBOARD.md): **R-CLI** (CLI subprocess
execution surface → `connectors/cli.ts` sandbox controls, §9.1) · **R-EGRESS-BYPASS** (a
missed injected slot reaches the network → the `totalEgress.test.ts` trap, §6.2) ·
**R-COST** (coarse cancel / already-started remote spend → absolute `BudgetGovernor` +
per-call `AbortController` timeouts) · **R-INTAKE** (multi-turn session state lost →
controller plan map keyed on the first user message, `sessionState.ts`) · **R-DECOMP**
(bad decomposition gates the whole run → `KnowledgePointSet.validate()` + the CONFIRM_PLAN
gate). These sit alongside **R1–R8, R-STREAM**. **R-PY** (Windows Python bootstrap) is
**retired** — there is no Python to bootstrap.

---

## Revision History

| Version | Date | Author | Description |
|---------|------|--------|-------------|
| v0.1 | 2026-06-14 | architect + scientific-advisor | Initial draft from approved plan |
| v0.2 | 2026-06-14 | architect + scientific-advisor | Incorporate ARCHITECTURE_AUDIT_REPORT findings F1–F16 + workflow-logic flaws 1–6; hybrid connector policy; node convention N0–N25. |
| v0.3 | 2026-06-15 | architect + scientific-advisor | pure-TypeScript in-process port: engine + orchestration ported to src/engine + src/orchestrator; Python sidecar/JSON-RPC removed; EngineService in-process facade; tsc strict CLEAN; 181/181 node:test; packaged modellane-brainstrom-ts-0.3.0.vsix. |
