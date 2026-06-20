# ModelLane-BrainStrom (TS) — Project Dashboard (Supervision Document)

**Version: v0.5 · Date: 2026-06-20 · Status: DELIVERED + AUDIT-HARDENED (pure-TypeScript in-process port; in-editor runtime acceptance pending)**

> **v0.5 — audit remediation (2026-06-20).** A 3rd-party architecture/security audit raised 11
> findings; all are addressed. **P0/P1:** F1 research now routes through a guarded fetch restricted
> to a research-host allowlist (was raw `httpFetch`); F2 the CLI runs each call in a throwaway,
> auto-deleted temp cwd when `allowFileTools` is off; F3 the embeddings cache defaults to in-memory
> and threads an absolute `globalStorageUri/embeddings` path (never a relative `./data`); F4 a
> `package-lock.json` is committed (`npm audit` clean); F5 adds a manual `docs/ACCEPTANCE.md`
> checklist + an automated `acceptance.test.ts`. **P2/P3:** F6 secrets snapshot cleared in a
> `finally`; F7 the live board is now structured (plan → group cards → status); F8 admin config is
> schema-validated before persist; F9 the egress guard adds a DNS resolve-and-recheck
> (DNS-rebinding); F10 package metadata points to the correct repo; F11 adds `handover/DESIGN.md`.
> The suite is now **198 / 198** `node:test` passing (the **181** figures elsewhere in this document
> are the v0.3 baseline). Regression coverage: `src/test/auditHardening.test.ts` + `acceptance.test.ts`.

> This is the **live supervision document** for ModelLane-BrainStrom. It is the
> lock-step mirror of build reality. As of the **v0.3 pure-TypeScript port**, the
> Unit Cell engine and the entire BrainStrom orchestration layer have been **ported
> to TypeScript and run in-process inside the VS Code extension host** — there is
> **no Python, no sidecar subprocess, no JSON-RPC, and no Content-Length stdio
> framing** anywhere in the system. The former Python sidecar (`rpc_server.py`) is
> replaced by an in-process typed façade, `class EngineService`
> (`src/brainstorm/engineService.ts`), whose async methods the controller calls with
> plain `await`. The **only** subprocess in the whole system is the optional,
> sandboxed **CLI connector** (`src/orchestrator/connectors/cli.ts`), spawned via
> `node:child_process` to drive the `codex`/`claude` CLIs.
>
> **Evidence basis (replaces the v0.2 gate harness).** The Python gate harness
> (`verify_gate.py`, `.gate_log/*.json`, ruff/pytest/mypy) is **gone**. Build truth
> is now three artifacts, each verified live for this revision: **(1)** `tsc --noEmit`
> (strict) → **0 errors**; **(2)** the `node:test` suite → **181 / 181 pass, 0 fail,
> zero network, zero tokens**; **(3)** the **10-module adversarial fidelity audit**
> against the Python source. The project is **packaged**
> (`modellane-brainstrom-ts-0.3.0.vsix`, 51 files, ~142 KB). The **single remaining
> open item** is the in-VS-Code live acceptance run (pick the model → approve the
> plan → produce a report against real models), which cannot be automated headlessly
> and is the human sign-off (§2, §10).
>
> **Module-inventory convention (replaces the former N0–N25 sidecar node map, F12 /
> BLD12).** The runtime is no longer a Python sidecar with a `python/unit/` +
> `python/brainstrom/` split. The **binding inventory is the TypeScript module map**:
> the ported engine under `src/engine/`, the ported orchestration under
> `src/orchestrator/` (+ `connectors/`), and the extension glue under
> `src/brainstorm/` plus the shell (`src/extension.ts`, `src/modelLaneProvider.ts`).
> An N-style id scheme is retained where it aids the DAG and tables, but **every id
> now names a TypeScript module**, and the eliminated sidecar nodes are listed
> explicitly (§4.4, §6). Progress is measured by `tsc` strict + the **181** tests +
> the fidelity audit — **not** by a sidecar node count (no "X of 25").
>
> **Lineage.** THEORY (Unit Cell, external) → CONSTITUTION.md → ARCHITECTURE.md →
> ENGINEERING.md → **DASHBOARD.md** (this file). Inherited Unit Cell principles
> (P1, P2, P5, P8, P9, P10, P11, P16, P17; LD1, LD4, LD7, LD8) are applied **inside
> each debate group** and are cited from CONSTITUTION.md §5; their source text lives
> in the external Unit Cell THEORY.md / CONSTITUTION.md and is not reproduced here.

---

## 1. Overall Status

| Item | Status |
|------|--------|
| Overall Progress | ██████████ 100% headless (all ported modules compile, test, and pass the fidelity audit) — evidence in §5; the **in-VS-Code live acceptance** is the one remaining human step (§10) |
| Current Phase | **Pure-TypeScript port DELIVERED (headless)** — engine + orchestration + connectors + extension glue ported and in-process; live in-editor acceptance pending |
| Runtime | ✅ **In-process TypeScript** — one extension-host process; the engine is a plain object constructed in `extension.ts`. **No Python, no sidecar, no JSON-RPC, no stdio framing.** |
| Build | ✅ `tsc -p tsconfig.json` strict → **0 errors** (verified 2026-06-15) |
| Tests | ✅ `node --test "out/test/**/*.test.js"` → **181 / 181 pass, 0 fail** (full former pytest suite ported to `src/test/*.test.ts`; fake fetch/clients; zero network, zero tokens) |
| Fidelity audit | ✅ 10-module adversarial audit vs the Python source: **engine, judge, scheduler, metrics, ledger = FAITHFUL** (no behavioral discrepancies); 6 fidelity fixes applied; 4 LOW divergences accepted + documented (§5.3) |
| Package | ✅ `modellane-brainstrom-ts-0.3.0.vsix` (51 files, ~142 KB) — ships `out/**/*.js` + media + manifest; excludes `src/`, `**/*.ts`, `**/*.map`, `out/test/` |
| Theory (Unit Cell, external) | ✅ Inherited — referenced, not re-derived (CONSTITUTION.md §5); preserved faithfully by the port |
| Constitution | ✅ Rewritten (CONSTITUTION.md v0.3, BUILT) |
| Architecture Blueprint | ✅ Rewritten (ARCHITECTURE.md v0.3, DELIVERED) |
| Engineering Plan | ✅ Rewritten (ENGINEERING.md v0.3) |
| Dashboard | ✅ Rewritten (this file, v0.3) |
| Engine reuse stance | ♻️ Engine **ported with two small additive surfaces** (`onEvent`; `proposeClashSplit` + `objective`) — **ported, not forked**, and **not** "untouched" |
| Streaming stance | 📡 GROUP-grain (native) + PHASE-grain (via `onEvent`, forwarded as `EngineEvent` through `EngineService.emit`) — **not** per-seat / not live σ_SI |
| σ_SI stance | 📈 Reported as a **diversity** signal at CLOSE, not a quality score |
| Cost numbers | 💲 All cost/USD/token figures are **ESTIMATES** (often zero for non-conformant endpoints) |
| Connector policy | 🔌 **HYBRID** (BLD9 / F1): DEFAULT debate seats are OpenAI (Codex-style persona) + Anthropic (Claude-Code-style persona) **API** models; **PLUS** a sandboxed CLI-subprocess connector (`connectors/cli.ts`) as a **built, first-class connector kind** |
| Former headline deferrals | ✅ **BUILT** — the **CLI connector** (`connectors/cli.ts`) and the **>2-debater panel** (`multiDebate.ts`) are both implemented (no longer deferred) |
| Total-egress containment | 🔒 **PROVEN** by the trap-client test (`src/test/totalEgress.test.ts`): all engine slots injected; the engine raises if it ever reaches a default constructor (Finding F4) |
| Eliminated vs v0.2 | 🗑️ `sidecarManager.ts`; `rpc_server.py`; JSON-RPC + Content-Length framing; `session.provisionSecrets` handshake; Python bootstrap; `requirements.txt`; `requests`; numpy concern; `brainstrom.pythonPath`; **Risk R-PY** — all removed |
| Last Updated | 2026-06-15 |

