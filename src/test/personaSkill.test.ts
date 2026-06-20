// Persona + skill-file composition (admin-console UX upgrade).
// composePersona / formatSkill fold an uploaded skill file into a seat's system prompt;
// buildSessionParams must emit the combined persona for seats AND panel debaters.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  composePersona,
  formatSkill,
  buildSessionParams,
  defaultConfig,
  SeatDef,
} from '../brainstorm/connectorRegistry';

test('composePersona returns trimmed persona text when no skill is attached', () => {
  assert.equal(composePersona({ connectorId: 'c', model: 'm', family: 'f', persona: '  hello  ' }), 'hello');
  assert.equal(composePersona({ connectorId: 'c', model: 'm', family: 'f' }), '');
});

test('composePersona uses the skill block when there is no typed persona', () => {
  const s: SeatDef = { connectorId: 'c', model: 'm', family: 'f', skill: { name: 'k.md', content: 'Body line.' } };
  const out = composePersona(s);
  assert.match(out, /## Loaded skill: k\.md/);
  assert.match(out, /Body line\./);
});

test('composePersona combines typed persona + skill (typed text first)', () => {
  const s: SeatDef = {
    connectorId: 'c', model: 'm', family: 'f',
    persona: 'You are A.', skill: { name: 'k.md', content: 'Use first principles.' },
  };
  const out = composePersona(s);
  assert.ok(out.startsWith('You are A.'));
  assert.match(out, /## Loaded skill: k\.md/);
  assert.match(out, /Use first principles\./);
});

test('composePersona ignores empty / whitespace-only skill content', () => {
  const s: SeatDef = { connectorId: 'c', model: 'm', family: 'f', persona: 'P', skill: { name: 'k.md', content: '   ' } };
  assert.equal(composePersona(s), 'P');
});

test('formatSkill renders simple front-matter as directives, then the body', () => {
  const content = ['---', 'search_preference: academic', 'reasoning: first-principles', '---', 'Debate carefully and cite sources.'].join('\n');
  const out = formatSkill('researcher.md', content);
  assert.match(out, /## Loaded skill: researcher\.md/);
  assert.match(out, /Operating directives:/);
  assert.match(out, /- search preference: academic/); // humanizeKey: '_' -> ' '
  assert.match(out, /- reasoning: first-principles/);
  assert.match(out, /Debate carefully and cite sources\./);
});

test('formatSkill with no front-matter uses the raw body', () => {
  const out = formatSkill('plain.txt', 'Just instructions.');
  assert.match(out, /## Loaded skill: plain\.txt/);
  assert.match(out, /Just instructions\./);
  assert.ok(!/Operating directives/.test(out));
});

test('buildSessionParams composes a seat persona + skill into the persona param', () => {
  const cfg = defaultConfig();
  cfg.seats.agent_a = {
    connectorId: 'local', model: 'm', family: 'debater-a',
    persona: 'You are A.', skill: { name: 'k.md', content: 'Use analogy.' },
  };
  const params = buildSessionParams('topic', cfg, 'sid', false) as any;
  const personaA: string = params.role_map.agent_a.persona;
  assert.ok(personaA.startsWith('You are A.'));
  assert.match(personaA, /Use analogy\./);
});

test('buildSessionParams carries persona + skill for panel debaters', () => {
  const cfg = defaultConfig();
  cfg.seats.debaters = [
    { connectorId: 'local', model: 'm', family: 'd1', persona: 'D1', skill: { name: 's1.md', content: 'Reverse thinking.' } },
    { connectorId: 'local', model: 'm', family: 'd2' },
  ];
  const params = buildSessionParams('topic', cfg, 'sid', false) as any;
  assert.equal(params.role_map.debaters.length, 2);
  assert.match(params.role_map.debaters[0].persona, /D1/);
  assert.match(params.role_map.debaters[0].persona, /Reverse thinking\./);
});
