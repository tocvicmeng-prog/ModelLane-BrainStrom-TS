import * as vscode from 'vscode';
import { EngineService } from './engineService';
import { SecretsStore } from './secrets';
import { ConnectorRegistry, buildSessionParams, buildExecuteParams } from './connectorRegistry';

/**
 * controller.ts (N17) — drives a brainstorm session from a chat turn.
 *
 * Reads the user's domain from the latest chat message, collects the configured
 * connectors' secrets into the in-memory snapshot the EngineService reads (one-shot,
 * S2), invokes the engine's `runSession` (decompose → schedule → aggregate) directly
 * in-process, streams the live board via the engine's `event/*` notifications (wired in
 * extension.ts via the EngineService emit callback), returns the report to chat, and
 * saves it as Markdown (N22) under globalStorageUri.
 *
 * The multi-turn CONFIRM_PLAN gate (F7) uses a stable cross-turn session identity keyed
 * on the conversation's first user message; the plan is streamed to the board before
 * debates run so the user sees it.
 */
export class BrainstormController {
  private counter = 0;
  // Pending decomposition plans awaiting CONFIRM_PLAN approval, keyed by the
  // conversation's first user message (a pragmatic cross-turn session identity).
  private readonly plans = new Map<string, { domain: string; points: unknown[]; edges: unknown[] }>();
  // The in-process engine (injected after construction so its secretsAccessor can close
  // over this controller's snapshot — see getSecrets / setEngine).
  private engine?: EngineService;
  // In-memory secrets snapshot the EngineService reads via its secretsAccessor. Refreshed
  // (one-shot, S2) from SecretStorage at the start of every run; replaces the former
  // `session.provisionSecrets` handshake to the Python sidecar.
  private currentSecrets: Record<string, string> = {};

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly secrets: SecretsStore,
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) { }

  /** Inject the in-process engine (constructed after the controller so its
   *  secretsAccessor can read this controller's snapshot via getSecrets). */
  setEngine(engine: EngineService): void {
    this.engine = engine;
  }

  /** The in-memory secrets snapshot for the EngineService's secretsAccessor (S2). */
  getSecrets(): Record<string, string> {
    return this.currentSecrets;
  }

  async run(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const latest = this.latestUserText(messages).trim();
    if (!latest) {
      progress.report(new vscode.LanguageModelTextPart('Tell me the domain, question, or area you want to brainstorm.'));
      return;
    }
    const cfg = this.registry.getConfig();
    if (!cfg.connectors.length) {
      progress.report(new vscode.LanguageModelTextPart('No debate connectors are configured. Run **BrainStrom: Configure** first.'));
      return;
    }
    if (!this.engine) {
      progress.report(new vscode.LanguageModelTextPart('The BrainStrom engine is not initialized.'));
      return;
    }
    const engine = this.engine;
    const conf = vscode.workspace.getConfiguration('brainstrom');
    const allowRemote = conf.get<boolean>('allowRemote', false);
    const autoConfirm = conf.get<boolean>('autoConfirmPlan', false);
    const sessionKey = (this.firstUserText(messages) || latest).trim();

    try {
      // Collect secrets into the in-memory snapshot the engine reads (one-shot, S2) —
      // the in-process replacement for the former `session.provisionSecrets` handshake.
      this.currentSecrets = await this.secrets.collect(cfg.connectors.map(c => c.id));
      const sessionId = `s-${Date.now()}-${this.counter++}`;

      // Single-turn mode (opt-in): decompose + debate immediately.
      if (autoConfirm) {
        progress.report(new vscode.LanguageModelTextPart(
          `🧠 Brainstorming **${latest}** (mode: ${cfg.mode}) — decomposing and running debates. ` +
          'Watch the **BrainStrom** view for live progress.\n\n'));
        const r = await engine.runSession(buildSessionParams(latest, cfg, sessionId, allowRemote));
        await this.finish(r, latest, progress, token);
        return;
      }

      // Two-turn CONFIRM_PLAN gate — execute a pending, approved plan...
      const stored = this.plans.get(sessionKey);
      if (stored && this.isApproval(latest)) {
        progress.report(new vscode.LanguageModelTextPart(
          `✅ Approved — running ${stored.points.length} debate group(s) for **${stored.domain}**. ` +
          'Watch the **BrainStrom** view.\n\n'));
        const r = await engine.executePlan(
          buildExecuteParams(stored.domain, cfg, sessionId, allowRemote, stored.points, stored.edges));
        this.plans.delete(sessionKey);
        await this.finish(r, stored.domain, progress, token);
        return;
      }

      // ...otherwise treat the message as the (possibly refined) domain and propose a plan.
      const domain = latest;
      progress.report(new vscode.LanguageModelTextPart(
        `🧠 Decomposing **${domain}** into debatable knowledge points — watch the **BrainStrom** view.\n\n`));
      const plan = await engine.decompose(buildSessionParams(domain, cfg, sessionId, allowRemote)) as
        { points?: any[]; edges?: any[]; problems?: string[] } | undefined;
      if (token.isCancellationRequested) return;
      const problems = plan?.problems ?? [];
      const points = plan?.points ?? [];
      if (problems.length || points.length < 2) {
        progress.report(new vscode.LanguageModelTextPart(
          `I couldn't form a debatable plan for **${domain}**` +
          (problems.length ? `: ${problems.join('; ')}` : '.') +
          ' Try a broader or more specific topic.'));
        return;
      }
      this.plans.set(sessionKey, { domain, points, edges: plan?.edges ?? [] });
      progress.report(new vscode.LanguageModelTextPart(
        this.formatPlan(domain, points, plan?.edges ?? []) +
        '\n\nReply **go** to run the debates, or send a refined topic to re-plan.'));
    } catch (err: any) {
      progress.report(new vscode.LanguageModelTextPart(
        `BrainStrom error: ${err?.message ?? err}. Check the ModelLane-BrainStrom output channel, ` +
        'and confirm your model endpoints are reachable.'));
    }
  }

  private async finish(
    result: unknown,
    domain: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) return;
    const r = result as { markdown?: string; error?: string; problems?: string[] } | undefined;
    if (r && r.error) {
      progress.report(new vscode.LanguageModelTextPart(
        `Brainstorm could not complete: ${r.error}. ${(r.problems ?? []).join('; ')}`));
      return;
    }
    const markdown = r && r.markdown ? String(r.markdown) : '_(no report produced)_';
    const saved = await this.saveReport(markdown, domain);
    progress.report(new vscode.LanguageModelTextPart(markdown + (saved ? `\n\n_Report saved to ${saved}_` : '')));
  }

  private isApproval(text: string): boolean {
    return /^(go|run|proceed|yes|confirm|start|approve|ok|do it|let'?s go|lgtm)\b/i.test(text.trim());
  }

  private formatPlan(domain: string, points: any[], edges: any[]): string {
    const lines = [`**Proposed brainstorm plan for "${domain}"** — ${points.length} knowledge points:`];
    for (const p of points) lines.push(`- \`${p.id}\` [${p.kind}] ${p.text}`);
    if (edges && edges.length) {
      lines.push('', '_Dependencies (debated in order):_');
      for (const e of edges) lines.push(`- ${e.src} → ${e.dst} (${e.kind})`);
    }
    return lines.join('\n');
  }

  private firstUserText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    for (const m of messages) {
      if (m.role === vscode.LanguageModelChatMessageRole.User) {
        return m.content
          .map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
          .join(' ')
          .trim();
      }
    }
    return '';
  }

  private latestUserText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === vscode.LanguageModelChatMessageRole.User) {
        return m.content
          .map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
          .join(' ')
          .trim();
      }
    }
    return '';
  }

  private async saveReport(markdown: string, domain: string): Promise<string | undefined> {
    try {
      const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'reports');
      await vscode.workspace.fs.createDirectory(dir);
      const slug = domain.replace(/[^a-z0-9]+/gi, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'brainstorm';
      const file = vscode.Uri.joinPath(dir, `${slug}-${Date.now()}.md`);
      await vscode.workspace.fs.writeFile(file, Buffer.from(markdown, 'utf8'));
      return file.fsPath;
    } catch (e) {
      this.log.appendLine(`[report] save failed: ${e}`);
      return undefined;
    }
  }
}
