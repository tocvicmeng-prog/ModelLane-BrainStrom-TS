import * as vscode from 'vscode';
import { EngineEvent } from './engineService';

/**
 * brainstormViewProvider.ts (N18) — the live sidebar board (STRUCTURED; audit F7).
 *
 * Replaces the old append-only raw-JSON event log with stable SECTIONS that update in
 * place as GROUP/PHASE-grain events stream from the in-process engine:
 *
 *   (1) PLAN    — knowledge points + dependency edges, from decompose.* events.
 *   (2) GROUPS  — one card per groupId (keyed), showing current phase, status
 *                 (running/done/error) and, once group.interim arrives, the interim
 *                 summary + validated/candidate counts + sigma/composite.
 *   (3) FOOTER  — errors and (when present) a budget line.
 *
 * Events arrive via postEvent as { method: 'event/<kind>', params: <groupEventToDict> }
 * i.e. params = { group_id, kind, payload, session_id }. Unknown kinds fall back to a
 * small log row so nothing is silently dropped.
 *
 * SECURITY (handover/DESIGN.md §6 / CONSTITUTION S7): CSP `default-src 'none'`, no
 * remote content, empty localResourceRoots, a nonce-gated inline style+script, and ALL
 * model/event text rendered via `textContent` / `createElement` ONLY — never the
 * innerHTML of any event data. Markdown is only ever rendered in the saved report file.
 */
