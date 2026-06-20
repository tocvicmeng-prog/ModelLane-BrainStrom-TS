# ModelLane-BrainStrom (TS) — Design System (`handover/DESIGN.md`)

> **Status: source of truth for all extension UI.** Required by the project's local
> `CLAUDE.md` ("Always read `handover/DESIGN.md` before making any visual or UI
> decision") and by **CONSTITUTION §6 BLD17 / Finding F16** ("`handover/DESIGN.md`
> required before UX surfaces — visual system, interaction density, sidebar layout,
> typography, accessibility — before implementing `brainstormViewProvider.ts` and
> `adminConsolePanel.ts`"). This document closes audit finding **F11**.
>
> **Scope.** It describes the design system as it is **actually implemented today** in
> the three webview surfaces:
>
> | Surface | File | What it is |
> |---------|------|------------|
> | **ModelLane chat** | `src/chatPanel.ts` | The local-model chat panel (user/assistant bubbles, Agent toggle, streaming, code blocks). |
> | **Live Board** | `src/brainstorm/brainstormViewProvider.ts` | The sidebar `WebviewView` that streams group/phase debate events. |
> | **Configure panel** | `src/brainstorm/adminConsolePanel.ts` | The structured admin console for connectors, seats, the panel of debaters, session settings, and centralized VS Code settings. |
>
> Do not deviate from the rules below without explicit user approval. In QA / design
> review, flag any code that contradicts this document (see §11, "What QA should flag").

---

## 1. Design Principles

These three principles are inherited from the project's CONSTITUTION and govern every
visual and interaction decision. They are not aspirational — each maps to concrete code
already in the three surfaces.

### 1.1 Local-first
The extension is a local-by-default tool. The default connector is a loopback
OpenAI-compatible server (`http://localhost:1234/v1`, `connectorRegistry.defaultConfig`),
research is off by default, and remote endpoints are an explicit opt-in. The UI reflects
this: every remote-enabling control (Allow remote endpoints, Allow remote LM Studio host,
Research) is an **off-by-default switch** with help text that states the privacy cost, and
the Configure header names the local kinds (`openai-compatible`) before the remote ones.
The chat panel talks only to the configured local API. **Never** add UI that implies cloud
dependence, telemetry, or account sign-in as a baseline; remote is always a labeled,
reversible choice.

### 1.2 Honest-uncertainty
The product's entire value rests on not overstating certainty (CONSTITUTION §8). The UI
must carry that honesty:
- Labels say what a thing **is**, not what we wish it were: cost figures are "estimates",
  σ_SI is a "diversity" signal (never a quality score), debate modes are "presets", the
  CLI connector help states it "uses the CLI's own login; no API key needed".
- Help text (`?` rings) is written to **disclose trade-offs** ("Off by default for privacy
  — your topic is sent to those services when enabled"), not to sell.
- Empty and in-progress states tell the truth: the Live Board's empty state gives literal
  next steps; the chat "Thinking…" indicator animates dots and is removed the moment
  streaming ends. No fake progress bars, no fabricated confidence percentages.

### 1.3 VS Code-native theming
Every surface is a VS Code webview that must look like it belongs in the editor under
**any** user theme (light, dark, high-contrast). This is achieved with **`--vscode-*` CSS
variables only** — there are **no hard-coded color literals** anywhere in the three files
(the only literal is the help-popover drop-shadow `rgba(0,0,0,0.35)`, an intentional
shadow tint, not a content color). Fonts, sizes, foregrounds, backgrounds, borders,
buttons, inputs, links, badges, and focus rings all resolve from the host theme. This is a
hard rule (§3, §4) and the single most important thing to preserve when editing UI.

---

## 2. Security & rendering invariants (binding — these are also UI rules)

Security in these webviews is part of the design system because it dictates how content is
built. All three surfaces already comply; any new UI MUST too (CONSTITUTION S7 / P0-9).

- **CSP-hardened webviews.** Every panel sets a strict Content-Security-Policy:
  `default-src 'none'`, `style-src 'nonce-<nonce>'`, `script-src 'nonce-<nonce>'`. The
  chat panel additionally allows `img-src ${cspSource} data:`. A fresh 32-char `nonce` is
  generated per render (`makeNonce` / `getNonce`). No inline event handlers without the
  nonce, no remote `src`, no `style-src 'unsafe-inline'`.
- **Empty `localResourceRoots`.** All three webviews pass `localResourceRoots: []` — no
  local file is loadable into the view. Keep it empty.
- **`textContent`-only rendering of model/config data.** Any text that originates from a
  model, a connector, a skill file, or saved config is inserted with `textContent` or
  `document.createTextNode`, **never** `innerHTML`. The Live Board renders event method +
  params via `textContent` (with a code comment saying so); the chat panel's lightweight
  Markdown renderer builds `<pre>/<code>/<strong>/<em>/<br>` elements and assigns
  `.textContent` for every text run; the Configure panel builds every row with a
  `createElement` helper (`el(...)`). **Markdown is rendered as HTML only in the saved
  report file, never in a webview.**
- **Secrets never touch the DOM.** API keys are collected via
  `vscode.window.showInputBox({ password: true })` and written straight to SecretStorage;
  the webview only ever holds opaque connector **ids**. No field, chip, log, or tooltip may
  display a secret.
- **Embedded JSON is escaped.** Config/spec/values injected into the inline `<script>` are
  `JSON.stringify(...).replace(/</g, '\\u003c')` before embedding.

---

## 3. Color system (semantic, via `--vscode-*`)

Use the semantic token for the role, not a raw color. The table is the authoritative
mapping already used across the three files.

| Role | Token | Where used |
|------|-------|-----------|
| Default text | `--vscode-foreground` / `--vscode-editor-foreground` | body text, switch hover |
| Muted / secondary text | `--vscode-descriptionForeground` | hints, field labels, payloads, help glyph |
| Panel / app background | `--vscode-sideBar-background` | chat panel body |
| Surface border / divider | `--vscode-panel-border` | rows, seats, event divider, input borders |
| Primary button bg / fg | `--vscode-button-background` / `--vscode-button-foreground` | Save, Send, active toggle, switch-on track |
| Primary button hover | `--vscode-button-hoverBackground` | Send/Save hover |
| Secondary button bg / fg | `--vscode-button-secondaryBackground` / `--vscode-button-secondaryForeground` | Reset, Add, Remove, Agent toggle (off), combo "Other" back-arrow |
| Secondary button hover | `--vscode-button-secondaryHoverBackground` | code-action buttons |
| Input bg / fg / border | `--vscode-input-background` / `--vscode-input-foreground` / `--vscode-input-border` | text/number/select fields, switch-off track |
| Focus ring | `--vscode-focusBorder` | input focus, switch focus-visible outline |
| Link / accent | `--vscode-textLink-foreground` | event kind label, user chat bubble bg |
| Badge / chip bg + fg | `--vscode-badge-background` / `--vscode-badge-foreground` | skill-file chips |
| Toolbar hover | `--vscode-toolbar-hoverBackground` | header icon-button hover, help-glyph hover |
| Code / preformatted | `--vscode-textBlockQuote-background`, `--vscode-textPreformat-foreground`, `--vscode-editor-font-family` | inline code, `<pre>`, code-lang label |
| Hover-widget popover | `--vscode-editorHoverWidget-background` / `-foreground` / `-border` (fall back to `editorWidget` / `foreground` / `panel-border`) | the `?` help popover |
| Inactive selection | `--vscode-editor-inactiveSelectionBackground` | assistant chat bubble bg |

**Rule:** if a needed role has no token above, pick the closest VS Code theme variable and
add it here — do **not** introduce a hex/rgb literal. Always supply a fallback for less
common tokens, e.g. `var(--vscode-input-border, transparent)`.

---

## 4. Typography

- **Family.** UI text uses `var(--vscode-font-family)`. Code and any preformatted/model
  code uses `var(--vscode-editor-font-family)`.
- **Base size.** `var(--vscode-font-size)`; do not set an absolute base px size. Relative
  steps are expressed in `em`:
  - Chat title `#header h1`: `13px / 600` (the one intentional fixed header size).
  - Configure headings: `h2` `1.2em`, `h3` `1.05em`; Live Board `h3` `1.1em`.
  - Field labels / hints / help glyph / chips: `0.8–0.85em`, in `descriptionForeground`.
  - Code blocks / inline code: `12px`; code-lang + thinking indicator: `11–12px`.
- **Weight.** Headings and the event "kind" label use `600`. Body is normal weight.
  `**bold**` in chat renders as `<strong>`; `*italic*` as `<em>`.
- **Whitespace.** Streamed payloads and help bodies use `white-space: pre-wrap` with
  `word-break: break-word` so long model output and JSON wrap without overflowing.

---

## 5. Spacing & layout

A compact, editor-density system (this is a developer tool inside a side panel, not a
marketing page).

- **Panel padding.** Chat body is a full-height (`height: 100vh`) flex column; Configure
  body `12px`; Live Board `8px`.
- **Rows.** The Configure `.row` is `display:flex; flex-wrap:wrap; gap:6px;
  align-items:center; margin:4px 0; padding:6px; border:1px solid panel-border;
  border-radius:4px`. Grouped blocks (`.seat`) add an `8px` padded, bordered container with
  a bold label.
- **Field columns.** A field is a `.fieldcol` (label stacked above control) via
  `inline-flex; flex-direction:column`. Labels (`.lbl`) sit above their input with a `2px`
  gap and an inline `?` help glyph.
- **Control widths (Configure).** Standardized so rows align: id/model/base `150px`,
  family `110px`, persona `200px`, number `70px`, combo select/input `150px`, setting input
  `170px` (`select.set-input` `178px`). Keep new controls within this scale.
- **Action bars.** The Configure `.bar` is `margin-top:16px; display:flex; gap:8px`
  (primary Save first, secondary Reset second). Chat `#input-area` is a bottom-docked flex
  row (`gap:6px`, `align-items:flex-end`) with the textarea growing and Agent/Send pinned.
- **Border radius scale.** Buttons `3px`; rows/seats/inputs `4px`; chat bubbles/inputs
  `6–8px`; switch track / chip `10–18px` (pill). Stay on this scale.
- **Auto-grow textarea.** The chat input grows from `min-height:34px` to `max-height:120px`
  on input, then scrolls. Preserve this (no fixed multi-line box).

---

## 6. Component patterns

The Configure panel is the richest surface; these are the canonical components. Reuse
them rather than inventing new shapes.

### 6.1 Field with label + `?` help
Every adjustable option is a `.fieldcol` = a `.lbl` (label text + a `?` help glyph) above
its control, built by the `field(labelText, input, helpKey)` helper. The `?` is a small
(14px) circular ring (`.help`) in `descriptionForeground` that brightens to `foreground`
on hover. Clicking it toggles a single floating **help popover** (`#help-pop`) anchored
under the glyph; clicking the same glyph again, clicking outside, or pressing `Escape`
closes it. Help content lives in the `HELP` map (`{ t: title, b: body }`); every field —
including each centralized setting — has an entry. **Rule:** any new field gets a help
entry; never ship a control with no explanation.

### 6.2 On/off switch for booleans
Booleans render as a **switch**, never a bare checkbox. The `.switch` is a 34×18 pill with
a sliding 12px knob: off = `input-background` track + `descriptionForeground` knob; on =
`button-background` track + `button-foreground` knob translated right; focus shows a
`focusBorder` outline. Built by `switchControl` / `switchField`; used for `research`, the
CLI `file tools` field, and every `type:'bool'` centralized setting (Allow remote, Auto-run,
Allow remote LM Studio host, Inline completion, Editor context menu). **Rule:** a boolean
option is a switch.

### 6.3 Dropdown + "Other…" combo for common values
Fields with a set of common values but an open domain use the **combo** pattern
(`comboControl` / `comboField`): a `<select>` of presets plus an `Other…` option that swaps
the select for a free-text input with a `▾` back-arrow to return to the list. A
hidden input always holds the real value. Used for seat/debater `connector id` (presets =
the live connector ids), `model` (`MODEL_PRESETS`), and `family` (`FAMILY_PRESETS`). Enum
settings with a closed domain (e.g. API mode `native`/`openai`, debate `mode`) use a plain
`<select>` instead. **Rule:** open-domain-with-suggestions → combo; closed enum → select.

### 6.4 Badge / chip (skill files)
A loaded skill file shows as a **chip** (`.chip`): a rounded `badge-background` pill with a
📎 + filename and an `✕` remove affordance. Built per persona target; the persona `<input>`
is double-clicked to open the OS file dialog (`pickSkillFile` round-trip), and the loaded
file's name is shown as a chip while its content is held in a `SKILLS` map (never rendered
as HTML). **Rule:** transient attached artifacts (files, tags) use the chip shape;
filenames are shown via `textContent`.

### 6.5 Buttons
Two tiers only: **primary** (`button`, theme button colors — Save, Send, Set API key
confirm path) and **secondary** (`button.secondary` — Reset, + Add connector / + Add
debater, Remove, combo back-arrow, Agent-toggle-off, code actions). Primary actions lead;
destructive/auxiliary actions are secondary. Disabled buttons drop to `opacity:0.5` and a
default cursor (used while streaming).

### 6.6 Chat message bubbles
User messages are right-aligned (`align-self:flex-end`) on a `textLink-foreground` bubble;
assistant messages are left-aligned on an `inactiveSelectionBackground` bubble; both
`max-width:92%`, `border-radius:8px`, `white-space:pre-wrap`. Fenced code becomes a `<pre>`
with an optional code-lang label; inline `` `code` ``, `**bold**`, `*italic*` are parsed by
the local renderer — all via `textContent`. The Agent toggle, "Thinking…" indicator, and a
Cancel (`X`) button that appears only while streaming complete the pattern.

### 6.7 CLI-only conditional fields
When a connector's kind is `cli`, an inline `.cli-only` group (`command`, `prompt via`
stdin/arg, `timeout s`, `file tools` switch) is revealed; for any other kind it is hidden
(`display:none`). Conditional fields toggle on the kind `<select>`'s change and on initial
render. **Rule:** show kind-specific fields only when relevant; default them safely
(`file tools` off).

