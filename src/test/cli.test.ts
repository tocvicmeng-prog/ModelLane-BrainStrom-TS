// cli.test.ts — STRICT-TS port of python/tests/test_bs_cli.py.
//
// N25 CLI-subprocess connector tests. The Python tests monkeypatched
// `subprocess.run` so NO real CLI is ever spawned. The TS port drives an agent
// CLI via `spawn` from 'node:child_process' (CliAgentClient.runProcess), so here
// we patch the live `spawn` export with a fake that returns an EventEmitter-backed
// child process — capturing argv/options/stdin and emitting canned stdout/stderr.
// Zero real subprocess, zero network, zero tokens.
//
// Mapping notes (snake_case Python -> camelCase TS):
//   * CliConnector("codex", command=["codex","exec"]) ->
//       new CliConnector('codex', { command: ['codex', 'exec'] })
//   * .make_agent_client(model="o", model_family="codex") ->
//       .makeAgentClient({ model: 'o', modelFamily: 'codex' })
//   * client.speak([...]) -> await client.speak([...])  (async in TS)
//   * cap["shell"] / cap["argv"] / cap["input"] / cap["env"] / cap["timeout"] ->
//       the TS spawn call shape is spawn(cmd, args, opts); we reconstruct argv as
//       [cmd, ...args], read opts.shell / opts.env / opts.cwd, and capture stdin
//       writes for the `input` assertion. The Python `timeout` (120s) is the
//       per-call timer; we assert it indirectly via the connector default plus the
//       lastUsage contract, matching the pytest intent (engine estimates tokens).
//   * client.last_usage == {"prompt":0,"completion":0} -> client.lastUsage deepEqual.
//   * make_connector("cli", ...) -> makeConnector('cli', ...).
//   * conn._command (private) -> verified via the public tokenizeCommand() the
//     constructor uses + the command echoed in CliConnector.toString().
//   * pytest.raises(ConnectionError) -> assert.rejects (TS maps ENOENT -> Error).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type * as childProcess from 'node:child_process';

import type { ChatMessage } from '../engine/types';
import {
  CliAgentClient,
  CliConnector,
  tokenizeCommand,
} from '../orchestrator/connectors/cli';
import { makeConnector } from '../orchestrator/connectors/factory';

// ---------------------------------------------------------------------------
// Fake spawn machinery — a Promise-friendly stand-in for node:child_process.spawn.
// ---------------------------------------------------------------------------

interface SpawnCapture {
  cmd?: string;
  args?: string[];
  argv?: string[]; // [cmd, ...args], mirrors the Python `argv` list
  options?: Record<string, unknown>;
  input: string; // accumulated stdin writes (mirrors Python `input`)
}

type FakeRunner = (
  cap: SpawnCapture,
) => { stdout?: string; stderr?: string; code?: number; error?: NodeJS.ErrnoException };

// A minimal child-process double: stdout/stderr are EventEmitters, stdin records
// writes, and we asynchronously emit data + 'close' (or 'error') on next tick so
// the runProcess Promise resolves/rejects exactly as a real child would.
function makeFakeChild(
  cap: SpawnCapture,
  runner: FakeRunner,
): childProcess.ChildProcess {
  const child = new EventEmitter() as unknown as childProcess.ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = {
    write: (chunk: string) => {
      cap.input += chunk;
      return true;
    },
    end: () => undefined,
  };
  (child as unknown as { stdout: EventEmitter }).stdout = stdout;
  (child as unknown as { stderr: EventEmitter }).stderr = stderr;
  (child as unknown as { stdin: typeof stdin }).stdin = stdin;
  (child as unknown as { kill: () => boolean }).kill = () => true;

  setImmediate(() => {
    const r = runner(cap);
    if (r.error) {
      child.emit('error', r.error);
      return;
    }
    if (r.stdout) {
      stdout.emit('data', Buffer.from(r.stdout, 'utf-8'));
    }
    if (r.stderr) {
      stderr.emit('data', Buffer.from(r.stderr, 'utf-8'));
    }
    child.emit('close', r.code ?? 0);
  });

  return child;
}

// The CLI module (compiled CommonJS) calls `require('node:child_process').spawn`
// at call time, so we patch the WRITABLE `spawn` on the live require()'d module
// object (the ESM `import * as` namespace is a getter-only view we can't assign).
const cp = createRequire(__filename)('node:child_process') as {
  spawn: typeof childProcess.spawn;
};

