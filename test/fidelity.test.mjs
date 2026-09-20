// node --test. Fake provider and fake compactor only: nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectCutPoints, renderContext, normaliseTarget, sameTarget, scoreAction, parseAction,
  runFidelity, aggregate, buildMarkdown, fakeCompactor, main, planFor,
  buildPrompt, parseToolLine, parseAnswer, baselineStatus, formatPlan,
} from '../fidelity.mjs';
import { fakeProvider } from '../providers.mjs';

const FIXTURE = new URL('./fixtures/todo-cli-messages.json', import.meta.url).pathname;
const messages = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// ---- cut-point selection

test('cut points are assistant tool calls after an instruction, and the prefix excludes the action', () => {
  const { cuts, candidates, tooEarly, noInstruction, tooLarge } = selectCutPoints(messages, { cuts: 99 });
  assert.equal(candidates, 14); // every assistant message with a tool call
  assert.equal(noInstruction, 0);
  assert.equal(tooEarly, 4); // the acts at K=1, 3, 5, 7 have prefixes under 8 messages
  assert.equal(tooLarge, 0);
  assert.deepEqual(cuts.map((c) => c.index), [10, 12, 14, 16, 19, 21, 24, 28, 30, 33]);
  for (const c of cuts) {
    assert.equal(messages[c.index].role, 'assistant');
    assert.equal(c.truth.tool, messages[c.index].toolUses[0].tool);
    assert.ok(c.instructionIndex < c.index);
    assert.equal(c.instruction, messages[c.instructionIndex].text);
  }
  assert.equal(cuts[0].truth.tool, 'Write');
  assert.equal(cuts[0].instructionIndex, 9); // the newest instruction, not the first one
});

test('injected user text and tool results are never the instruction', () => {
  const msgs = [
    { role: 'user', text: 'real instruction', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', text: '<local-command-stdout>x</local-command-stdout>', toolUses: [] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'ok' }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'pwd' } }] },
  ];
  const { cuts } = selectCutPoints(msgs, { minPrefix: 0 });
  assert.deepEqual(cuts.map((c) => [c.index, c.instructionIndex, c.instruction]), [[1, 0, 'real instruction'], [4, 0, 'real instruction']]);
});

// Shaped like a real Claude Code session: one prompt, then user messages that only carry
// tool results, with the prose on assistant messages.
function realShaped() {
  const msgs = [{ role: 'user', text: 'fix the flaky parser test', toolUses: [] }];
  for (let i = 0; i < 14; i++) {
    msgs.push({ role: 'assistant', text: `step ${i}`, toolUses: [{ tool_use_id: `t${i}`, tool: i % 2 ? 'Read' : 'Bash', input: i % 2 ? { file_path: `/p/src/f${i}.mjs` } : { command: `node run ${i}` } }] });
    msgs.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: `output ${i} `.repeat(50) }] });
  }
  msgs.push({ role: 'assistant', text: 'all done', toolUses: [] });
  return msgs;
}

test('a real-shaped transcript (tool-result user messages, prose on assistant turns) yields cut points', () => {
  const msgs = realShaped();
  assert.ok(msgs.length >= 30);
  const { cuts, candidates, tooEarly } = selectCutPoints(msgs, { cuts: 3 });
  assert.equal(candidates, 14);
  assert.equal(tooEarly, 4); // K=1, 3, 5, 7
  assert.equal(cuts.length, 3);
  for (const c of cuts) {
    assert.equal(c.instruction, 'fix the flaky parser test');
    assert.equal(c.instructionIndex, 0);
    const prefix = msgs.slice(0, c.index);
    assert.equal(prefix.length, c.index);
    assert.ok(!prefix.includes(msgs[c.index])); // the acting message is not in the context
    assert.ok(!renderContext(prefix).includes(JSON.stringify(msgs[c.index].toolUses[0].input)));
  }
});

test('candidates whose rendered prefix exceeds --max-prefix-chars are counted as too_large, not truncated', () => {
  const msgs = realShaped();
  const all = selectCutPoints(msgs, { cuts: 99 });
  const limit = renderContext(msgs.slice(0, 15)).length;
  const capped = selectCutPoints(msgs, { cuts: 99, maxPrefixChars: limit });
  assert.ok(capped.tooLarge > 0);
  assert.equal(capped.cuts.length + capped.tooLarge, all.cuts.length);
  assert.ok(capped.cuts.every((c) => renderContext(msgs.slice(0, c.index)).length <= limit));
  assert.equal(capped.cuts.at(-1).index, 15);
  assert.equal(selectCutPoints(msgs, { maxPrefixChars: 10 }).cuts.length, 0);
});