---

## 7. The Live Board section model

`brainstormViewProvider.ts` is a streaming **append-only log**, intentionally minimal
(CONSTITUTION T5/§8.6 — "group-grain + phase-grain, not per-seat, not live σ_SI").

- **Empty state (`#empty`).** Shown until the first event arrives; gives the literal two
  steps (1. run *BrainStrom: Configure* via the Command Palette or the ⚙ title-bar button;
  2. pick the 🧠 *Brainstorm Debate Model* in Chat and type a topic). Hidden on first
  message.
- **Event rows (`.ev`).** Each posted `EngineEvent` becomes one row with a bottom divider:
  a bold **kind** label (`m.method`, e.g. `event/group.start` · `group.phase` ·
  `group.interim` · `group.error`) in `textLink-foreground`, followed by a wrapped
  **payload** (`JSON.stringify(m.params)`) in `descriptionForeground`. Both via
  `textContent`.
- **Streaming discipline.** Only group-grain and phase-grain events appear here; the board
  **never** renders draft report content, scribe reasoning, secrets, or per-seat
  micro-progress. The final report is delivered as the closing chat response + saved
  Markdown, not on the board.
- **Live region.** The log container is `role="log" aria-live="polite"` so new events are
  announced to assistive tech without stealing focus.

**Rule when extending the board** (e.g. the deferred richer DAG view, P2-4): keep it
append-only and honest, keep every model-derived string `textContent`-rendered, and do not
introduce live quality/σ_SI scoring.

