// node --test. Fake provider and fake compactor only: nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectCutPoints, normaliseTarget, sameTarget, scoreAction, parseAction,
  runFidelity, aggregate, buildMarkdown, fakeCompactor, main, planFor,
} from '../fidelity.mjs';
import { fakeProvider } from '../providers.mjs';

const FIXTURE = new URL('./fixtures/todo-cli-messages.json', import.meta.url).pathname;
const messages = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// ---- cut-point selection

test('cut points are real user instructions followed by an assistant tool call', () => {
  const { cuts, candidates, tooEarly } = selectCutPoints(messages, { cuts: 99 });
  assert.equal(candidates, 6);
  assert.equal(tooEarly, 1); // K=0 has no prefix worth compacting
  assert.deepEqual(cuts.map((c) => c.index), [9, 18, 23, 27, 32]);
  for (const c of cuts) {
    assert.equal(messages[c.index].role, 'user');
    assert.ok(messages[c.index].text.length > 0);
    assert.equal(c.truth.tool, messages[c.actionIndex].toolUses[0].tool);
  }
  assert.equal(cuts[0].truth.tool, 'Write');
});

test('tool results and injected user text are not cut points', () => {
  const msgs = [
    { role: 'user', text: '<local-command-stdout>x</local-command-stdout>', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'ok' }] },
    { role: 'user', text: 'real instruction', toolUses: [] },
    { role: 'assistant', text: 'no tool here', toolUses: [] },
  ];
  assert.equal(selectCutPoints(msgs, { minPrefix: 0 }).cuts.length, 0);
});

test('an action more than 3 messages after the instruction does not count', () => {
  const idle = { role: 'assistant', text: 'thinking', toolUses: [] };
  const act = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'ls' } }] };
  const u = { role: 'user', text: 'do it', toolUses: [] };
  assert.equal(selectCutPoints([u, idle, idle, act], { minPrefix: 0 }).cuts.length, 1); // action at +3
  assert.equal(selectCutPoints([u, idle, idle, idle, act], { minPrefix: 0 }).cuts.length, 0); // at +4
});

test('cut points are spread across the session, not clustered', () => {
  const msgs = [];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: 'user', text: `step ${i}`, toolUses: [] });
    msgs.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `echo ${i}` } }] });
  }
  const { cuts } = selectCutPoints(msgs, { cuts: 4, minPrefix: 0 });
  const idx = cuts.map((c) => c.index);
  assert.equal(idx.length, 4);
  assert.ok(idx[0] < 20 && idx[3] > 60, `expected spread over 0..78, got ${idx}`);
  assert.ok(idx.every((k, i) => i === 0 || k - idx[i - 1] >= 15), `clustered: ${idx}`);
});

// ---- target normalisation

test('paths normalise and relative paths match absolute ones', () => {
  const a = normaliseTarget('Read', { file_path: './src//a.mjs' });
  const b = normaliseTarget('Read', { file_path: '/home/x/proj/src/a.mjs' });
  assert.deepEqual(a, { kind: 'path', value: 'src/a.mjs' });
  assert.ok(sameTarget(a, b));
  assert.ok(!sameTarget(a, normaliseTarget('Read', { file_path: '/home/x/proj/lib/a.mjs' })));
  assert.ok(!sameTarget(normaliseTarget('Read', { file_path: 'b.mjs' }), normaliseTarget('Read', { file_path: 'ab.mjs' })));
});

test('commands reduce to program plus first non-flag argument', () => {
  const t = (command) => normaliseTarget('Bash', { command }).value;
  assert.equal(t('git status'), 'git status');
  assert.equal(t('  git   status  --short '), 'git status');
  assert.equal(t('cd /work/todo && node --test test/'), 'node test');
  assert.equal(t('FOO=1 /usr/bin/npm run lint | tail -5'), 'npm run');
  assert.equal(t('cat "src/a.mjs"'), 'cat src/a.mjs');
  assert.notEqual(t('cat src/a.mjs'), t('cat src/b.mjs'));
});

test('tools without a target only match each other', () => {
  assert.equal(normaliseTarget('TodoWrite', { todos: [] }), null);
  assert.ok(sameTarget(null, null));
  assert.ok(!sameTarget(null, { kind: 'path', value: 'a' }));
});

// ---- scoring bands