---

## 2. Milestones

Milestone definitions are owned by ENGINEERING.md §4.2 (Milestone Gates). M0 is the
governance-docs milestone met by this set; M1–M3 are **MET headlessly** by the port
(the engine, orchestration, synthesis, and seam are all built in-process and proven by
`tsc` + the 181 tests + the trap-client test). **M4 (in-VS-Code UX acceptance) is the
single remaining human step.**

| Milestone | Target | Deps | Status |
|-----------|--------|------|--------|
| **M0: Governance docs rewritten** | 2026-06-15 | the 4 docs | ✅ Done — CONSTITUTION / ARCHITECTURE / ENGINEERING / DASHBOARD rewritten at v0.3 for the in-process TS runtime |
| **M1: Walking skeleton** | 2026-06-15 | engine/* + connectors/{base,egress,openaiCompatible} + groupRunner + modelLaneProvider branch | ✅ **MET headlessly** — the **in-process** engine runs `UnitEngine.run()` on a point through the egress guard; the synthetic `{kind:"brainstrom"}` entry is injected after the sort and handled in **both** `provideLanguageModelChatResponse` **and** `provideTokenCount` before any delegate access (F2); the **trap-client egress test passes** — all engine slots injected, `NoopKnowledgeEngine` when research off, default constructors raise if ever reached (F4). The v0.2 top risk **R-PY no longer exists** (no interpreter to discover). |
| **M2: Orchestration (headless)** | 2026-06-15 | M1 + decompose + scheduler + security + sessionState | ✅ **MET headlessly** — domain → N points (atomic + lenses) → parallel (`Promise.all` per DAG layer) + sequential DAG executes headless; absolute budget honored (`BudgetGovernor`, F10); injected artifacts disqualified; the bespoke `decompose` (NOT a `UnitEngine.run()`, F6) emits points **and** cross-cutting lenses with `KnowledgePointSet.validate()` before CONFIRM_PLAN |
| **M3: Synthesis + in-process façade** | 2026-06-15 | M2 + chiefScribe + engineService | ✅ **MET headlessly** — full pipeline through the in-process `EngineService` (`runGroup`/`runSession`/`decompose`/`executePlan`); `EngineEvent` streaming + cooperative cancel; the former TS↔Py stdio seam is **gone** (collapsed into a direct async call edge) |
| **M4: UX ship-ready (in-VS-Code)** | TBD (human) | M3 + live board + admin console + the user's models | ⬜ **PENDING — the ONLY open milestone.** Model selectable → intake → CONFIRM_PLAN → live board → saved report, end-to-end **in VS Code on the user's machine** (LM Studio local + one remote connector). This requires a human running a real session against real models and **cannot be automated headlessly** here. `handover/DESIGN.md` is the prerequisite for the UX surfaces (BLD17 / F16). |

> **What "DELIVERED" means and does not mean.** The v0.3 port is **delivered and
> proven headlessly**: it compiles strict-clean, the full former test suite passes
> with zero network, and the fidelity audit confirms behavioral parity on the five
> core engine modules. It is **not yet runtime-accepted in the editor** against live
> models — that is M4, the deliberate human gate. No wall-time estimate is anchored to
> M4; it is gated on a user session, not on further code.

---

## 3. Module State Machine

Every module follows this state progression. DASHBOARD.md status is lock-step with the
three evidence artifacts (§5): `tsc --noEmit` strict, the `node:test` suite, and the
fidelity audit. There is no longer a per-node `.gate_log/*.json` — the gate harness was
eliminated with the sidecar.

```
     ⬜ TODO          — Not started. No code exists.   ← (empty — all ported modules built)
       │
       ▼
     🔧 IMPLEMENTING  — Code being written (only during an active build session).
       │
       ▼
     🔎 CODE_READY    — All classes/functions exist at expected signatures; the
       │                 module compiles under `tsc` strict.
       ▼
     🔬 IN_VERIFY     — `tsc --noEmit` + `node:test` running; fidelity audit applied.
       │
       ├── ❌ VERIFY_FAILED  ← tsc error OR a test fails → rollback to 🔎 CODE_READY
       │
       ▼
     ✅ VERIFIED      — `tsc` strict clean AND all 181 tests pass AND (for the 5 core
       │                 engine modules) the fidelity audit reports FAITHFUL.
       ▼
     🏁 DELIVERED     — Ported, compiled, tested, packaged into the .vsix.
                          (M4 in-editor acceptance is a separate, human gate.)
```

**Transition rules:**
- A module reaches ✅ VERIFIED only when the **whole** strict compile is clean **and**
  the **whole** 181-test suite passes (the suite is the regression gate; there are no
  per-module gate logs to forge).
- 🏁 DELIVERED → 🔧 HOTFIX if a post-delivery change is required; any failing test or
  `tsc` error during HOTFIX rolls back to CODE_READY.
- **At the v0.3 port, every ported module (§4) is 🏁 DELIVERED** (headless evidence in
  §5). The in-editor runtime acceptance (M4) is tracked separately in §2 and §10.
- The **inherited ModelLane shell** (R1–R8, §4.1) is **reused as-is, not re-gated** —
  it shows ♻️ REUSE.

**Section reference:** ENGINEERING.md §7 (verification protocol: `tsc --noEmit` strict +
`node:test` + fidelity audit).

---

## 4. Work Module Board

**Status legend:** State machine (§3). Tags: **[R]** reuse (inherited shell) ·
**[E]** extend (additive, backward-compatible) · **[N]** new/ported. The module
inventory is owned by ARCHITECTURE.md §2 (module table) and the critical path by
ARCHITECTURE.md §2.6 / ENGINEERING.md. **The inherited shell (R1–R8) is reused, not
re-gated; all `src/engine`, `src/orchestrator`, and `src/brainstorm` modules are ported
and DELIVERED.**

### 4.1 Inherited shell (ModelLane, reused as-is)

```
┌──────────────────────────────────────────┬──────────┬─────────────────────┬──────────┐
│ Module (src/…)                             │ Status   │ Evidence            │ Risk     │
├──────────────────────────────────────────┼──────────┼─────────────────────┼──────────┤
│ R1  lmStudioApi.ts                  [R]    │ ♻️ REUSE │ inherited (not gated)│ 🟢 Low   │
│ R2  chatPanel.ts                    [R]    │ ♻️ REUSE │ inherited            │ 🟢 Low   │
│ R3  agentRunner.ts                  [R]    │ ♻️ REUSE │ inherited            │ 🟢 Low   │
│ R4  codeActions.ts                  [R]    │ ♻️ REUSE │ inherited            │ 🟢 Low   │
│ R5  inlineCompletion.ts             [R]    │ ♻️ REUSE │ inherited            │ 🟢 Low   │
│ R6  languageModelProvider.ts        [R]    │ ♻️ REUSE │ inherited            │ 🟢 Low   │
│ R7  localModelProvider.ts           [R]    │ ♻️ REUSE │ inherited            │ 🟢 Low   │
│ R8  statusBar.ts                    [R]    │ ♻️ REUSE │ inherited            │ 🟢 Low   │
└──────────────────────────────────────────┴──────────┴─────────────────────┴──────────┘
```

### 4.2 Extension glue (BrainStrom shell)

```
┌──────────────────────────────────────────┬──────────────┬────────────────────────┬──────────┐
│ Module (src/…)                             │ Status       │ Evidence               │ Risk     │
├──────────────────────────────────────────┼──────────────┼────────────────────────┼──────────┤
│ X1  extension.ts                    [E]    │ 🏁 DELIVERED │ tsc✓ · constructs       │ 🟢 Low   │
│     (activation; in-process EngineService) │              │ EngineService (no spawn)│          │
│ X2  modelLaneProvider.ts            [E]    │ 🏁 DELIVERED │ tsc✓ · branch tests pass│ 🟡 Med   │
│     (synthetic model; F2 dual-branch)      │              │ (both response+token)   │          │
│ B1  brainstorm/controller.ts        [N]    │ 🏁 DELIVERED │ tsc✓ · CONFIRM_PLAN gate│ 🟡 Med   │
│ B2  brainstorm/engineService.ts     [N]    │ 🏁 DELIVERED │ tsc✓ · async-method     │ 🟡 Med   │
│     (IN-PROCESS façade; was rpc_server.py) │              │ tests (injected execs)  │          │
│ B3  brainstorm/brainstormViewProvider.ts[N]│ 🏁 DELIVERED │ tsc✓ · CSP/textContent  │ 🔴 High  │
│     (live board)                           │              │ (+DESIGN.md for M4)     │          │
│ B4  brainstorm/adminConsolePanel.ts [N]    │ 🏁 DELIVERED │ tsc✓ · no-secret panel  │ 🟡 Med   │
│ B5  brainstorm/connectorRegistry.ts [N]    │ 🏁 DELIVERED │ tsc✓ · param builders   │ 🟢 Low   │
│ B6  brainstorm/secrets.ts           [N]    │ 🏁 DELIVERED │ tsc✓ · SecretStorage    │ 🔴 High  │
└──────────────────────────────────────────┴──────────────┴────────────────────────┴──────────┘
```

### 4.3 Orchestration + connectors (was `python/brainstrom/` → `src/orchestrator/`)

```
┌──────────────────────────────────────────┬──────────────┬────────────────────────┬──────────┐
│ Module (src/orchestrator/…)                │ Status       │ Evidence               │ Risk     │
├──────────────────────────────────────────┼──────────────┼────────────────────────┼──────────┤
│ O1  decompose.ts (BESPOKE, NOT run())[N]   │ 🏁 DELIVERED │ tsc✓ · decompose tests  │ 🔴 High  │
│ O2  scheduler.ts + BudgetGovernor    [N]   │ 🏁 DELIVERED │ tsc✓ · FAITHFUL (audit) │ 🔴 High  │
│ O3  groupRunner.ts (7-slot inject)   [N]   │ 🏁 DELIVERED │ tsc✓ · trap-client test │ 🟡 Med   │
│ O4  multiDebate.ts (>2 panel)        [N]   │ 🏁 DELIVERED │ tsc✓ · panel tests      │ 🟡 Med   │
│ O5  chiefScribe.ts                   [N]   │ 🏁 DELIVERED │ tsc✓ · scribe tests     │ 🟡 Med   │
│ O6  sessionState.ts                  [N]   │ 🏁 DELIVERED │ tsc✓ · redaction tests  │ 🟡 Med   │
│ O7  types.ts (topo/validate/predecs) [N]   │ 🏁 DELIVERED │ tsc✓ · validate tests   │ 🟢 Low   │
│ O8  security.ts (wrap/detect/redact) [N]   │ 🏁 DELIVERED │ tsc✓ · injection tests  │ 🔴 High  │
│ O9a connectors/base.ts               [N]   │ 🏁 DELIVERED │ tsc✓ · connector tests  │ 🟢 Low   │
│ O9b connectors/egress.ts (TOTAL guard)[N]  │ 🏁 DELIVERED │ tsc✓ · egress tests     │ 🔴 High  │
│ O9c connectors/openai.ts             [N]   │ 🏁 DELIVERED │ tsc✓                    │ 🟡 Med   │
│ O9d connectors/anthropic.ts          [N]   │ 🏁 DELIVERED │ tsc✓ · _chat override   │ 🟡 Med   │
│ O9e connectors/openaiCompatible.ts   [N]   │ 🏁 DELIVERED │ tsc✓                    │ 🟢 Low   │
│ O9f connectors/cli.ts (SANDBOX)      [N]   │ 🏁 DELIVERED │ tsc✓ · cli sandbox test │ 🔴 High  │
│ O9g connectors/factory.ts            [N]   │ 🏁 DELIVERED │ tsc✓                    │ 🟢 Low   │
└──────────────────────────────────────────┴──────────────┴────────────────────────┴──────────┘
```

### 4.4 Ported Unit-Cell engine (was `python/unit/` → `src/engine/`)

```
┌──────────────────────────────────────────┬──────────────┬────────────────────────┬──────────┐
│ Module (src/engine/…)                      │ Status       │ Evidence               │ Risk     │
├──────────────────────────────────────────┼──────────────┼────────────────────────┼──────────┤
│ E1  engine.ts (UnitEngine + 2 surfaces)[E] │ 🏁 DELIVERED │ tsc✓ · FAITHFUL (audit) │ 🟡 Med   │
│ E2  types.ts                         [N]   │ 🏁 DELIVERED │ tsc✓                    │ 🟢 Low   │
│ E3  config.ts (+proposeClashSplit/obj)[E]  │ 🏁 DELIVERED │ tsc✓ · validateConfig   │ 🟢 Low   │
│ E4  agent.ts (4xx fail-fast)         [N]   │ 🏁 DELIVERED │ tsc✓ · retry tests      │ 🟡 Med   │
│ E5  judge.ts                         [N]   │ 🏁 DELIVERED │ tsc✓ · FAITHFUL (audit) │ 🟡 Med   │
│ E6  harvester.ts (code-point length) [N]   │ 🏁 DELIVERED │ tsc✓ · fidelity fix     │ 🟡 Med   │
│ E7  ledger.ts (dedup/MMR/novelty)    [N]   │ 🏁 DELIVERED │ tsc✓ · FAITHFUL (audit) │ 🟢 Low   │
│ E8  metrics.ts (σ_SI diversity)      [N]   │ 🏁 DELIVERED │ tsc✓ · FAITHFUL (audit) │ 🟢 Low   │
│ E9  research.ts (OFF by default)     [N]   │ 🏁 DELIVERED │ tsc✓ · Noop test        │ 🟡 Med   │
│ E10 budget.ts (BudgetTracker)        [N]   │ 🏁 DELIVERED │ tsc✓                    │ 🟢 Low   │
│ E11 embeddings.ts (cosine/jaccard)   [N]   │ 🏁 DELIVERED │ tsc✓                    │ 🟢 Low   │
│ H1  http.ts (FetchLike/HttpError)  [N·new] │ 🏁 DELIVERED │ tsc✓ · timeout/4xx test │ 🟡 Med   │
│ H2  rng.ts (mulberry32 makeRng)    [N·new] │ 🏁 DELIVERED │ tsc✓ · determinism test │ 🟢 Low   │
│ H3  util.ts (sha256hex/tokens/clamp)[N·new]│ 🏁 DELIVERED │ tsc✓                    │ 🟢 Low   │
└──────────────────────────────────────────┴──────────────┴────────────────────────┴──────────┘
```

### 4.5 ELIMINATED modules (present in the v0.2 sidecar design, removed in v0.3)

```
┌──────────────────────────────────────────┬─────────────────────────────────────────────────┐
│ Removed (was)                              │ Why it is gone                                    │
├──────────────────────────────────────────┼─────────────────────────────────────────────────┤
│ sidecarManager.ts (was N15)                │ no subprocess to spawn/health/cancel/restart/kill │
│ rpc_server.py (was N12)                    │ replaced by in-process EngineService façade (B2)  │
│ JSON-RPC 2.0 + Content-Length framing      │ no wire protocol — direct async calls; emit()     │
│ session.provisionSecrets stdio handshake   │ replaced by in-memory secretsAccessor (B6→B1→B2)  │
│ Python runtime bootstrap (was N21)         │ no interpreter; no requirements.txt; no requests  │
│ numpy concern (was in N21)                 │ moot — engine uses node:crypto + mulberry32 + fetch│
│ brainstrom.pythonPath setting              │ removed from package.json configuration           │
│ verify_gate.py / .gate_log/*.json (was N24)│ replaced by tsc strict + node:test + fidelity audit│
│ Risk R-PY (Windows Python bootstrap)       │ retired — there is no Python to bootstrap         │
└──────────────────────────────────────────┴─────────────────────────────────────────────────┘
```

> **N0 has no successor.** The v0.2 board carried `N0 = vendored engine (♻️ REUSE,
> not gated)`. In v0.3 the engine is **ported into the tree** (`src/engine/`, modules
> E1–E11 + H1–H3) and is gated like any other TS module by `tsc` + the test suite +
> the fidelity audit. There is no longer a "vendored-but-not-gated" exception row.

---

## 5. Evidence Table (replaces the Gate Verification Log)

The v0.2 `.gate_log/{node}_latest.json` per-node logs are **gone**. Build truth is the
three artifacts below, each re-verified live for this revision (2026-06-15). They are a
single source of truth in three views; any divergence between this table and the
artifacts is a tracked violation (§8.1) and blocks M4 sign-off.

### 5.1 Compile + test + package

<!-- EVIDENCE_TABLE_START -->
| Evidence | Command | Result | Verified At |
|----------|---------|--------|-------------|
| **Strict compile** | `tsc --noEmit -p tsconfig.json` | ✅ **0 errors** (strict; ES2022; commonjs; `esModuleInterop`; `resolveJsonModule`) | 2026-06-15 |
| **Test suite** | `npm test` = `node --test "out/test/**/*.test.js"` | ✅ **tests 181 · pass 181 · fail 0** (27 `*.test.ts` files; fake fetch/clients; zero network, zero tokens) | 2026-06-15 |
| **Package** | `npx @vscode/vsce package --no-dependencies` | ✅ `modellane-brainstrom-ts-0.3.0.vsix` (**51 files, ~142 KB**); ships `out/**/*.js` + media + manifest; excludes `src/`, `**/*.ts`, `**/*.map`, `out/test/` | 2026-06-15 |
<!-- EVIDENCE_TABLE_END -->

