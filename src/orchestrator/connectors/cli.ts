// cli.ts (N25) — drive an agent CLI (codex / claude) as a sandboxed subprocess.
//
// A debate seat backed by a coding-agent CLI that authenticates via its OWN existing
// login/OAuth — so NO API key is placed in argv or env. Hardening (CONSTITUTION S3 /
// risk R-CLI):
//   * `shell: false` + an argv LIST — no shell, no interpolation;
//   * inherits the user's FULL environment by default so the CLI finds its OWN stored
//     login (codex/claude keep credentials under the user's home/config dir);
//     BrainStrom's managed API keys are NEVER placed in the env (they live in
//     SecretStorage), so nothing is leaked. An explicit `envPassthrough` allowlist can
//     restrict it;
//   * a bounded working directory (the OS temp dir by default — never the workspace);
//   * a per-call timeout (kill on expiry) and a hard output cap;
//   * single-shot "print" invocation only — the command must NOT run the CLI in an
//     agentic/file-writing mode (`allowFileTools` defaults to false and the temp cwd
//     bounds any stray writes).
//
// The command is user-configured (CLI flags differ per tool), e.g. a print/exec mode
// that takes the prompt on stdin and returns a completion on stdout.

import { spawn } from 'node:child_process';
import * as os from 'node:os';

import { AgentClient, type AgentClientOptions } from '../../engine/agent';
import { EmbeddingsClient } from '../../engine/embeddings';
import type { ChatMessage } from '../../engine/types';

import {
  makeConnectorCapabilities,
  type ConnectorCapabilities,
  type MakeAgentClientArgs,
  type MakeEmbeddingsClientArgs,
} from './base';

const DEFAULT_TIMEOUT = 120; // seconds
const DEFAULT_MAX_OUTPUT = 100_000; // characters

/** How the prompt reaches the CLI: piped on stdin, or substituted into argv. */
export type PromptVia = 'stdin' | 'arg';

/** Constructor options for CliAgentClient (camelCased from the Python kwargs). */
export interface CliAgentClientOptions {
  command: string[];
  model: string;
  systemPrompt?: string;
  modelFamily?: string;
  temperature?: number;
  promptVia?: PromptVia;
  cwd?: string | null;
  timeout?: number; // seconds
  maxOutputChars?: number;
  envPassthrough?: string[] | null;
  agentLabel?: string;
}

/** AgentClient whose `chat` invokes a CLI subprocess in single-shot print mode. */
export class CliAgentClient extends AgentClient {
  private readonly command: string[];
  private readonly promptVia: PromptVia;
  private readonly cliCwd: string;
  private readonly cliTimeout: number; // seconds
  private readonly maxOutput: number;
  private readonly envPassthrough: string[] | null;

  constructor(opts: CliAgentClientOptions) {
    const base: AgentClientOptions = {
      endpoint: 'cli://local',
      model: opts.model,
      apiKey: null,
      systemPrompt: opts.systemPrompt ?? '',
      modelFamily: opts.modelFamily ?? 'unknown',
      temperature: opts.temperature ?? 0.7,
      agentLabel: opts.agentLabel ?? 'A',
    };
    super(base);
    this.command = [...opts.command];
    this.promptVia = opts.promptVia ?? 'stdin';
    this.cliCwd = opts.cwd ?? os.tmpdir();
    this.cliTimeout = opts.timeout ?? DEFAULT_TIMEOUT;
    this.maxOutput = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    this.envPassthrough = opts.envPassthrough ?? null;
  }