test('scoring bands: 1.0 same tool and target, 0.5 same tool, 0.0 otherwise', () => {
  const truth = { tool: 'Read', input: { file_path: '/p/src/a.mjs' } };
  assert.equal(scoreAction(truth, { tool: 'Read', input: { file_path: 'src/a.mjs' } }), 1);
  assert.equal(scoreAction(truth, { tool: 'Read', input: { file_path: 'src/b.mjs' } }), 0.5);
  assert.equal(scoreAction(truth, { tool: 'Edit', input: { file_path: 'src/a.mjs' } }), 0);
  assert.equal(scoreAction(truth, null), 0);
  assert.equal(scoreAction({ tool: 'Bash', input: { command: 'git status' } }, { tool: 'Bash', input: { command: 'git diff' } }), 0.5);
});

// ---- parsing and unparsed handling

test('parseAction accepts bare, fenced and preamble JSON, and rejects prose', () => {
  const want = { tool: 'Bash', input: { command: 'ls' } };
  assert.deepEqual(parseAction('{"tool":"Bash","input":{"command":"ls"}}'), want);
  assert.deepEqual(parseAction('```json\n{"tool":"Bash","input":{"command":"ls"}}\n```'), want);
  assert.deepEqual(parseAction('Sure! {"tool":"Bash","input":{"command":"echo }"}} done'), { tool: 'Bash', input: { command: 'echo }' } });
  assert.equal(parseAction('I would run ls'), null);
  assert.equal(parseAction('{"input":{}}'), null);
  assert.equal(parseAction(''), null);
});

// Answers by call order per cut point: baseline first, then one per threshold.
function scripted(answers) {
  return fakeProvider((_s, _c, _i, n) => answers[(n - 1) % answers.length]);
}
const truthOf = (cut) => JSON.stringify({ tool: cut.truth.tool, input: cut.truth.input });

test('unparsed answers are recorded with raw text, flagged, and never dropped', async () => {
  const { cuts } = selectCutPoints(messages, { cuts: 1 });
  const provider = scripted([truthOf(cuts[0]), 'no idea, sorry', truthOf(cuts[0])]);
  const results = await runFidelity({ messages, cuts, thresholds: [0.1, 0.3], provider, compactor: fakeCompactor() });
  const [r] = results;
  assert.equal(r.status, 'scored');
  const bad = r.conditions[0];
  assert.equal(bad.unparsed, true);
  assert.equal(bad.parsed, null);
  assert.equal(bad.raw, 'no idea, sorry');
  assert.equal(bad.score, 0);
  const agg = aggregate(results, [0.1, 0.3]);
  assert.equal(agg[0].unparsed, 1);
  assert.equal(agg[1].unparsed, 0);
  assert.equal(agg[0].n, 1); // still counted, not skipped
});

test('a provider failure is an error with no score, not a zero', async () => {
  const { cuts } = selectCutPoints(messages, { cuts: 1 });
  let n = 0;
  const provider = { name: 'fake', calls: 0, async respond() { this.calls++; if (++n === 2) throw new Error('boom'); return truthOf(cuts[0]); } };
  const results = await runFidelity({ messages, cuts, thresholds: [0.1, 0.3], provider, compactor: fakeCompactor() });
  const [c1, c2] = results[0].conditions;
  assert.equal(c1.score, null);
  assert.equal(c1.error, 'boom');
  assert.equal(c2.score, 1);
  const agg = aggregate(results, [0.1, 0.3]);
  assert.equal(agg[0].errors, 1);
  assert.equal(agg[0].n, 0);
  assert.equal(agg[0].meanAgreement, null);
});

// ---- baseline handling and reporting

test('a baseline miss excludes the cut point, skips its compacted runs, and is counted', async () => {
  const { cuts } = selectCutPoints(messages, { cuts: 2 });
  // wrong tool for the first cut's baseline; then the second cut answers correctly throughout
  const provider = fakeProvider((_s, _c, _i, n) => (n === 1 ? '{"tool":"Glob","input":{"pattern":"*"}}' : truthOf(cuts[1])));
  const results = await runFidelity({ messages, cuts, thresholds: [0.15, 0.3], provider, compactor: fakeCompactor() });
  assert.equal(results[0].status, 'baseline_miss');
  assert.equal(results[0].conditions.length, 0);
  assert.equal(results[1].status, 'scored');
  assert.equal(provider.calls, 1 + 3);
  const md = buildMarkdown({ date: 'd', provider: 'fake', modelCalls: 4, jevRequests: 0, candidates: 6, tooEarly: 1 }, results, [0.15, 0.3]);
  assert.match(md, /Baseline miss rate: 1 of 2 cut points \(50\.0%\)/);
  assert.match(md, /Excluded from scoring: 1 of 2/);
  assert.match(md, /baseline_miss: 1/);
});