export class BrainstormViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'brainstrom.board';
  private view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) { }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this.html(webviewView.webview);
  }

  /** Forward an engine event to the board (best-effort; no-op if the view is closed). */
  postEvent(event: EngineEvent): void {
    this.view?.webview.postMessage(event);
  }

  private html(_webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           font-size: var(--vscode-font-size); padding: 8px; }
    h3 { margin: 0 0 8px; font-size: 1.1em; }
    h4 { margin: 14px 0 6px; font-size: 1em; color: var(--vscode-foreground);
         border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; }
    .empty { color: var(--vscode-descriptionForeground); }
    .hidden { display: none; }
    section { margin-bottom: 6px; }

    /* Plan */
    .point { padding: 3px 0; }
    .pid { color: var(--vscode-textLink-foreground); font-weight: 600; margin-right: 6px; }
    .pkind { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 6px; }
    .ptext { word-break: break-word; }
    .edges { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px;
             white-space: pre-wrap; word-break: break-word; }

    /* Groups */
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px;
            padding: 6px 8px; margin: 6px 0; }
    .card-head { display: flex; align-items: baseline; gap: 6px; }
    .card-id { color: var(--vscode-textLink-foreground); font-weight: 600; }
    .badge { font-size: 0.78em; padding: 1px 6px; border-radius: 8px; margin-left: auto;
             border: 1px solid var(--vscode-panel-border); white-space: nowrap; }
    .badge.running { color: var(--vscode-charts-blue); }
    .badge.done { color: var(--vscode-charts-green); }
    .badge.error { color: var(--vscode-errorForeground); }
    .card-point { word-break: break-word; margin: 2px 0; }
    .phase { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin: 2px 0;
             word-break: break-word; }
    .summary { white-space: pre-wrap; word-break: break-word; margin: 4px 0; }
    .metrics { color: var(--vscode-descriptionForeground); font-size: 0.88em;
               display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; }
    .card-err { color: var(--vscode-errorForeground); word-break: break-word; margin-top: 4px; }

    /* Footer */
    .err-row { color: var(--vscode-errorForeground); padding: 2px 0; word-break: break-word; }
    .budget { color: var(--vscode-descriptionForeground); padding: 2px 0; word-break: break-word; }

    /* Unknown-kind fallback log */
    .logrow { padding: 2px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .logkind { color: var(--vscode-textLink-foreground); font-weight: 600; margin-right: 6px; }
    .logpayload { color: var(--vscode-descriptionForeground); white-space: pre-wrap;
                  word-break: break-word; }
  </style>
</head>
<body>
  <h3>BrainStrom — Live Board</h3>

  <div id="empty" class="empty">
    No active session yet.<br /><br />
    <b>1.</b> Run <b>BrainStrom: Configure</b> (Command Palette, or the &#9881; button in this view's title bar)
    to add your debate models — the <b>Codex</b> / <b>Claude</b> CLIs, or OpenAI / Anthropic / local APIs.<br />
    <b>2.</b> In Chat, pick the &#129504; <b>Brainstorm Debate Model</b> and type a topic.
  </div>

  <section id="plan-section" class="hidden">
    <h4>Plan</h4>
    <div id="plan-points"></div>
    <div id="plan-edges" class="edges"></div>
  </section>

  <section id="groups-section" class="hidden">
    <h4>Groups</h4>
    <div id="groups"></div>
  </section>

  <section id="footer-section" class="hidden">
    <h4>Status</h4>
    <div id="budget" class="hidden"></div>
    <div id="errors"></div>
  </section>

  <section id="log-section" class="hidden">
    <h4>Other events</h4>
    <div id="log" role="log" aria-live="polite"></div>
  </section>

  <script nonce="${nonce}">
    (function () {
      'use strict';

      var empty = document.getElementById('empty');
      var planSection = document.getElementById('plan-section');
      var planPoints = document.getElementById('plan-points');
      var planEdges = document.getElementById('plan-edges');
      var groupsSection = document.getElementById('groups-section');
      var groupsEl = document.getElementById('groups');
      var footerSection = document.getElementById('footer-section');
      var budgetEl = document.getElementById('budget');
      var errorsEl = document.getElementById('errors');
      var logSection = document.getElementById('log-section');
      var logEl = document.getElementById('log');

      // groupId -> { el, phaseEl, summaryEl, metricsEl, errEl, badgeEl } (rebuilt in place).
      var cards = Object.create(null);

      function show(el) { el.classList.remove('hidden'); }
      function clear(el) { while (el.firstChild) { el.removeChild(el.firstChild); } }
      function activate() { if (empty) { empty.classList.add('hidden'); } }

      // Coerce arbitrary event values to a safe display string (never trusts shape).
      function asText(v) {
        if (v === null || v === undefined) { return ''; }
        if (typeof v === 'string') { return v; }
        if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
        try { return JSON.stringify(v); } catch (_) { return String(v); }
      }

      function num(v) {
        return (typeof v === 'number' && isFinite(v)) ? v : null;
      }

      function count(v) {
        return Array.isArray(v) ? v.length : 0;
      }

      function fmt(n) {
        return (Math.round(n * 1000) / 1000).toString();
      }

      // ---------------------------------------------------------------- PLAN section
      function renderPlan(points, edges) {
        activate();
        show(planSection);
        clear(planPoints);
        var byId = Object.create(null);
        (Array.isArray(points) ? points : []).forEach(function (p) {
          if (!p || typeof p !== 'object') { return; }
          byId[asText(p.id)] = true;
          var row = document.createElement('div');
          row.className = 'point';
          var pid = document.createElement('span');
          pid.className = 'pid';
          pid.textContent = asText(p.id);
          var txt = document.createElement('span');
          txt.className = 'ptext';
          txt.textContent = asText(p.text);
          row.appendChild(pid);
          row.appendChild(txt);
          if (p.kind) {
            var k = document.createElement('span');
            k.className = 'pkind';
            k.textContent = '[' + asText(p.kind) + ']';
            row.appendChild(k);
          }
          planPoints.appendChild(row);
        });

        clear(planEdges);
        var es = (Array.isArray(edges) ? edges : []);
        if (es.length) {
          var lines = [];
          es.forEach(function (e) {
            if (!e || typeof e !== 'object') { return; }
            lines.push(asText(e.src) + ' --' + asText(e.kind || 'informs') + '--> ' + asText(e.dst));
          });
          planEdges.textContent = lines.join('\\n');
        }
      }

      // -------------------------------------------------------------- GROUPS section
      function ensureCard(groupId) {
        var id = asText(groupId) || '(group)';
        if (cards[id]) { return cards[id]; }
        activate();
        show(groupsSection);

        var card = document.createElement('div');
        card.className = 'card';

        var head = document.createElement('div');
        head.className = 'card-head';
        var idEl = document.createElement('span');
        idEl.className = 'card-id';
        idEl.textContent = id;
        var badge = document.createElement('span');
        badge.className = 'badge running';
        badge.textContent = 'running';
        head.appendChild(idEl);
        head.appendChild(badge);

        var pointEl = document.createElement('div');
        pointEl.className = 'card-point';
        var phaseEl = document.createElement('div');
        phaseEl.className = 'phase';
        var summaryEl = document.createElement('div');
        summaryEl.className = 'summary';
        var metricsEl = document.createElement('div');
        metricsEl.className = 'metrics';
        var errEl = document.createElement('div');
        errEl.className = 'card-err';

        card.appendChild(head);
        card.appendChild(pointEl);
        card.appendChild(phaseEl);
        card.appendChild(summaryEl);
        card.appendChild(metricsEl);
        card.appendChild(errEl);
        groupsEl.appendChild(card);

        var rec = {
          badgeEl: badge, pointEl: pointEl, phaseEl: phaseEl,
          summaryEl: summaryEl, metricsEl: metricsEl, errEl: errEl
        };
        cards[id] = rec;
        return rec;
      }

      function setStatus(rec, status) {
        rec.badgeEl.className = 'badge ' + status;
        rec.badgeEl.textContent = status;
      }

      function metric(parent, label, value) {
        var span = document.createElement('span');
        span.textContent = label + ': ' + value;
        parent.appendChild(span);
      }

      function onGroupStart(groupId, payload) {
        var rec = ensureCard(groupId);
        setStatus(rec, 'running');
        var bits = [];
        if (payload.point !== undefined) { rec.pointEl.textContent = asText(payload.point); }
        if (payload.mode !== undefined) { bits.push('mode ' + asText(payload.mode)); }
        if (payload.kind !== undefined) { bits.push(asText(payload.kind)); }
        rec.phaseEl.textContent = bits.length ? ('starting · ' + bits.join(' · ')) : 'starting';
      }

      function onGroupPhase(groupId, payload) {
        var rec = ensureCard(groupId);
        var parts = [];
        if (payload.phase !== undefined && payload.phase !== null) { parts.push(asText(payload.phase)); }
        if (payload.action !== undefined && payload.action !== null) { parts.push(asText(payload.action)); }
        var line = parts.join(' · ');
        if (payload.description !== undefined && payload.description !== null && asText(payload.description)) {
          line = line ? (line + ' — ' + asText(payload.description)) : asText(payload.description);
        }
        if (line) { rec.phaseEl.textContent = line; }
      }

      function onGroupInterim(groupId, payload) {
        var rec = ensureCard(groupId);
        setStatus(rec, 'done');
        rec.phaseEl.textContent = 'interim · ' + asText(payload.evidenceStatus || 'complete');
        rec.summaryEl.textContent = asText(payload.summary);

        clear(rec.metricsEl);
        metric(rec.metricsEl, 'validated', String(count(payload.validatedKeyPoints)));
        metric(rec.metricsEl, 'candidates', String(count(payload.candidateInsights)));
        var sigma = num(payload.sigmaSi);
        if (sigma !== null) { metric(rec.metricsEl, 'sigma', fmt(sigma)); }
        var composite = num(payload.composite);
        if (composite !== null) { metric(rec.metricsEl, 'composite', fmt(composite)); }
        if (Array.isArray(payload.participation) && payload.participation.length) {
          metric(rec.metricsEl, 'models', payload.participation.map(asText).join(', '));
        }
        if (payload.degraded === true) { metric(rec.metricsEl, 'degraded', 'yes'); }
      }

      function onGroupError(groupId, payload) {
        var rec = ensureCard(groupId);
        setStatus(rec, 'error');
        rec.errEl.textContent = 'error: ' + asText(payload.error);
      }

      // -------------------------------------------------------------- FOOTER section
      function addError(text) {
        activate();
        show(footerSection);
        var row = document.createElement('div');
        row.className = 'err-row';
        row.textContent = text;
        errorsEl.appendChild(row);
      }

      function setBudget(payload) {
        activate();
        show(footerSection);
        show(budgetEl);
        var parts = ['Budget'];
        if (payload.stopped === true) { parts.push('stopped'); }
        if (payload.spent !== undefined) { parts.push('spent ' + asText(payload.spent)); }
        if (payload.reason !== undefined && asText(payload.reason)) { parts.push(asText(payload.reason)); }
        budgetEl.textContent = parts.join(' · ');
      }

      // --------------------------------------------------------- unknown-kind fallback
      function logRow(kind, payload) {
        activate();
        show(logSection);
        var row = document.createElement('div');
        row.className = 'logrow';
        var k = document.createElement('span');
        k.className = 'logkind';
        k.textContent = kind;
        var p = document.createElement('span');
        p.className = 'logpayload';
        p.textContent = asText(payload);
        row.appendChild(k);
        row.appendChild(p);
        logEl.appendChild(row);
      }

      // ---------------------------------------------------------------- dispatch
      window.addEventListener('message', function (e) {
        var m = (e && e.data) || {};
        var method = asText(m.method) || 'event';
        // params = groupEventToDict: { group_id, kind, payload, session_id }.
        var params = (m.params && typeof m.params === 'object') ? m.params : {};
        var kind = asText(params.kind) || method.replace(/^event\\//, '');
        var groupId = params.group_id;
        var payload = (params.payload && typeof params.payload === 'object') ? params.payload : {};

        try {
          switch (kind) {
            case 'decompose.points':
              renderPlan(payload.points, payload.edges);
              break;
            case 'decompose.progress':
              // Quiet by design (stage chatter); surface only injection rejections.
              if (asText(payload.stage) === 'rejected-injection') {
                addError('decompose: rejected injected point');
              }
              break;
            case 'schedule.plan':
              // Plan layers are informative but the Plan section already shows points;
              // skip noisy re-render. (Edges/points already rendered from decompose.)
              break;
            case 'budget':
              setBudget(payload);
              break;
            case 'group.start':
              onGroupStart(groupId, payload);
              break;
            case 'group.phase':
              onGroupPhase(groupId, payload);
              break;
            case 'group.interim':
              onGroupInterim(groupId, payload);
              break;
            case 'group.error':
              onGroupError(groupId, payload);
              addError(asText(groupId) + ': ' + asText(payload.error));
              break;
            case 'aggregate.progress':
              if (asText(payload.stage) === 'done') {
                activate();
                show(footerSection);
                addStatusLine('Aggregated — ' + asText(payload.groups_run) +
                  ' run, ' + asText(payload.groups_failed) + ' failed');
              }
              break;
            default:
              logRow(kind, payload);
          }
        } catch (err) {
          // A malformed event must never break the board.
          logRow(kind, payload);
        }
      });

      // A neutral (non-error) status line in the footer.
      function addStatusLine(text) {
        var row = document.createElement('div');
        row.className = 'budget';
        row.textContent = text;
        errorsEl.appendChild(row);
      }
    })();
  </script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