> **Test denominator.** The "181 / 181" figure is the **full former pytest suite**
> ported to `src/test/*.test.ts`. It is the regression gate that replaces the v0.2
> "25 gated nodes" denominator: there is no per-node pass/total anymore — a node either
> compiles and its behaviors pass within the single 181-test run, or the whole gate is
> red.

### 5.2 Per-module fidelity-audit verdict (10-module adversarial audit vs the Python source)

| Module | Verdict | Note |
|--------|---------|------|
| `engine` (E1) | ✅ **FAITHFUL** | phase machine PREP→OPEN→PROPOSE→CLASH→RECOMMEND→CLOSE; no behavioral discrepancy; 2 additive surfaces default to current behavior |
| `judge` (E5) | ✅ **FAITHFUL** | generative/evaluative split + attack-graph/grounded extension preserved; verifier family ≠ author enforced |
| `scheduler` (O2) | ✅ **FAITHFUL** | topo waves + `Promise.all`-per-layer + isolated per-group failure mirror the Python thread-pool `as_completed` semantics |
| `metrics` (E8) | ✅ **FAITHFUL** | σ_SI / entropy / coverage / fixation parity; σ_SI is a diversity metric, not quality |
| `ledger` (E7) | ✅ **FAITHFUL** | dedup / MMR / novelty parity; embeddings injected, never engine-constructed |
| `agent` (E4) | ✅ verified + **fixed** | 4xx fail-fast (`HttpError.status`; retries only network/timeout + 5xx) — see §5.3 |
| `harvester` (E6) | ✅ verified + **fixed** | code-point length via spread (not UTF-16 units) — see §5.3 |
| `chiefScribe` (O5) | ✅ verified + **fixed** | single-pass regex exec-prompt replacer; `'n/a'` participation fallback — see §5.3 |
| `egress` (O9b) | ✅ verified + **fixed** | IPv4 `is_private` parity additions + IPv4-mapped IPv6 reclassification — see §5.3; 1 accepted LOW divergence (§5.4) |
| `decompose` (O1) | ✅ verified + **1 accepted LOW divergence** | null-text JSON value drops the item (TS) — saner; intentionally not replicated (§5.4) |