test('an unparsable baseline is also a baseline miss', async () => {
  const { cuts } = selectCutPoints(messages, { cuts: 1 });
  const results = await runFidelity({ messages, cuts, thresholds: [0.15], provider: fakeProvider('hello'), compactor: fakeCompactor() });
  assert.equal(results[0].status, 'baseline_miss');
  assert.equal(results[0].baseline.unparsed, true);
  assert.equal(results[0].baseline.raw, 'hello');
});

test('context shrinks with the threshold and savings are recorded before/after', async () => {
  const { cuts } = selectCutPoints(messages, { cuts: 5 });
  // answer with the real action for whichever cut point the instruction belongs to
  const provider = fakeProvider((_s, _c, instruction) => truthOf(cuts.find((c) => instruction.includes(c.instruction))));
  const results = await runFidelity({ messages, cuts, thresholds: [0.05, 0.5], provider, compactor: fakeCompactor() });
  assert.ok(results.every((r) => r.status === 'scored'));
  const c = results[2]; // K=23: a prefix with long tool results to truncate
  const [lo, hi] = c.conditions;
  assert.equal(lo.saved, 0);
  assert.ok(hi.charsAfter < hi.charsBefore && hi.saved > 0);
  assert.equal(lo.charsBefore, c.baseline.chars);
});

// ---- plan, dry run, budget

test('plan counts calls and flags a plan over the budget', () => {
  const p = planFor({ cuts: [1, 2, 3, 4, 5], thresholds: [1, 2, 3, 4, 5, 6], maxCalls: 60 });
  assert.equal(p.modelCalls, 35);
  assert.equal(p.total, 40);
  assert.equal(p.overBudget, false);
  assert.equal(planFor({ cuts: [1, 2, 3, 4, 5], thresholds: [1, 2, 3, 4, 5, 6], maxCalls: 39 }).overBudget, true);
});

test('--dry-run makes zero calls and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fid-'));
  try {
    const provider = fakeProvider();
    let compactorTouched = 0;
    const compactor = { name: 'spy', jevRequests: 0, prepare() { compactorTouched++; } };
    const lines = [];
    const code = await main([FIXTURE, '--dry-run', '--out', join(dir, 'x')], { provider, compactor, log: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.equal(provider.calls, 0);
    assert.equal(compactorTouched, 0);
    assert.ok(!existsSync(join(dir, 'x-fidelity.json')));
    assert.match(lines.join('\n'), /calls: 35 model/);
    assert.match(lines.join('\n'), /dry run: no calls made/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('--dry-run through the real CLI never starts a model, even for the claude provider', () => {
  // an empty PATH means a spawned `claude` could only fail, so exit 0 proves it was not spawned
  const r = spawnSync(process.execPath, [new URL('../fidelity.mjs', import.meta.url).pathname, FIXTURE, '--dry-run'], { encoding: 'utf8', env: { PATH: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /provider: claude/);
  assert.match(r.stdout, /dry run: no calls made/);
});

test('a plan over --max-calls aborts before any call', async () => {
  const provider = fakeProvider();
  const code = await main([FIXTURE, '--max-calls', '10', '--out', '/nonexistent/x'], { provider, compactor: fakeCompactor(), log: () => {} });
  assert.equal(code, 2);
  assert.equal(provider.calls, 0);
});

test('a full fake run writes both output files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fid-'));
  try {
    const out = join(dir, 'run');
    const code = await main([FIXTURE, '--provider', 'fake', '--cuts', '2', '--thresholds', '0.15', '--out', out], { log: () => {} });
    assert.equal(code, 0);
    const json = JSON.parse(readFileSync(`${out}-fidelity.json`, 'utf8'));
    assert.equal(json.cutPoints.length, 2);
    assert.match(readFileSync(`${out}-fidelity.md`, 'utf8'), /## Threshold sweep/);
  } finally { rmSync(dir, { recursive: true }); }
});