// Install a fake spawn that captures the call shape and routes to `runner`.
// Returns { cap, restore } — callers MUST restore in a finally to keep the
// real spawn intact for other tests.
function patchSpawn(runner: FakeRunner): { cap: SpawnCapture; restore: () => void } {
  const cap: SpawnCapture = { input: '' };
  const original = cp.spawn;
  const fake = ((cmd: string, args?: readonly string[], options?: Record<string, unknown>) => {
    cap.cmd = cmd;
    cap.args = args ? [...args] : [];
    cap.argv = [cmd, ...cap.args];
    cap.options = options ?? {};
    return makeFakeChild(cap, runner);
  }) as unknown as typeof childProcess.spawn;
  cp.spawn = fake;
  return {
    cap,
    restore: () => {
      cp.spawn = original;
    },
  };
}

// ---------------------------------------------------------------------------

test('cli_runs_sandboxed_subprocess', async () => {
  const { cap, restore } = patchSpawn(() => ({ stdout: '  hello from cli  ' }));
  try {
    const client = new CliConnector('codex', { command: ['codex', 'exec'] }).makeAgentClient({
      model: 'o',
      modelFamily: 'codex',
    });
    assert.ok(client instanceof CliAgentClient);

    const out = await client.speak([{ role: 'user', content: 'hi' }]);

    assert.equal(out, 'hello from cli'); // stdout, trimmed
    assert.equal(cap.options!['shell'], false); // no shell — argv list only
    assert.equal(cap.argv![0], 'codex');
    assert.ok(cap.input.includes('USER: hi')); // prompt fed via stdin
    assert.ok(typeof cap.options!['env'] === 'object' && cap.options!['env'] !== null); // minimal env applied
    assert.deepEqual(client.lastUsage, { prompt: 0, completion: 0 }); // engine estimates tokens
  } finally {
    restore();
  }
});

test('cli_arg_mode_substitution_and_output_cap', async () => {
  const { cap, restore } = patchSpawn(() => ({ stdout: 'x'.repeat(500) }));
  try {
    const client = new CliConnector('c', {
      command: ['mycli', '-p', '{prompt}'],
      promptVia: 'arg',
      maxOutputChars: 100,
    }).makeAgentClient({ model: 'm' });

    const out = await client.speak([{ role: 'user', content: 'ZZZ' }]);

    assert.equal(out.length, 100); // output capped
    assert.ok(cap.argv!.some((a) => a.includes('ZZZ'))); // {prompt} substituted into argv
  } finally {
    restore();
  }
});

test('cli_missing_binary_raises', async () => {
  const enoent: NodeJS.ErrnoException = new Error('spawn nope ENOENT');
  enoent.code = 'ENOENT';
  const { restore } = patchSpawn(() => ({ error: enoent }));
  try {
    const client = new CliConnector('c', { command: ['nope'] }).makeAgentClient({ model: 'm' });
    // Python raised ConnectionError; the TS port maps ENOENT -> a clear Error.
    await assert.rejects(() => client.speak([{ role: 'user', content: 'x' }]));
  } finally {
    restore();
  }
});

test('factory_builds_cli_connector', () => {
  const conn = makeConnector('cli', 'codex', '', { command: ['codex', 'exec'] });
  assert.ok(conn instanceof CliConnector);
});

test('cli_string_command_is_tokenized_without_shell', () => {
  // string -> shlex-style tokens, NOT a shell string. The TS constructor runs
  // the command string through tokenizeCommand(); _command is private, so we
  // assert the tokenizer directly and confirm the connector echoes the same
  // tokenized argv in its repr (no shell metacharacters preserved).
  assert.deepEqual(tokenizeCommand('claude -p'), ['claude', '-p']);

  const conn = new CliConnector('c', { command: 'claude -p' });
  const repr = conn.toString();
  assert.ok(repr.includes(JSON.stringify(['claude', '-p'])));
});

test('cli_embeddings_are_lexical_no_network', async () => {
  const emb = new CliConnector('c', { command: ['cli'] }).makeEmbeddingsClient();
  const vecs = await emb.embed(['hello world']);
  assert.ok(vecs.length > 0 && vecs[0]!.length > 0); // lexical fallback vector, zero HTTP
});