### 5.3 Fidelity fixes APPLIED (to reach parity)

| # | Module | Fix |
|---|--------|-----|
| 1 | `egress` (O9b) | IPv4 `is_private` parity: added `0.0.0.0/8`, `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4` + IPv4-mapped IPv6 reclassification + `2001:db8::/32` |
| 2 | `chiefScribe` (O5) | exec-prompt built with a **single-pass regex replacer** (was a `String.replace` `$`-sequence + sequential-bleed bug) |
| 3 | `agent` (E4) / `anthropic` (O9d) | **4xx fail-fast** (`HttpError.status`; both retry only network/timeout + 5xx) — matches Python `raise_for_status` placement |
| 4 | `judge` (E5) | `pyRepr` renders `True`/`False` + Python-style string quoting |
| 5 | `harvester` (E6) | code-point length uses a **spread** (true code points), not UTF-16 units |
| 6 | `chiefScribe` (O5) | participation falls back to `'n/a'` on an empty JOIN |

### 5.4 Accepted LOW divergences (parser-driven + safe; documented, NOT "fixed")

| # | Where | Divergence (why accepted) |
|---|-------|---------------------------|
| 1 | `egress` (O9b) | Node WHATWG `URL` normalizes legacy IPv4 literals (decimal/octal/hex) that Python `urlparse` leaves raw — parser difference, not a guard weakness |
| 2 | `egress` (O9b) | IPv6 metadata compression differences (same hosts blocked, different canonical form) |
| 3 | report serializer | per-point metric-key casing (`sigmaSi` vs Python `sigma_si`) in the serialized structured field |
| 4 | `decompose` (O1) | a null-text JSON point is **DROPPED** (TS) vs becomes the literal `"None"` item (Python) — TS is the saner behavior, intentionally not replicated |

---

## 6. Dependency Graph (Critical Path)

ASCII DAG over the **TS module inventory** (§4). Edges follow ARCHITECTURE.md §2.6. The
graph is a strict acyclic DAG; the ported engine (`engine/*`) is the leaf, the connector
layer (all gated by `connectors/egress`) feeds the group runner, the orchestration
converges on the **in-process** `EngineService` façade, and the controller +
`extension.ts` drive it directly. **There is no stdio seam** — the former Python/TS
boundary collapses into a single in-process call edge.

```
                ┌──────────────── ONE TypeScript process (no sidecar lane) ────────────────┐
 engine/types ─┬┼─► engine/{config,agent,judge,harvester,ledger,metrics,research,           │
               ││      budget,embeddings} ─► engine/engine (UnitEngine.run)                  │
   http ═══════╪┼──►       ▲ (E* clients injected by O3 groupRunner, never default-built)    │
   rng ────────┤│          │                                                                 │
   util ───────┘│  connectors/egress ═╗  (TOTAL guard: validateEgress + makeGuardedFetch)    │
                │  connectors/base ════╬═► {openai, anthropic, openaiCompatible} ─┐           │
                │  connectors/cli ─────╝   node:child_process spawn(shell:false)  │           │
                │           │                                                     ▼           │
                │  O1 decompose ─┐ (BESPOKE — NOT a UnitEngine.run())   O3 groupRunner        │
                │  O8 security ──┤                                          │   │             │
                │           ▼    ▼                                          │   ▼             │
                │  O7 types ─► O2 scheduler ═(Promise.all per DAG layer)═══►│  O4 panel       │
                │           │        │                                      │                 │
                │           └──► O5 chiefScribe ◄──────── group interims ───┘                 │
                │                    │                                                         │
                │  O6 sessionState ◄─┘ (redacted persistence under globalStorageUri)          │
                │                    ▼                                                         │
                │  B2 engineService ◄═(decompose / runSession / executePlan, plain await)     │
                │       ▲   │ emit(EngineEvent) → live board                                  │
                │       │   ▼                                                                  │
                │  B5 connectorRegistry   B6 secrets ─► B1 controller ─► B3 board (CSP)        │
                │       ▲                      ▲ (in-mem secretsAccessor)  ▲                   │
                │       └──────────────────────┴── X1 extension.ts ───────┘                   │
                │                                   └─► X2 modelLaneProvider [E] (F2 branch)   │
                └─────────────────────────────────────────────────────────────────────────────┘
   Evidence gate spans all gated modules: tsc --noEmit (strict) + node:test (181) +
   fidelity audit. Inherited shell (R1–R8) reused, not re-gated.
```