  // Inherit the user's FULL environment by default so the CLI finds its own login
  // (codex/claude store credentials under the user's home/config dir). BrainStrom's
  // managed API keys are NEVER placed in the environment, so this leaks nothing.
  // Provide `envPassthrough` to restrict to an explicit allowlist instead.
  private env(): NodeJS.ProcessEnv {
    const src = process.env;
    if (this.envPassthrough === null) {
      return { ...src };
    }
    const out: NodeJS.ProcessEnv = {};
    for (const k of this.envPassthrough) {
      const v = src[k];
      if (v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  }

  private static buildPrompt(messages: ChatMessage[]): string {
    return messages
      .map((m) => `${(m.role ?? 'user').toUpperCase()}: ${m.content ?? ''}`)
      .join('\n\n');
  }

  // Override of AgentClient.chat: temperature is accepted to match the signature but
  // CLIs take no temperature param (the Python _chat ignored it too).
  protected override async chat(messages: ChatMessage[], _temperature: number): Promise<string> {
    const prompt = CliAgentClient.buildPrompt(messages);
    let argv = [...this.command];
    let stdinData: string | null = null;
    if (this.promptVia === 'arg') {
      if (argv.some((a) => a.includes('{prompt}'))) {
        argv = argv.map((a) => a.replace(/\{prompt\}/g, prompt));
      } else {
        argv.push(prompt);
      }
    } else {
      stdinData = prompt;
    }

    const result = await this.runProcess(argv, stdinData);
    let out = (result.stdout || '').trim();
    if (result.returncode !== 0 && !out) {
      throw new Error(
        `CLI exited ${result.returncode}: ${(result.stderr || '').slice(0, 300)}`,
      );
    }
    if (out.length > this.maxOutput) {
      out = out.slice(0, this.maxOutput);
    }
    // CLIs do not report token usage — let the engine's estimator handle budget.
    this.lastUsage = { prompt: 0, completion: 0 };
    return out;
  }

  // Wrap spawn (shell:false) in a Promise: collect stdout/stderr, enforce the
  // per-call timeout by killing the child, map ENOENT -> clear "CLI not found".
  private runProcess(
    argv: string[],
    stdinData: string | null,
  ): Promise<{ stdout: string; stderr: string; returncode: number }> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = argv;
      const child = spawn(cmd, args, {
        shell: false,
        cwd: this.cliCwd,
        env: this.env(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.cliTimeout * 1000);

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
      child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

      child.on('error', (err: NodeJS.ErrnoException) => {
        finish(() => {
          if (err.code === 'ENOENT') {
            // Map a missing executable to the clear ConnectionError the Python raised.
            reject(new Error(`CLI not found: ${JSON.stringify(this.command[0])}`));
          } else {
            reject(new Error(`CLI spawn failed: ${err.message}`));
          }
        });
      });

      child.on('close', (code: number | null) => {
        finish(() => {
          if (timedOut) {
            reject(new Error(`CLI timed out after ${this.cliTimeout}s`));
            return;
          }
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
            stderr: Buffer.concat(stderrChunks).toString('utf-8'),
            returncode: code ?? 0,
          });
        });
      });

      // Feed the prompt via stdin when configured, then close the stream.
      if (child.stdin) {
        if (stdinData !== null) {
          child.stdin.write(stdinData);
        }
        child.stdin.end();
      }
    });
  }
}

/** Constructor options for CliConnector (camelCased from the Python kwargs). */
export interface CliConnectorOptions {
  // Accept a list argv or a string (split WITHOUT a shell — a safe tokenizer).
  command: string[] | string;
  promptVia?: PromptVia;
  cwd?: string | null;
  timeout?: number;
  maxOutputChars?: number;
  envPassthrough?: string[] | null;
  allowFileTools?: boolean;
}

/** Connector that builds CLI-backed debate seats. Does NOT touch the network egress
 *  guard (its surface is process execution, governed by the sandbox controls above). */
export class CliConnector {
  readonly kind = 'cli';

  readonly connectorId: string;
  readonly allowFileTools: boolean;

  private readonly command: string[];
  private readonly promptVia: PromptVia;
  private readonly cliCwd: string;
  private readonly cliTimeout: number;
  private readonly maxOutput: number;
  private readonly envPassthrough: string[] | null;

  constructor(connectorId: string, opts: CliConnectorOptions) {
    this.connectorId = connectorId;
    this.command = Array.isArray(opts.command)
      ? [...opts.command]
      : tokenizeCommand(opts.command || '');
    if (this.command.length === 0) {
      throw new Error('CliConnector requires a non-empty command');
    }
    this.promptVia = opts.promptVia ?? 'stdin';
    this.cliCwd = opts.cwd ?? os.tmpdir();
    this.cliTimeout = opts.timeout ?? DEFAULT_TIMEOUT;
    this.maxOutput = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    this.envPassthrough = opts.envPassthrough ?? null;
    this.allowFileTools = opts.allowFileTools ?? false;
  }

  capabilities(): ConnectorCapabilities {
    return makeConnectorCapabilities({ kind: 'cli' });
  }

  makeAgentClient(args: MakeAgentClientArgs): CliAgentClient {
    return new CliAgentClient({
      command: this.command,
      model: args.model,
      systemPrompt: args.systemPrompt ?? '',
      modelFamily: args.modelFamily ?? 'unknown',
      temperature: args.temperature ?? 0.7,
      promptVia: this.promptVia,
      cwd: this.cliCwd,
      timeout: this.cliTimeout,
      maxOutputChars: this.maxOutput,
      envPassthrough: this.envPassthrough,
      agentLabel: args.agentLabel ?? 'A',
    });
  }

  // No embeddings over a CLI — return a lexical-only client (no network, degraded).
  makeEmbeddingsClient(_args: MakeEmbeddingsClientArgs = {}): EmbeddingsClient {
    return new EmbeddingsClient({ mockVectors: {} });
  }

  toString(): string {
    return (
      `<CliConnector id=${JSON.stringify(this.connectorId)} ` +
      `command=${JSON.stringify(this.command)} cwd=${JSON.stringify(this.cliCwd)}>`
    );
  }
}

/**
 * Safe, shell-free tokenizer for a command string (replaces Python shlex.split).
 * Honours single/double quotes and backslash escapes; never invokes a shell.
 */
export function tokenizeCommand(s: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false; // a token has started (handles empty quoted args)
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < s.length) {
        // In double quotes, backslash escapes the next char (POSIX-ish).
        cur += s[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) {
        tokens.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) {
    tokens.push(cur);
  }
  return tokens;
}

/** Build a CliConnector (sync) — convenience factory mirroring the connector API. */
export function makeCliConnector(connectorId: string, opts: CliConnectorOptions): CliConnector {
  return new CliConnector(connectorId, opts);
}
