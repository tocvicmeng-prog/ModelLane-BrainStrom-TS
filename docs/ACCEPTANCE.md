# VS Code Runtime Acceptance Checklist (audit finding F5)

This is the manual, in-editor acceptance test for the **packaged** extension. It
proves the real end-user workflow that the headless test suite cannot: installing
the `.vsix`, reloading VS Code, **configuring** connectors + seats, driving a
debate from the **VS Code Chat** panel, watching the **live board**, and saving
the **Markdown report**.

The automated companion (zero-network, deterministic) lives at
`src/test/acceptance.test.ts` and exercises the same
**configure → session → report** contract through `EngineService.runSession`
without a model server. This document is the manual sign-off that the same
contract holds against a *real* model server inside a *real* VS Code window.

---

## Prerequisites (P)

> [!IMPORTANT]
> Steps 5–11 require a **running local model server**, e.g. **LM Studio** with a
> chat model loaded and its OpenAI-compatible server started (default
> `http://localhost:1234/v1`). Ollama / vLLM / llama.cpp / llamafile also work —
> substitute the matching base URL. Without a reachable server, configuration
> (steps 2–4) still passes, but the debate (steps 7–11) is expected to **FAIL**
> with a connection error, which is itself a correct, graceful outcome.

| # | Precondition | PASS criteria |
|---|---|---|
| P1 | A supported VS Code (>= the `engines.vscode` floor in `package.json`, currently `^1.104.0`) is installed. | `code --version` prints a version at or above the floor. |
| P2 | The extension has been packaged. | `modellane-brainstrom-ts-<version>.vsix` exists in the project root (produced by `vsce package`). |
| P3 | A local model server is running with at least one chat model loaded. | The server's `/v1/models` (or equivalent) returns at least one model id. Note the **base URL** and **model id** for step 3. |

---

## Step 1 — Install the VSIX and reload

1. Install the package:
   - GUI: Extensions view → `...` menu → **Install from VSIX...** → pick the `.vsix`, **or**
   - CLI: `code --install-extension modellane-brainstrom-ts-<version>.vsix`.
2. Run **Developer: Reload Window** (or fully restart VS Code).

**PASS:** The extension appears as **installed and enabled** in the Extensions
view; no activation error notification is shown. The `ModelLane-BrainStrom (TS)`
commands are present in the Command Palette.
**FAIL:** Install error, the extension is missing/disabled, or an activation
error toast appears on reload.

---

## Step 2 — Open BrainStrom: Configure

1. Command Palette → **BrainStrom: Configure** (`brainstrom.configure`).

**PASS:** The configuration UI opens without error and shows entry points for
**connectors** and **seats/role map**.
**FAIL:** The command is missing, throws, or the panel fails to render.

---

## Step 3 — Add a local connector

1. Add a new connector pointing at the local server from P3:
   - **kind:** `openai-compatible` (or `openai` / `anthropic` / `cli` as appropriate),
   - **id:** a short stable id, e.g. `local`,
   - **base_url:** the server URL, e.g. `http://localhost:1234/v1`,
   - leave **allow_remote** **off** (local egress only).
2. Save the connector.

**PASS:** The connector is listed with the id and base URL you entered; it
persists across a **Reload Window**. `allow_remote` defaults to off.
**FAIL:** The connector is not saved, loses its base URL, or silently flips
`allow_remote` on.

---

## Step 4 — Add seats (role map: agentA, agentB, judge)

1. Assign the three required seats to the connector from step 3, each with a
   model id available on your server:
   - **agentA** → connector `local`, model `<your-model-id>`,
   - **agentB** → connector `local`, model `<your-model-id>`,
   - **judge** → connector `local`, model `<your-model-id>`.
2. (Optional) add extra **debater** seats to exercise the N-debater panel path.
3. Save the role map.

**PASS:** All three required seats resolve to a configured connector + model and
the plan validates with **no missing-seat problems**.
**FAIL:** A required seat is unassigned, points at an unknown connector, or
configuration reports a validation problem.

---

## Step 5 — (Optional) Set the API key

> Only required for connectors that authenticate (hosted/remote providers). A
> purely local LM Studio server typically needs **no** key.

1. Command Palette → the **Set API key** command for the connector id from step 3.
2. Enter the secret when prompted.

**PASS:** The key is stored in VS Code **SecretStorage** (not in settings JSON,
not in the workspace). Re-opening Configure shows the connector as
**key-provisioned** without revealing the secret value.
**FAIL:** The key is echoed back in plaintext, written to `settings.json`, or not
retained for the session.

---

## Step 6 — Open VS Code Chat and pick the Brainstorm Debate model

1. Open the **Chat** view (the built-in VS Code Chat panel).
2. In the model picker, select **🧠 Brainstorm Debate Model**.

**PASS:** The 🧠 Brainstorm Debate Model is listed in the chat model picker and
becomes the active model for the chat session.
**FAIL:** The model is absent from the picker or cannot be selected.

---

## Step 7 — Type a topic

1. In the chat input, type a debatable topic, e.g.
   *"Is serverless a better default than containers for new startups?"*
2. Submit.

**PASS:** The extension acknowledges the topic and begins **decomposition** —
producing a proposed plan of knowledge points (and a dependency DAG) rather than
a single free-text answer.
**FAIL:** No response, an immediate error, or a plain chat completion with no plan.

---

## Step 8 — Confirm the proposed plan

1. Review the proposed knowledge points and dependency edges.
2. **Confirm** the plan to start the debates (or edit/reject as offered).

**PASS:** Confirming transitions the session from **CONFIRM_PLAN** to **RUNNING**.
The plan shown is **acyclic** and is exactly what executes. Rejecting cancels
cleanly with no orphaned work.
**FAIL:** Confirm does nothing, the plan contains a cycle, or the executed plan
differs from the one shown.

---

## Step 9 — Watch the live board

1. The live board view opens (or is already open) and streams progress.

**PASS:** The board shows live events as debates run, including at least:
`schedule.plan`, `group.start`, `group.interim`, and `aggregate.progress`.
Points run in dependency order; dependent points receive prior context.
**FAIL:** The board stays empty, freezes, errors, or events arrive out of
dependency order.

---

## Step 10 — Receive the Markdown report

1. Wait for the session to reach **DONE**.

**PASS:** A final **Markdown report** is delivered back into the chat. It begins
with `---` YAML front-matter, references the knowledge-point ids, and reports a
`groupsRun` count equal to the number of confirmed points.
**FAIL:** No report, a non-Markdown blob, a truncated report, or a `groupsRun`
count that disagrees with the confirmed plan.

---

## Step 11 — Save the report

1. Use the offered **Save** action (or copy the Markdown) and write it to a `.md`
   file in the workspace.

**PASS:** The saved file is valid Markdown, opens and renders in VS Code's
Markdown preview, and round-trips the front-matter + body unchanged.
**FAIL:** Save fails, writes empty/corrupt content, or loses the front-matter.

---

## Sign-off

A run **PASSES** acceptance when **every** step P1–P3 and 1–11 passes against a
real local model server (step 5 only where the connector requires auth). Record
the VS Code version, the extension version, the model server + model id, and the
date of the run alongside this checklist.