**Critical path (TS):**
`engine/types → engine/* → orchestrator/* → brainstorm/engineService → brainstorm/controller + extension.ts`.

**Notes.**
- **`connectors/egress.ts` (O9b)** and **`security.ts` (O8)** are the highest-risk
  security convergence points: every model byte transits `validateEgress`
  (`makeGuardedFetch`), and every cross-layer text transits `wrapUntrusted` /
  `detectInjection` / `quarantinePriorClaims` (S5 SSRF guard; S6 injection quarantine).
- **`decompose.ts` (O1)** is the **bespoke decomposition workflow** (F6 / BLD11) — it
  is **explicitly NOT a `UnitEngine.run()`** and does **not** inherit Unit Cell
  guarantees. It carries its own proposers/dedup/injection-guard and a hard
  `KnowledgePointSet.validate()` over points + DAG edges **before** CONFIRM_PLAN, and
  emits **two point types** (atomic + cross-cutting lenses).
- **`scheduler.ts` + `BudgetGovernor` (O2)** is the orchestration throat — DAG→waves,
  per-layer `Promise.all` under a concurrency cap, **absolute** token budget (S9), and
  the quarantined upstream-context handoff. Cooperative cancel and crash-resume reduce
  to in-process control flow (no protocol to drain).
- **`groupRunner.ts` (O3)** realizes total-egress: it injects **all** engine slots
  (agentA, agentB, judge, embeddings, research[Noop when off], harvester primary +
  second extractor), so the engine's `build()` never default-constructs an unguarded
  client — **proven** by `test/totalEgress.test.ts` (F4).
- **`engineService.ts` (B2)** is the in-process façade that **replaces `rpc_server.py`**
  — it carries ~the integration risk the v0.2 TS↔Py stdio seam used to, but as a typed
  in-memory call edge (no framing, no version-match), so that risk is **structurally
  reduced**, not merely mitigated.
- **`connectors/cli.ts` (O9f)** and **`multiDebate.ts` (O4)** are **off the minimal
  critical path** — they extend, not gate, the walking skeleton (R-CLI sandbox tracked
  in §8).

---

## 7. Per-Module Acceptance Checklists

Acceptance stubs for the ported modules. Every check is **✅** at v0.3 (the module is
built, compiles strict-clean, and its behaviors pass within the 181-test suite) unless
marked otherwise. The **inherited shell (R1–R8) is reused, not re-checked.** Full
per-module detail tables are owned by ENGINEERING.md; these are the dashboard-side
tracking stubs.

| Module | Check / Status |
|--------|----------------|
| **E1** `engine.ts` [E] | ✅ `onEvent` on `UnitEngine` constructor, invoked in `log()` (single sink, try/catch) · ✅ `proposeClashSplit`+`objective` on `UnitConfig` · ✅ golden: `onEvent` null + absent presets → current `UnitResult` · ✅ **frozen API honored**: `new UnitEngine({agentA,…,onEvent}).run(cfg)` — NEVER `new UnitEngine(cfg)` (F3/BLD15) · ✅ FAITHFUL (audit) |
| **E2–E3** `types.ts`/`config.ts` [N/E] | ✅ engine data model + `validateConfig` · ✅ `objective` is a LABEL the engine does not act on (honesty) |
| **E4** `agent.ts` [N] | ✅ stock `AgentClient` (OpenAI-shaped `chat`) · ✅ `speak`/`requestSlips`/`requestMove` funnel through `chat` · ✅ **4xx fail-fast** (`HttpError.status`; retry only network/timeout + 5xx) — fidelity fix |
| **E5** `judge.ts` [N] | ✅ generative/evaluative split; verifier family ≠ author · ✅ `pyRepr` True/False + Python quoting (fidelity fix) · ✅ FAITHFUL (audit) |
| **E6** `harvester.ts` [N] | ✅ two extractors, both connector-built + **always explicitly injected** (never engine default, F14) · ✅ code-point length via spread (fidelity fix) |
| **E7–E8** `ledger.ts`/`metrics.ts` [N] | ✅ dedup/MMR/novelty + σ_SI (diversity, computed at CLOSE) · ✅ both FAITHFUL (audit) |
| **E9** `research.ts` [N] | ✅ external search **OFF by default** · ✅ `NoopKnowledgeEngine` injected when off (returns `''`, zero network) |
| **E10–E11** `budget.ts`/`embeddings.ts` [N] | ✅ per-round guard; cosine/jaccard fallback + `degraded` flag; cache dir under `globalStorageUri` |
| **H1** `http.ts` [N·new] | ✅ `FetchLike`/`fetchJson`/`HttpError(.status)`; `httpFetch → globalThis.fetch`; AbortController timeouts; non-2xx throws |
| **H2** `rng.ts` [N·new] | ✅ seeded **mulberry32** `makeRng` (reproducible shuffle/pick) replaces Python `random.Random`; Thue-Morse opener by index |
| **H3** `util.ts` [N·new] | ✅ `sha256hex` via `node:crypto` replaces `hashlib`; `estimateTokens`; `clamp` |
| **O1** `decompose.ts` [N] | ✅ **bespoke — NOT a `UnitEngine.run()`** (F6/BLD11); own proposers/budget/injection-guard · ✅ `DECOMP_PREP→ENUMERATE→CRITIQUE→DEDUP→RANK→EMIT` · ✅ two point types (atomic + lenses, Flaw2) · ✅ edges `requires`(hard)/`informs`(soft); cycles resolved pre-gate (BLD5) · ✅ `KnowledgePointSet.validate()` before CONFIRM_PLAN (F6) · ✅ degenerate path (<2 → broaden) · ✅ accepted LOW divergence (null-text drop, §5.4) |
| **O2** `scheduler.ts` + `BudgetGovernor` [N] | ✅ DAG→waves (`topoLayers`); same-layer `Promise.all` under concurrency cap; cross-layer sequential · ✅ **absolute** token budget → stop scheduling (S9, F10) · ✅ quarantined predecessor context downstream · ✅ FAITHFUL (audit) |
| **O3** `groupRunner.ts` [N] | ✅ point+RoleMap+mode → injected `UnitEngine.run()` (one run = one group) · ✅ **all 7 slots connector-built + injected** · ✅ **trap-client test passes**: default constructors raise if reached (F4) · ✅ harvester always explicit; >2 debaters route to the panel |
| **O4** `multiDebate.ts` [N] | ✅ **>2-debater panel BUILT** (no longer deferred); routed by seat count; reuses engine primitives, not an engine fork |
| **O5** `chiefScribe.ts` [N] | ✅ cross-group dedup; contradiction **detect+present** (never auto-resolve) · ✅ emergent surfacing + mandatory "Flagged candidates" (LD7) · ✅ enforced-uncertainty report ("What we are NOT sure about"; evidence status per claim; grounded vs high-novelty separated) · ✅ σ_SI=diversity · ✅ single-pass regex replacer + `'n/a'` fallback (fidelity fixes) |
| **O6** `sessionState.ts` [N] | ✅ redacted per-group interim + session-state under `globalStorageUri` (never repo) · ✅ `redact()` deep over persisted artifacts |
| **O7** `types.ts` [N] | ✅ `KnowledgePoint(Set)`/`DependencyEdge`/`RoleMap`/`SeatConfig`/`GroupSpec`/`ModeProfile` · ✅ `topoLayers`/`predecessors`/`hasCycle`/`validate` |
| **O8** `security.ts` [N] | ✅ `wrapUntrusted`/`detectInjection`/`quarantinePriorClaims`/`redact`/`NoopKnowledgeEngine` · ✅ injection → disqualify + notice + user-confirmed re-plan (F11); structured outputs DATA-only; user text isolated, never disqualified |
| **O9a** `connectors/base.ts` [N] | ✅ `ConnectorInterface`; `makeAgentClient`/`makeEmbeddingsClient`; egress validated at construction **and** each build |
| **O9b** `connectors/egress.ts` [N] | ✅ loopback/private allowed; remote needs `allowRemote`+allowlist+https; cloud-metadata always blocked · ✅ `makeGuardedFetch` wraps every `FetchLike` · ✅ IPv4 `is_private` parity additions (fidelity fix) · ✅ accepted LOW divergences (§5.4) |
| **O9c–O9e** openai/anthropic/openaiCompatible [N] | ✅ OpenAI + local → stock `AgentClient` · ✅ Anthropic overrides **only** `chat`(+`lastUsage`); applies to harvester second extractor when Anthropic · ✅ DEFAULT seats = OpenAI (Codex persona) + Anthropic (Claude-Code persona) **API** models (F1) |
| **O9f** `connectors/cli.ts` [N] | ✅ drives real `codex`/`claude` as **sandboxed subprocesses** via their own login (F1) · ✅ `spawn(shell:false)` + argv list, **no shell interpolation** · ✅ bounded temp cwd (`os.tmpdir()`, never workspace) · ✅ **no managed key in argv/env** · ✅ per-call timeout (SIGKILL) + max-output cap · ✅ `allowFileTools=false` (single-shot print) (R-CLI) |
| **O9g** `connectors/factory.ts` [N] | ✅ `makeConnector(kind,…)` incl. `'cli'` |
| **X1** `extension.ts` [E] | ✅ registers the `modellane-brainstrom` provider/view/commands · ✅ **constructs `EngineService` in-process** (no spawn); wires `emit`→board + `secretsAccessor`→controller · ✅ `deactivate()` (no child to reap) |
| **X2** `modelLaneProvider.ts` [E] | ✅ inject synthetic "🧠 Brainstorm Debate Model" via discriminated `kind:"brainstrom"` **after the sort** · ✅ branch in **BOTH** `provideLanguageModelChatResponse` AND `provideTokenCount` before any delegate access (F2) · ✅ visible with no local model loaded |
| **B1** `controller.ts` [N] | ✅ CONFIRM_PLAN multi-turn gate (decompose+propose → executePlan on approval), keyed by **first-message identity** · ✅ `autoConfirmPlan=true` → single-turn `runSession` · ✅ one-shot secrets snapshot → `secretsAccessor` · ✅ saves report under `globalStorageUri` (path-validated) |
| **B2** `engineService.ts` [N] | ✅ **in-process façade** (replaces `rpc_server.py`): async `runGroup`/`runSession`/`decompose`/`executePlan` · ✅ `EngineEvent` emitter (`event/*` method strings preserved) · ✅ injectable executors (`defaultExecutor`/`defaultSessionExecutor`/`defaultDecomposeExecutor`/`defaultExecuteExecutor`) for network-free tests |
| **B3** `brainstormViewProvider.ts` [N] | ✅ live board: DAG + group accordions · ✅ CSP `default-src 'none'` + nonce + empty `localResourceRoots` (S7) · ✅ LLM text via `textContent` only; Markdown only in saved file · ☐ **handover/DESIGN.md before final UX polish** (BLD17/F16; M4) |
| **B4** `adminConsolePanel.ts` [N] | ✅ seats/roles/modes/connectors/budgets · ✅ secret via `showInputBox(password)`; **no secrets** shown/stored · ✅ exposes three logical moderator roles (T6/Flaw1) · ☐ **handover/DESIGN.md before final UX polish** (BLD17/F16; M4) |
| **B5** `connectorRegistry.ts` [N] | ✅ secret-free connector catalog · ✅ `buildSessionParams`/`buildExecuteParams` (param shaping for the engine) |
| **B6** `secrets.ts` [N] | ✅ SecretStorage wrapper; keys by `connectorId` · ✅ `collect(ids)` into the in-memory snapshot; never settings/logs/reports/argv/env (S1) |

