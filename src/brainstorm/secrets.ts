import * as vscode from 'vscode';

/**
 * secrets.ts (N13) — the single source of truth for connector API keys.
 *
 * Keys live ONLY in VS Code SecretStorage (OS keychain), addressed by an opaque
 * connector id — never in settings.json, logs, the sidecar argv/env, reports, or
 * exports (CONSTITUTION S1). The connector catalog (connectorRegistry) holds the
 * non-secret config; this store holds the secret values and hands them to the
 * sidecar only over the one-shot provisioning handshake (S2).
 */
const PREFIX = 'brainstrom.connector.';

export class SecretsStore {
  constructor(private readonly secrets: vscode.SecretStorage) { }

  private key(connectorId: string): string {
    return `${PREFIX}${connectorId}`;
  }

  async setKey(connectorId: string, value: string): Promise<void> {
    await this.secrets.store(this.key(connectorId), value);
  }

  async getKey(connectorId: string): Promise<string | undefined> {
    return this.secrets.get(this.key(connectorId));
  }

  async deleteKey(connectorId: string): Promise<void> {
    await this.secrets.delete(this.key(connectorId));
  }

  async hasKey(connectorId: string): Promise<boolean> {
    return (await this.getKey(connectorId)) !== undefined;
  }

  /** Collect secrets for the given connector ids (for the one-shot provisioning call). */
  async collect(connectorIds: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const id of connectorIds) {
      const v = await this.getKey(id);
      if (v !== undefined) out[id] = v;
    }
    return out;
  }
}