test('acting messages with no user instruction before them are counted as no_instruction', () => {
  const act = (id) => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: 'ls' } }] });
  const result = (id) => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'ok' }] });
  const inj = { role: 'user', text: '<system-reminder>hi</system-reminder>', toolUses: [] };
  const msgs = [inj, act('a'), result('a'), act('b'), result('b'), { role: 'user', text: 'now do the thing', toolUses: [] }, act('c')];
  const sel = selectCutPoints(msgs, { minPrefix: 0 });
  assert.equal(sel.candidates, 3);
  assert.equal(sel.noInstruction, 2);
  assert.deepEqual(sel.cuts.map((c) => c.index), [6]);
  assert.equal(sel.cuts[0].instruction, 'now do the thing');
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
  assert.equal(bad.unparsed, 1); // count of unparsed samples
  assert.equal(bad.samples[0].unparsed, true);
  assert.equal(bad.samples[0].parsed, null);
  assert.equal(bad.samples[0].raw, 'no idea, sorry');
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
  assert.equal(c1.errors, 1);
  assert.equal(c1.samples[0].error, 'boom');
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
  assert.equal(results[0].baseline.samples[0].unparsed, true);
  assert.equal(results[0].baseline.samples[0].raw, 'hello');
});

test('context shrinks with the threshold and savings are recorded before/after', async () => {
  const { cuts } = selectCutPoints(messages, { cuts: 5 });
  // answer with the real action for whichever cut point the instruction belongs to
  const provider = fakeProvider((_s, context) => truthOf(cuts.find((c) => context.includes(`not a new request):\n${c.instruction}\n\nMOST RECENT`))));
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

// ---- prompt styles

test('situation prompt labels the standing task as background and the state as most recent', () => {
  const transcript = renderContext(messages.slice(0, 10));
  const p = buildPrompt('situation', transcript, 'build the todo cli');
  assert.match(p.context, /STANDING TASK \(may be old; background only, not a new request\):\nbuild the todo cli/);
  assert.match(p.context, /MOST RECENT STATE \(oldest first; ends with the newest observation\):\n<transcript>/);
  assert.ok(p.context.indexOf('STANDING TASK') < p.context.indexOf('MOST RECENT STATE'));
  assert.ok(p.context.endsWith(transcript)); // the state ends with the newest observation
  assert.match(p.instruction, /TOOL <name> <target>/);
  assert.match(p.system, /background, not a new/);
  assert.doesNotMatch(p.context + p.instruction, /Newest user instruction/);
});

test('legacy prompt keeps the old wording and JSON answer format', () => {
  const p = buildPrompt('legacy', '<transcript>x</transcript>', 'do it');
  assert.equal(p.context, '<transcript>x</transcript>');
  assert.match(p.instruction, /^Newest user instruction:\ndo it/);
  assert.match(p.system, /exactly one line of JSON/);
  assert.doesNotMatch(p.context, /STANDING TASK/);
  assert.throws(() => buildPrompt('nope', '', ''), /unknown prompt style/);
});

test('both prompt styles run end to end and send their own prompt', async () => {
  const { cuts } = selectCutPoints(messages, { cuts: 1 });
  for (const style of ['situation', 'legacy']) {
    const seen = [];
    const provider = fakeProvider((system, context, instruction) => { seen.push({ system, context, instruction }); return truthOf(cuts[0]); });
    const results = await runFidelity({ messages, cuts, thresholds: [0.3], provider, compactor: fakeCompactor(), promptStyle: style });
    assert.equal(results[0].status, 'scored');
    assert.equal(seen.length, 2);
    assert.equal(seen[0].context.includes('STANDING TASK'), style === 'situation');
    assert.equal(seen[0].instruction.includes('Newest user instruction'), style === 'legacy');
  }
});

test('situation answers in TOOL <name> <target> form are parsed and scored', () => {
  assert.deepEqual(parseToolLine('TOOL Read /p/src/a.mjs'), { tool: 'Read', input: {}, target: '/p/src/a.mjs' });
  assert.deepEqual(parseToolLine('Sure.\n`TOOL Bash "git status --short"`'), { tool: 'Bash', input: {}, target: 'git status --short' });
  assert.equal(parseToolLine('TOOL TodoWrite').target, '');
  assert.equal(parseToolLine('I would read the file'), null);
  assert.equal(parseToolLine('Tool use is fine'), null);
  // JSON is still accepted in situation style, but never the TOOL form in legacy style
  assert.deepEqual(parseAnswer('situation', '{"tool":"Bash","input":{"command":"ls"}}'), { tool: 'Bash', input: { command: 'ls' } });
  assert.equal(parseAnswer('legacy', 'TOOL Bash ls'), null);

  const read = { tool: 'Read', input: { file_path: '/home/x/proj/src/a.mjs' } };
  const bash = { tool: 'Bash', input: { command: 'cd /w && node --test test/' } };
  assert.equal(scoreAction(read, parseToolLine('TOOL Read src/a.mjs')), 1);
  assert.equal(scoreAction(read, parseToolLine('TOOL Read src/b.mjs')), 0.5);
  assert.equal(scoreAction(read, parseToolLine('TOOL Read')), 0.5);
  assert.equal(scoreAction(read, parseToolLine('TOOL Edit src/a.mjs')), 0);
  assert.equal(scoreAction(bash, parseToolLine('TOOL Bash node --test test/')), 1);
  assert.equal(scoreAction(bash, parseToolLine('TOOL Bash git status')), 0.5);
  assert.equal(scoreAction({ tool: 'TodoWrite', input: { todos: [] } }, parseToolLine('TOOL TodoWrite')), 1);
});

// ---- repeats

// Per-cut-point call order with repeats R: R baseline samples, then R per threshold.
function repeatsRun(baselineHits, repeats = 3) {
  const { cuts } = selectCutPoints(messages, { cuts: 1 });
  const wrong = '{"tool":"Glob","input":{"pattern":"*"}}';
  const provider = fakeProvider((_s, _c, _i, n) => (n <= repeats ? (baselineHits[n - 1] ? truthOf(cuts[0]) : wrong) : truthOf(cuts[0])));
  return runFidelity({ messages, cuts, thresholds: [0.3], provider, compactor: fakeCompactor(), repeats }).then((results) => ({ results, provider }));
}

test('repeats: a baseline matching in 1 of 3 repeats is excluded, 2 of 3 is kept', async () => {
  const one = await repeatsRun([true, false, false]);
  assert.equal(one.results[0].status, 'baseline_miss');
  assert.equal(one.results[0].baseline.exact, 1);
  assert.equal(one.results[0].conditions.length, 0);
  assert.equal(one.provider.calls, 3); // no compacted conditions were sampled

  const two = await repeatsRun([true, false, true]);
  assert.equal(two.results[0].status, 'scored');
  assert.equal(two.results[0].baseline.exact, 2);
  assert.equal(two.provider.calls, 3 + 3);
  assert.equal(two.results[0].conditions[0].repeats, 3);
});

test('repeats: even N needs half (ceil(N/2)), and errors that could tip the verdict make it baseline_error', () => {
  const b = (repeats, exact, errors) => ({ repeats, exact, errors });
  assert.equal(baselineStatus(b(4, 2, 0)), 'scored');
  assert.equal(baselineStatus(b(4, 1, 0)), 'baseline_miss');
  assert.equal(baselineStatus(b(3, 1, 0)), 'baseline_miss');
  assert.equal(baselineStatus(b(3, 1, 1)), 'baseline_error'); // the failed call might have matched
  assert.equal(baselineStatus(b(3, 0, 1)), 'baseline_miss'); // misses even if it had
  assert.equal(baselineStatus(b(1, 0, 1)), 'baseline_error');
  assert.equal(baselineStatus(b(1, 1, 0)), 'scored');
});

test('repeats: condition reports mean, min, max and repeat count; errored samples are counted, not averaged', async () => {
  const { cuts } = selectCutPoints(messages, { cuts: 1 });
  const truth = JSON.parse(truthOf(cuts[0]));
  const same = truthOf(cuts[0]);
  const half = JSON.stringify({ tool: truth.tool, input: { file_path: '/elsewhere/x', command: 'zz', pattern: 'zz', path: '/elsewhere/x' } });
  // baseline 3 exact; threshold: exact, half, then a failed call
  const answers = [same, same, same, same, half, 'FAIL'];
  let n = 0;
  const provider = { name: 'fake', calls: 0, async respond() { this.calls++; const a = answers[n++]; if (a === 'FAIL') throw new Error('boom'); return a; } };
  const results = await runFidelity({ messages, cuts, thresholds: [0.3], provider, compactor: fakeCompactor(), repeats: 3 });
  const c = results[0].conditions[0];
  assert.equal(results[0].status, 'scored');
  assert.deepEqual([c.repeats, c.n, c.errors], [3, 2, 1]);
  assert.equal(c.score, 0.75);
  assert.equal(c.min, 0.5);
  assert.equal(c.max, 1);
  const [a] = aggregate(results, [0.3]);
  assert.deepEqual([a.n, a.samples, a.errors], [1, 2, 1]);
  assert.equal(a.meanAgreement, 0.75);
  assert.equal(a.minSample, 0.5);
  assert.equal(a.maxSample, 1);
  const md = buildMarkdown({ date: 'd', provider: 'fake', repeats: 3, promptStyle: 'situation', modelCalls: 6, jevRequests: 0, candidates: 1, tooEarly: 0 }, results, [0.3]);
  assert.match(md, /0\.75 \[0\.50-1\.00\] n=2 e1/);
  assert.match(md, /3 repeats per condition/);
});

// ---- plan arithmetic with repeats

test('plan counts repeats in the model calls and the budget check', () => {
  const args = { cuts: [1, 2, 3, 4], thresholds: [0.15, 0.2, 0.25] };
  const p = planFor({ ...args, repeats: 3, maxCalls: 90 });
  assert.equal(p.modelCalls, 4 * 4 * 3); // cuts x (baseline + thresholds) x repeats
  assert.equal(p.jevRequests, 4); // Jev is asked once per cut point, not once per repeat
  assert.equal(p.total, 52);
  assert.equal(p.overBudget, false);
  assert.equal(planFor({ ...args, repeats: 3, maxCalls: 51 }).overBudget, true);
  assert.equal(planFor({ ...args, maxCalls: 90 }).modelCalls, 16); // repeats default to 1
});

test('--repeats is in the dry-run count and a plan over --max-calls aborts before any call, without reducing anything', async () => {
  const lines = [];
  const provider = fakeProvider();
  const argv = [FIXTURE, '--cuts', '2', '--thresholds', '0.15,0.2', '--repeats', '3'];
  assert.equal(await main([...argv, '--dry-run', '--max-calls', '30'], { provider, log: (l) => lines.push(l) }), 0);
  assert.match(lines.join('\n'), /calls: 18 model \(2 cuts x 3 conditions x 3 repeats\) \+ >=2 Jev = 20 \(max 30\)/);
  assert.match(lines.join('\n'), /prompt style: situation, repeats: 3/);

  lines.length = 0;
  const code = await main([...argv, '--max-calls', '19', '--out', '/nonexistent/x'], { provider, compactor: fakeCompactor(), log: (l) => lines.push(l) });
  assert.equal(code, 2);
  assert.equal(provider.calls, 0);
  assert.match(lines.join('\n'), /ABORT: plan of 20 calls exceeds --max-calls 19; nothing was reduced/);
  assert.match(lines.join('\n'), /calls: 18 model/); // the plan still shows the real, unreduced count
});

test('--repeats and --prompt-style are validated', async () => {
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(m);
  try {
    assert.equal(await main([FIXTURE, '--repeats', '0', '--dry-run']), 2);
    assert.equal(await main([FIXTURE, '--prompt-style', 'wat', '--dry-run']), 2);
  } finally { console.error = orig; }
  assert.match(errs.join('\n'), /--repeats must be a positive integer/);
  assert.match(errs.join('\n'), /unknown prompt style "wat"/);
});

test('a full fake run with repeats and both prompt styles writes reports that state them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fid-'));
  try {
    for (const style of ['situation', 'legacy']) {
      const out = join(dir, style);
      const code = await main([FIXTURE, '--provider', 'fake', '--cuts', '2', '--thresholds', '0.15', '--repeats', '2', '--prompt-style', style, '--out', out], { log: () => {} });
      assert.equal(code, 0);
      const json = JSON.parse(readFileSync(`${out}-fidelity.json`, 'utf8'));
      assert.equal(json.meta.repeats, 2);
      assert.equal(json.meta.promptStyle, style);
      const scored = json.cutPoints.filter((r) => r.status === 'scored').length;
      assert.equal(json.meta.modelCalls, 2 * (2 + scored)); // repeats x (2 baselines + 1 threshold per scored cut)
      assert.match(readFileSync(`${out}-fidelity.md`, 'utf8'), new RegExp(`Prompt style \`${style}\`, 2 repeats per condition`));
    }
  } finally { rmSync(dir, { recursive: true }); }
});