---

## 8. Risk Register

Carried from the approved plan (R1–R8, R-STREAM) and the v0.2 audit additions (R-CLI,
R-EGRESS-BYPASS, R-COST, R-INTAKE, R-DECOMP), **with mechanisms updated to the
in-process TS runtime**. **R-PY is DROPPED as N/A** (no Python to bootstrap). Each maps
to one or more security controls (S1–S16, owned by CONSTITUTION.md §4), modules, and/or
audit findings.

```
┌────────────────┬───────────────────────────────────────────────┬──────────┬──────────┬──────────────────────────────────────────────┐
│ ID             │ Description                                    │ Level    │ Status   │ Mitigation (TS module)                       │
├────────────────┼───────────────────────────────────────────────┼──────────┼──────────┼──────────────────────────────────────────────┤
│ R1             │ API key leak (settings / logs / report /       │ 🔴 High  │ Mitigated│ S1 SecretStorage only; S2 in-memory          │
│                │ argv / env / export)                           │          │ (built)  │ secretsAccessor (NO stdio handshake); S8      │
│                │                                                │          │          │ central redact() (secrets.ts, security.ts)   │
│ R2             │ SSRF / cloud-metadata access via model- or     │ 🔴 High  │ Mitigated│ S5 validateEgress on EVERY fetch; block      │
│                │ research-supplied URL                          │          │ (P1 open │ private/link-local/metadata; https; allowlist │
│                │  └ DNS-rebinding sub-case (host classified     │          │ sub-case)│ (egress.ts). OPEN P1: resolve-and-recheck    │
│                │    WITHOUT DNS resolution)                     │          │          │ host before connect — documented in egress.ts │
│ R3             │ Cross-agent prompt injection (decompose /      │ 🔴 High  │ Mitigated│ S6 wrapUntrusted + detect → DISQUALIFY +     │
│                │ inter-group / scribe inputs)                   │          │ (built)  │ notice + user-confirmed re-plan (F11);        │
│                │                                                │          │          │ S10 verifier≠author; S11 anonymization        │
│ R4             │ DAG cost-DoS (runaway groups / width / depth)  │ 🟡 Med   │ Mitigated│ S9 ABSOLUTE token budget (BudgetGovernor) →  │
│                │                                                │          │ (built)  │ stop scheduling; S13 timeouts + backoff       │
│ R5             │ Secret leaks into saved report / exported      │ 🟡 Med   │ Mitigated│ S8 redact() on reports + UnitResult JSON +   │
│                │ UnitResult JSON                                │          │ (built)  │ persisted session meta; S14 save-path slugged │
│ R6             │ Forged webview postMessage                     │ 🟡 Med   │ Mitigated│ S7 strict postMessage schema; CSP            │
│                │                                                │          │ (built)  │ default-src 'none' + nonce (board, admin)     │
│ R7             │ Workspace setting silently enables remote      │ 🟡 Med   │ Mitigated│ S4 loopback-default + explicit               │
│                │ egress                                         │          │ (built)  │ brainstrom.allowRemote + allowlist; S16       │
│ R8             │ Stored-XSS via LLM text rendered as webview    │ 🔴 High  │ Mitigated│ S7 render via textContent only (Markdown     │
│                │ HTML                                           │          │ (built)  │ only in saved file); S8 redact               │
│ R-CLI          │ CLI subprocess execution surface (codex /      │ 🔴 High  │ Mitigated│ cli.ts sandbox: spawn shell:false; NO shell  │
│                │ claude) — command injection, secret leak via   │          │ (built)  │ interpolation; bounded temp cwd; no key in    │
│                │ argv/env, file writes, runaway output          │          │          │ argv/env; per-call timeout (SIGKILL) + output │
│                │                                                │          │          │ cap; allowFileTools=false (F1/BLD9)           │
│ R-EGRESS-BYPASS│ A missed injected engine slot reaches the      │ 🔴 High  │ PROVEN   │ groupRunner injects ALL slots; Noop-          │
│                │ network, bypassing the egress guard            │          │ contained│ KnowledgeEngine when research off; trap-      │
│                │                                                │          │ (built)  │ client test raises if a default ctor reached  │
│                │                                                │          │          │ (totalEgress.test.ts, F4)                     │
│ R-COST         │ Coarse cancel / already-started remote spend   │ 🟡 Med   │ Mitigated│ BudgetGovernor absolute cap (scheduler.ts);  │
│                │ (post-hoc accounting can't stop in-flight cost)│          │ (built)  │ per-call AbortController timeout (http.ts);    │
│                │                                                │          │          │ 4xx fail-fast; research+embeddings budgeted   │
│ R-INTAKE       │ Multi-turn session state lost (chat transcript │ 🟡 Med   │ Mitigated│ controller keys the pending plan on the       │
│                │ markers are not a reliable source of truth)    │          │ (built)  │ first user message; resumable state in        │
│                │                                                │          │          │ sessionState.ts, independent of transcript(F7)│
│ R-DECOMP       │ Bad decomposition gates the whole run (invalid │ 🔴 High  │ Mitigated│ decompose.ts KnowledgePointSet.validate() of │
│                │ points / DAG edges propagate to every group)   │          │ (built)  │ points+edges BEFORE CONFIRM_PLAN; user can    │
│                │                                                │          │          │ refine at the gate; bespoke guard (F6)        │
│ R-STREAM       │ Streaming-granularity expectations exceed      │ 🟡 Med   │ Mitigated│ onEvent PHASE-grain + native GROUP-grain via │
│                │ what is deliverable (per-seat / live σ_SI)     │          │ (built)  │ EngineEvent; honest labeling; per-seat + live │
│                │                                                │          │          │ σ_SI explicitly NOT emitted                   │
│ R-PY           │ Windows Python / deps bootstrap fails          │ ⚪ N/A   │ DROPPED  │ ELIMINATED — there is no Python interpreter, │
│                │ (3.x / Store-stub / offline / wheel-missing)   │          │ (retired)│ no requests, no numpy in the in-process TS    │
│                │                                                │          │          │ runtime; the risk no longer exists            │
└────────────────┴───────────────────────────────────────────────┴──────────┴──────────┴──────────────────────────────────────────────┘
```