---

## 8. Motion

Motion is functional and restrained — it communicates state, never decorates.

- Switch knob/track: `transition: transform .15s, background .15s`.
- "Thinking…" indicator: a stepped `dots` keyframe animation (`'' → . → .. → ...`) while a
  request is in flight; element is `display:none` otherwise.
- Chat messages call `scrollIntoView({ behavior: 'smooth' })` as they stream.
- No entrance animations, parallax, or attention-seeking motion. Respect that VS Code users
  may have reduced-motion preferences; keep durations ≤150ms and effects subtle.

---

## 9. Accessibility

- **Theme-driven contrast.** Because all colors come from `--vscode-*`, contrast tracks the
  user's theme, including high-contrast themes. Never hard-code a color that could fail
  contrast under another theme.
- **Visible focus.** Inputs use `--vscode-focusBorder` on focus; the switch shows a
  `focusBorder` outline on `:focus-visible`. Preserve focus styling on any new control.
- **Keyboard.** The help popover closes on `Escape`; chat sends on `Enter` (Shift+Enter =
  newline). New interactive elements must be reachable and operable by keyboard; do not trap
  focus.
- **ARIA / semantics.** The board log is `role="log" aria-live="polite"`; the Agent toggle
  exposes `aria-pressed`; icon buttons carry `title` tooltips. Use native `<button>`,
  `<select>`, `<input>`, `<label>` (the switch wraps a real checkbox) rather than
  click-handled `<div>`s.