### Risk Trend

```
R1:              🔴 → 🟢 mitigated (in-memory secretsAccessor + redact; built & tested)
R2:              🔴 → 🟡 mitigated, ONE open sub-case: DNS-rebinding resolve-and-recheck (P1)
R3:              🔴 → 🟢 mitigated (wrapUntrusted + detect/disqualify; injection tests green)
R4:              🟡 → 🟢 mitigated (absolute BudgetGovernor; scheduler tests green)
R5:              🟡 → 🟢 mitigated (deep redact over persisted artifacts; tests green)
R6:              🟡 → 🟢 mitigated (CSP + nonce + schema'd postMessage)
R7:              🟡 → 🟢 mitigated (loopback-default + explicit allowRemote opt-in)
R8:              🔴 → 🟢 mitigated (textContent-only render; Markdown only in saved file)
R-CLI:           🔴 → 🟢 mitigated (cli.ts sandbox controls; sandbox test green)
R-EGRESS-BYPASS: 🔴 → 🟢 PROVEN contained (trap-client test passes — all slots injected, F4)
R-COST:          🟡 → 🟢 mitigated (absolute cap + per-call timeouts + 4xx fail-fast, F10)
R-INTAKE:        🟡 → 🟢 mitigated (first-message session identity off-transcript, F7)
R-DECOMP:        🔴 → 🟢 mitigated (validate() before CONFIRM_PLAN + user refine, F6)
R-STREAM:        🟡 → 🟢 mitigated (honest group+phase grain via onEvent; no per-seat/live σ_SI)
R-PY:            🔴 → ⚪ DROPPED / N/A   [eliminated with the sidecar — no Python to bootstrap]
```

> **The one open security item.** Only **R2's DNS-rebinding sub-case** remains open: the
> egress guard classifies a base URL's **hostname without resolving DNS**, so a name
> that resolves to a private/metadata IP at connection time is not re-checked. A
> resolve-and-recheck pass is the **single open P1** (CONSTITUTION.md P1-17,
> ARCHITECTURE.md §10). It is **documented in `egress.ts`, not silently ignored**; the
> allowlist + https + explicit `allowRemote` requirements bound the remote surface in
> the meantime.

### 8.1 Verification Violation Log

A **violation** occurs when DASHBOARD.md module status contradicts the live evidence
artifacts (`tsc` result, the test suite, or the fidelity audit) — see ENGINEERING.md §7.
Violations are tracked here and must be resolved before M4 sign-off.

```
┌──────┬──────────────────────────────────────────────────────┬────────┬───────────┐
│ V-ID │ Description                                           │ Module │ Status    │
├──────┼──────────────────────────────────────────────────────┼────────┼───────────┤
│ —    │ (no violations — tsc strict CLEAN; 181/181 tests pass;│ —      │ 🟢 Clear  │
│      │  fidelity audit applied; verified 2026-06-15)         │        │           │
└──────┴──────────────────────────────────────────────────────┴────────┴───────────┘
```

**Resolution:** re-run `tsc --noEmit` (strict) + `npm test` and reconcile this board
with the result; the three evidence artifacts (§5) are authoritative over any hand edit.

---

## 9. Parallel Build Status

The v0.2 wave plan (Wave 0–5 + a P1 wave for the CLI connector) is **superseded** — the
port was executed as a single faithful translation pass per layer, gated by `tsc` + the
181-test suite + the fidelity audit, **not** by per-node gate logs. All build layers are
**DELIVERED headlessly**; the one open lane is the human in-VS-Code acceptance.

| Layer | Modules | Status |
|-------|---------|--------|
| **L0 — Ported engine** | `src/engine/*` (E1–E11) + new helpers `http`/`rng`/`util` (H1–H3) | ✅ DELIVERED — tsc✓; engine/judge/metrics/ledger FAITHFUL (audit) |
| **L1 — Connectors + egress** | `connectors/{base,egress,openai,anthropic,openaiCompatible,cli,factory}` (O9a–O9g) | ✅ DELIVERED — tsc✓; egress parity fixes applied; trap-client + sandbox tests green |
| **L2 — Orchestration (headless)** | `decompose`, `scheduler`, `security`, `types`, `sessionState` (O1, O2, O7, O8, O6) | ✅ DELIVERED — tsc✓; scheduler FAITHFUL (audit); decompose validate() before CONFIRM_PLAN |
| **L3 — Group execution + panel** | `groupRunner` (O3), `multiDebate` (O4) | ✅ DELIVERED — tsc✓; 7-slot injection proven; >2-debater panel built |
| **L4 — Synthesis + façade** | `chiefScribe` (O5), `engineService` (B2) | ✅ DELIVERED — tsc✓; in-process façade replaces `rpc_server.py`; scribe fidelity fixes |
| **L5 — Extension glue + provider** | `extension`, `modelLaneProvider` (X1, X2), `controller`, `connectorRegistry`, `secrets` (B1, B5, B6) | ✅ DELIVERED — tsc✓; F2 dual-branch; CONFIRM_PLAN; in-memory secretsAccessor |
| **L6 — Webview UX surfaces** | `brainstormViewProvider` (B3), `adminConsolePanel` (B4) | ✅ DELIVERED (compiles, CSP-hardened) — final visual polish gated on `handover/DESIGN.md` (BLD17/F16) ahead of M4 |
| **L7 — Tests + package** | `src/test/*.test.ts` (27 files), `.vsix` | ✅ DELIVERED — 181/181 tests; `modellane-brainstrom-ts-0.3.0.vsix` (51 files, ~142 KB) |
| **L8 — In-VS-Code acceptance** | the user's models + a live session | ⬜ **OPEN (human)** — the single remaining step (§10); cannot be automated headlessly |