- **Labels.** Every control has a visible label (`.lbl`) and a `?` help entry; placeholders
  (e.g. `http://localhost:1234/v1`, "Ask ModelLane…") are hints, not substitutes for labels.

---

## 10. Adding or changing UI — checklist

1. Reuse a §6 component (field+help, switch, combo/select, chip, button tier) before
   inventing a new one.
2. Colors: semantic `--vscode-*` token from §3 only — **no hex/rgb literal**. Add a token
   row here if a new role is needed.
3. Sizes/spacing: stay on the §4/§5 type and spacing scales; reuse the standard control
   widths.
4. Booleans → switch; open-domain-with-suggestions → combo; closed enum → select.
5. Build DOM with `createElement`/`textContent` (or `el(...)`); never `innerHTML` of model,
   connector, skill-file, or config data.
6. Keep CSP strict, `localResourceRoots` empty, the per-render nonce, and secrets out of the
   DOM.
7. Give every new field a `?` help entry that honestly states trade-offs (privacy, cost,
   remote egress).
8. Confirm visible focus, a real label, keyboard operability, and correct theme rendering in
   light, dark, and high-contrast.
9. Keep the Live Board append-only, group/phase-grain, and honest (no live σ_SI, no draft
   content).

---

## 11. What QA should flag

In QA / design-review mode, treat any of the following as a finding against this document:

- **Hard-coded colors** — any hex (`#fff`), `rgb()/rgba()` (other than the one intentional
  popover shadow tint), or named color in a webview; anything that won't adapt to the user's
  theme.
- **CSP / security regressions** — a relaxed CSP (`unsafe-inline`, a remote `src`,
  `default-src` other than `'none'`), a missing/reused nonce, or a non-empty
  `localResourceRoots`.
- **`innerHTML` of untrusted data** — any model output, connector value, skill-file content,
  saved config, or event payload assigned via `innerHTML`/`insertAdjacentHTML` instead of
  `textContent`. Markdown rendered as HTML anywhere but the saved report file.
- **Secrets in the UI** — an API key shown in a field, chip, tooltip, log line, or the DOM;
  a key collected anywhere other than a password `showInputBox`; a key persisted outside
  SecretStorage.
- **Wrong component for the data** — a bare checkbox where a switch is expected; a free-text
  box where a combo/select of known values belongs; a button miscolored as primary when it
  is secondary/destructive.
- **Missing help / dishonest labels** — a new field with no `?` entry; copy that oversells
  (calls σ_SI a "quality" score, shows cost without the word "estimate", implies the CLI
  uses a managed key, presents a fabricated confidence %, or hides that remote/research
  sends data out).
- **Accessibility gaps** — no visible focus, missing label, keyboard-inoperable control,
  click-handled `<div>` instead of a native element, or a removed/incorrect ARIA role on the
  board log / Agent toggle.
- **Local-first violations** — a remote/cloud/telemetry/sign-in dependency presented as the
  default, or a remote-enabling control that defaults **on**.
- **Live Board overreach** — per-seat micro-progress, live σ_SI/quality scoring, or draft
  report content streamed to the board; an event payload not rendered via `textContent`.
- **Layout drift** — control widths, paddings, radii, or font sizes that depart from the
  §4/§5 scales without reason.

---

*This document reflects the implemented UI of `chatPanel.ts`,
`brainstorm/brainstormViewProvider.ts`, and `brainstorm/adminConsolePanel.ts`. When the
code and this document disagree, fix the discrepancy — update the code to honor the
principle, or update this document with explicit user approval — but never leave them out
of sync.*