> **No wave-gate `.gate_log/` anymore.** The v0.2 go/no-go wave gates keyed on
> `.gate_log/*.json` are gone with the harness. The equivalent go/no-go for the whole
> tree is: **`tsc --noEmit` strict clean AND `node:test` 181/181 AND the fidelity audit
> applied** — all three are green as of 2026-06-15. The CLI connector and >2-debater
> panel, formerly a deferred P1 wave, are **built** and off the critical path.

---

## 10. Acceptance Checklist & Enforcement

### 10.1 Definition of Done (per module)

```
Upon completing each module, verify ALL items (owned by ENGINEERING.md Definition of Done):

┌──────────────────────────────────────────────────────────────────────────┐
│ Module Completion Acceptance                                               │
│                                                                            │
│ □ Code complete     — All classes/methods/functions for this module exist  │
│ □ Strict compile    — tsc --noEmit (strict) → zero errors (whole tree)     │
│ □ Tests exist       — src/test/*.test.ts coverage for public behaviors     │
│ □ Tests pass        — node --test → 181 / 181 (zero network, zero tokens)  │
│ □ Fidelity (engine) — for the 5 core engine modules: adversarial audit     │
│                       reports FAITHFUL vs the Python source                │
│ □ Security gate     — applicable S1–S16 controls verified for this module   │
│ □ Risk register     — updated if any new risk discovered                    │
│ □ Committed         — git commit with descriptive message                  │
│                                                                            │
│ Cross-cutting release gates (all GREEN at v0.3):                            │
│ ✅ Engine-change golden — onEvent null + absent presets ⇒ current UnitResult │
│ ✅ Frozen API           — new UnitEngine({…,onEvent}).run(cfg); never        │
│                          new UnitEngine(cfg) (F3/BLD15)                     │
│ ✅ Synthetic-model branch — kind:"brainstrom" shows with NO local model;     │
│                          both provideLanguageModelChatResponse AND          │
│                          provideTokenCount branch before delegate (F2)      │
│ ✅ Trap-client egress   — all engine slots injected; NoopKnowledgeEngine     │
│                          when research off; default ctors raise if reached  │
│                          ⇒ PROVEN containment (totalEgress.test.ts, F4)     │
│ ✅ Injection-adversarial — malicious decompose/inter-group/scribe inputs     │
│                          wrapped + DISQUALIFIED; structured outputs data-    │
│                          only; user text isolated; no secret in any export   │
│ ✅ Egress               — loopback default; remote needs allowRemote+         │
│                          allowlist+https; SSRF/metadata blocked; research off│
│ ✅ Budget / cancel       — absolute BudgetGovernor; per-call AbortController   │
│                          timeout; 4xx fail-fast; research+embeddings budgeted│
│ ✅ Decomposition schema  — KnowledgePointSet.validate() of points + DAG edges │
│                          before CONFIRM_PLAN; bespoke (NOT a run(), F6)      │
│ ✅ DAG / cancel / resume — topo waves; Promise.all per layer; isolated per-    │
│                          group failure; session state off-transcript (F7)   │
│ ✅ CLI sandbox          — shell:false; no interpolation; bounded temp cwd;    │
│                          no key in argv/env; timeout(SIGKILL)+output cap;    │
│                          allowFileTools=false (F1/BLD9)                     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 10.2 The ONE remaining acceptance item (M4 — in-VS-Code live run)

Everything above is **proven headlessly**. The single item that **cannot be automated
here** is the user-side, in-editor live acceptance:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ M4 — In-VS-Code Live Acceptance (HUMAN; the only open gate)                 │
│                                                                            │
│ □ Install the .vsix:  code --install-extension                              │
│        ./modellane-brainstrom-ts-0.3.0.vsix --force  → Reload Window        │
│ □ Start a local model server (e.g. LM Studio at http://localhost:1234)      │
│ □ Pick the model: Chat → model picker → ModelLane-BrainStrom →              │
│        🧠 Brainstorm Debate Model   (visible even with no local model)      │
│ □ Type a domain → moderator intake → plan proposed (CONFIRM_PLAN)           │
│ □ Reply "go" → APPROVE the plan → debates run on the live board             │
│ □ A REPORT is produced against REAL models and saved as Markdown under      │
│        globalStorageUri/reports                                            │
│ □ (optional) enable a remote connector (brainstrom.allowRemote + key) and   │
│        repeat with OpenAI/Anthropic and/or the sandboxed CLI connector      │
│ □ Confirm: live board streams group/phase events; report is uncertainty-    │
│        honest; no secret appears in any log/report/export                   │
│                                                                            │
│ This requires a human running a real session against real models. It is     │
│ NOT scriptable headlessly (it needs the VS Code UI + live model endpoints   │
│ + cost). It is the sole sign-off standing between DELIVERED and SHIPPED.    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 10.3 Enforcement Rules

The checklist above is enforced by the verification protocol (ENGINEERING.md §7):

```
Rule 1 — VERIFICATION REQUIRED
  A module cannot reach ✅ VERIFIED unless the WHOLE tree compiles under
  tsc --noEmit (strict) and the WHOLE node:test suite passes (181/181). The
  five core engine modules additionally require a FAITHFUL fidelity verdict.

Rule 2 — NO MANUAL OVERRIDE OF EVIDENCE
  DASHBOARD.md status cannot claim ✅ VERIFIED / 🏁 DELIVERED against a red
  artifact. The three evidence artifacts (§5) are authoritative; this board
  mirrors them. (There is no longer a verify_gate.py --sync; reconciliation
  is re-running tsc + npm test.)

Rule 3 — AUDIT EVIDENCE
  The evidence of compliance is reproducible on demand: tsc exit 0, the
  node:test summary (tests 181 / pass 181 / fail 0), and the documented
  fidelity-audit verdict (§5.2–§5.4). These replace the .gate_log/*.json files.

Rule 4 — VIOLATION TRACKING
  Any discrepancy between this board and the live artifacts is a violation
  (§8.1) and blocks M4 sign-off until reconciled.

Rule 5 — M4 IS THE FINAL GATE
  All headless layers are DELIVERED; SHIPPED requires the human in-VS-Code
  acceptance run (§10.2). No code change is owed for M4 — it is a live run.
```

---

## 11. Revision History

| Version | Date | Author | Description |
|---------|------|--------|-------------|
| v0.1 | 2026-06-14 | architect + scientific-advisor | Initial draft from approved plan |
| v0.2 | 2026-06-14 | architect + scientific-advisor | Incorporate ARCHITECTURE_AUDIT_REPORT findings F1–F16 + workflow-logic flaws 1–6; hybrid connector policy; node convention N0–N25; gate-harness lock-step supervision. |
| v0.3 | 2026-06-15 | architect + scientific-advisor | pure-TypeScript in-process port: engine + orchestration ported to `src/engine` + `src/orchestrator`; Python sidecar/JSON-RPC removed; `EngineService` in-process façade; `tsc` strict CLEAN; 181/181 `node:test`; packaged `modellane-brainstrom-ts-0.3.0.vsix`. Replaced the gate-verification log + `.gate_log/` with the TS evidence table (tsc/tests/fidelity audit); module board re-keyed to TS modules (engine/judge/scheduler/metrics/ledger FAITHFUL; 6 fixes; 4 accepted LOW divergences); risk register dropped R-PY as N/A, kept DNS-rebinding as the open P1 sub-case of R2; sole remaining step is the in-VS-Code live acceptance run. |
