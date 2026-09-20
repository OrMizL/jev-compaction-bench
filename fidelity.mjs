// Context-ablation fidelity eval: does pruning context cost the agent its ability to continue?
// Method (rewind-and-continue): pick points in a real session where the user gave an
// instruction and the agent answered with a tool call. Replay each point with the full
// prefix (baseline) and with the prefix compacted at each threshold, ask a model for the
// single next action, and score it against what the agent really did. No LLM judge.
//
// Usage: node fidelity.mjs <messages.json> [--cuts N] [--thresholds LIST] [--model NAME]
//          [--provider claude|openrouter|fake] [--out PREFIX] [--max-calls N] [--dry-run]
// Compaction is live, so TYPESAFE_API_KEY and JEV_LIB are needed exactly as for run.mjs
// (not for --dry-run or --provider fake).
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeProvider } from './providers.mjs';

export const DEFAULT_THRESHOLDS = [0.05, 0.10, 0.15, 0.20, 0.30, 0.50];
export const DEFAULT_CUTS = 5;
export const DEFAULT_MAX_CALLS = 60;
// The library pins the first message and the newest 6, so a prefix shorter than this has
// nothing compactable and every threshold would trivially save 0%.
export const MIN_PREFIX = 8;
const PRESERVE_RECENT = 6;
const TRUNCATE_HEAD = 300;

export const SYSTEM_PROMPT = [
  'You are the coding agent in the session transcript you are given. The transcript is your',
  'history so far; the newest user instruction follows it. Decide the single next tool call',
  'you would make in response, using the tool names and input fields seen in the transcript.',
  'Reply with exactly one line of JSON and nothing else:',
  '{"tool":"<ToolName>","input":{...}}',
  'Do not explain, do not ask questions, and do not use markdown.',
].join(' ');

// ---------------------------------------------------------------- cut points

// Claude Code injects non-instruction "user" text: command echoes, interrupt markers.
const NOT_AN_INSTRUCTION = /^\s*(<command-|<local-command|<system-reminder|Caveat:|\[Request interrupted)/;

function isInstruction(m) {
  return m.role === 'user' && !(m.toolResults?.length) && m.text.trim().length > 0 &&
    !NOT_AN_INSTRUCTION.test(m.text);
}

// A cut point K is a genuine user instruction with an assistant tool call within the next
// 3 messages. Returns { cuts, candidates, tooEarly }: the chosen cut points (spread evenly
// across the candidates), how many candidates existed, and how many were dropped for
// having a prefix too short to compact.
export function selectCutPoints(messages, { cuts = DEFAULT_CUTS, minPrefix = MIN_PREFIX } = {}) {
  const found = [];
  messages.forEach((m, k) => {
    if (!isInstruction(m)) return;
    for (let j = k + 1; j <= k + 3 && j < messages.length; j++) {
      const a = messages[j];
      if (a.role === 'assistant' && a.toolUses?.length) {
        found.push({ index: k, actionIndex: j, instruction: m.text, truth: { tool: a.toolUses[0].tool, input: a.toolUses[0].input ?? {} } });
        return;
      }
    }
  });
  const usable = found.filter((c) => c.index >= minPrefix);
  const chosen = [];
  if (usable.length <= cuts) chosen.push(...usable);
  else for (let i = 0; i < cuts; i++) chosen.push(usable[Math.floor(((i + 0.5) * usable.length) / cuts)]);
  return { cuts: chosen, candidates: found.length, tooEarly: found.length - usable.length };
}

// ---------------------------------------------------------------- rendering

// The text a model sees. Same for every condition, so context sizes are comparable.
export function renderContext(messages) {
  const out = [];
  for (const m of messages) {
    if (m.text.trim()) out.push(`[${m.role}] ${m.text}`);
    for (const tu of m.toolUses ?? []) out.push(`[assistant tool_use ${tu.tool}] ${JSON.stringify(tu.input ?? {})}`);
    for (const tr of m.toolResults ?? []) out.push(`[tool_result${tr.isError ? ' error' : ''}] ${tr.text}`);
  }
  return `<transcript>\n${out.join('\n')}\n</transcript>`;
}

export function instructionPrompt(instruction) {
  return `Newest user instruction:\n${instruction}\n\nReply with the JSON for your single next tool call, and nothing else.`;
}

// ---------------------------------------------------------------- parsing + scoring

// First JSON object in the model text (bare, fenced, or after a preamble), or null.
export function parseAction(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/```(?:json)?/gi, '');
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const o = JSON.parse(text.slice(start, i + 1));
          const tool = o.tool ?? o.name;
          const input = o.input ?? o.arguments ?? {};
          if (typeof tool === 'string' && tool.trim() && input && typeof input === 'object' && !Array.isArray(input)) {
            return { tool: tool.trim(), input };
          }
        } catch { /* not this brace; try the next one */ }
        break;
      }
    }
  }
  return null;
}

function normPath(p) {
  let s = String(p).trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (!s) return '';
  s = posix.normalize(s);
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

// Leading command: skip `cd x &&` style prefixes and env assignments, then take the
// program (basename) plus its first non-flag argument, e.g. "git status", "cat src/a.mjs".
function normCommand(cmd) {
  const segments = String(cmd).split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  const seg = segments.find((s) => !/^cd(\s|$)/.test(s)) ?? segments[0] ?? '';
  const tokens = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));
  while (tokens.length && /^\w+=/.test(tokens[0])) tokens.shift();
  if (!tokens.length) return '';
  const program = tokens[0].split('/').pop();
  const arg = tokens.slice(1).find((t) => !t.startsWith('-'));
  return arg ? `${program} ${normPath(arg)}` : program;
}

// The thing an action points at: { kind, value }, or null when the tool has no target
// (e.g. TodoWrite). Paths first, then the leading command, then search-style fields.
export function normaliseTarget(tool, input = {}) {
  for (const k of ['file_path', 'notebook_path']) {
    if (typeof input[k] === 'string' && input[k].trim()) return { kind: 'path', value: normPath(input[k]) };
  }
  if (typeof input.command === 'string' && input.command.trim()) return { kind: 'command', value: normCommand(input.command) };
  if (typeof input.path === 'string' && input.path.trim()) return { kind: 'path', value: normPath(input.path) };
  for (const k of ['pattern', 'url', 'query', 'description']) {
    if (typeof input[k] === 'string' && input[k].trim()) return { kind: 'other', value: input[k].trim().replace(/\s+/g, ' ') };
  }
  return null;
}

// Equal after normalisation. Paths also match when one is a whole-segment suffix of the
// other, so `src/a.mjs` agrees with `/home/x/proj/src/a.mjs`.
export function sameTarget(a, b) {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.value === b.value) return true;
  if (a.kind !== 'path' || !a.value || !b.value) return false;
  return a.value.endsWith('/' + b.value.replace(/^\//, '')) || b.value.endsWith('/' + a.value.replace(/^\//, ''));
}

// 1.0 same tool and target, 0.5 same tool other target, 0.0 different tool or no action.
export function scoreAction(truth, got) {
  if (!got) return 0;
  if (got.tool !== truth.tool) return 0;
  return sameTarget(normaliseTarget(truth.tool, truth.input), normaliseTarget(got.tool, got.input)) ? 1 : 0.5;
}

// Ask the model once and score the answer. An unparsable answer scores 0 per the bands but
// is flagged `unparsed` with its raw text, so it never passes for a real disagreement.
// A provider failure is recorded as an error with no score at all.
async function attempt(provider, contextText, instruction, truth) {
  let raw;
  try {
    raw = await provider.respond(SYSTEM_PROMPT, contextText, instructionPrompt(instruction));
  } catch (e) {
    return { raw: null, parsed: null, unparsed: false, error: String(e.message ?? e), score: null };
  }
  const parsed = parseAction(raw);
  return { raw, parsed, unparsed: parsed === null, score: scoreAction(truth, parsed) };
}

// ---------------------------------------------------------------- compactors

// A compactor turns a prefix into `at(threshold) -> { messages }`, so the expensive step
// (asking Jev) happens once per cut point and the sweep only re-runs the decision ladder.
// `jevRequests` counts live requests made.

// Live: one Jev pass per prefix, then the library's own decideCall/applyDecisions per
// threshold. Jev's probabilities do not depend on the threshold, so this is the same
// ladder the library runs, with every threshold judged on the same answers.
export async function loadJevCompactor(env = process.env) {
  const apiKey = env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set (compaction is live; see README)');
  const lib = await import(env.JEV_LIB || 'fast-jev-compaction');
  const compactor = {
    name: 'jev',
    jevRequests: 0,
    async prepare(prefix) {
      const probe = await lib.compactMessages(prefix, { apiKey, keepThreshold: 0, preserveRecentMessages: PRESERVE_RECENT, truncateHeadChars: TRUNCATE_HEAD });
      compactor.jevRequests += probe.stats.requests;
      const calls = lib.collectToolCalls(prefix, PRESERVE_RECENT);
      return (keepThreshold) => {
        const decisions = calls.map((c, i) => lib.decideCall(c, probe.decisions[i], { keepThreshold }));
        return { messages: lib.applyDecisions(prefix, decisions, calls, TRUNCATE_HEAD) };
      };
    },
  };
  return compactor;
}

// Offline stand-in for tests and --provider fake: truncates long tool results once the
// threshold passes 0.10, keeping the newest PRESERVE_RECENT messages intact. Not a
// model of Jev; it only has to be deterministic and to shrink with the threshold.
export function fakeCompactor() {
  return {
    name: 'fake',
    jevRequests: 0,
    async prepare(prefix) {
      return (t) => ({
        messages: prefix.map((m, i) => {
          if (t <= 0.10 || i === 0 || i >= prefix.length - PRESERVE_RECENT || !m.toolResults?.length) return m;
          return { ...m, toolResults: m.toolResults.map((r) => ({ ...r, text: r.text.length > 100 ? `${r.text.slice(0, 100)}\n[truncated]` : r.text })) };
        }),
      });
    },
  };
}

// ---------------------------------------------------------------- run

export function planFor({ cuts, thresholds, maxCalls }) {
  const modelCalls = cuts.length * (1 + thresholds.length);
  // At least one Jev request per cut point; long transcripts need more batches.
  const jevRequests = cuts.length;
  return { modelCalls, jevRequests, total: modelCalls + jevRequests, maxCalls, overBudget: modelCalls + jevRequests > maxCalls };
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;

export function formatPlan(messages, sel, thresholds, plan, opts) {
  const lines = [
    `transcript: ${messages.length} messages; ${sel.candidates} cut point candidates, ${sel.tooEarly} dropped for a prefix under ${MIN_PREFIX} messages`,
    `provider: ${opts.provider}${opts.model ? ` (${opts.model})` : ''}`,
    `cut points (${sel.cuts.length}):`,
    ...sel.cuts.map((c) => `  K=${c.index}  prefix ${c.index} messages, ${renderContext(messages.slice(0, c.index)).length} chars  truth: ${c.truth.tool}`),
    `conditions per cut: full + compacted at ${thresholds.join(', ')}`,
    `calls: ${plan.modelCalls} model + >=${plan.jevRequests} Jev = ${plan.total} (max ${plan.maxCalls})` +
      ` (compacted conditions are skipped for cut points where the baseline misses, so this is an upper bound)`,
  ];
  if (plan.overBudget) lines.push(`ABORT: plan exceeds --max-calls; lower --cuts or --thresholds, or raise --max-calls`);
  return lines.join('\n');
}

export async function runFidelity({ messages, cuts, thresholds, provider, compactor }) {
  const results = [];
  for (const cut of cuts) {
    const prefix = messages.slice(0, cut.index);
    const fullText = renderContext(prefix);
    const r = {
      index: cut.index, prefixMessages: prefix.length, instruction: cut.instruction, truth: cut.truth,
      status: 'scored', baseline: { ...(await attempt(provider, fullText, cut.instruction, cut.truth)), chars: fullText.length }, conditions: [],
    };
    if (r.baseline.error) r.status = 'baseline_error';
    else if (r.baseline.score < 1) r.status = 'baseline_miss';
    if (r.status === 'scored') {
      let at;
      try { at = await compactor.prepare(prefix); } catch (e) { r.status = 'compaction_error'; r.error = String(e.message ?? e); }
      for (const t of r.status === 'scored' ? thresholds : []) {
        const text = renderContext(at(t).messages);
        r.conditions.push({ threshold: t, charsBefore: fullText.length, charsAfter: text.length, saved: 1 - text.length / fullText.length, ...(await attempt(provider, text, cut.instruction, cut.truth)) });
      }
    }
    results.push(r);
  }
  return results;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Per threshold, over cut points whose baseline reproduced the real action.
export function aggregate(results, thresholds) {
  const scored = results.filter((r) => r.status === 'scored');
  return thresholds.map((t) => {
    const cs = scored.map((r) => r.conditions.find((c) => c.threshold === t)).filter(Boolean);
    const ok = cs.filter((c) => c.score !== null);
    return {
      threshold: t, n: ok.length, errors: cs.length - ok.length,
      meanAgreement: mean(ok.map((c) => c.score)),
      exactRate: ok.length ? ok.filter((c) => c.score === 1).length / ok.length : null,
      unparsed: ok.filter((c) => c.unparsed).length,
      meanSaved: mean(ok.map((c) => c.saved)),
    };
  });
}

export function buildJson(meta, results, thresholds) {
  return { meta, aggregate: aggregate(results, thresholds), cutPoints: results };
}

const f2 = (x) => (x === null ? 'n/a' : x.toFixed(2));

// Contains no session text (no instructions, tool targets or model answers), only counts
// and scores; the raw material lives in the gitignored json.
export function buildMarkdown(meta, results, thresholds) {
  const agg = aggregate(results, thresholds);
  const scored = results.filter((r) => r.status === 'scored');
  const missed = results.filter((r) => r.status === 'baseline_miss');
  const baseErr = results.filter((r) => r.status === 'baseline_error');
  const compErr = results.filter((r) => r.status === 'compaction_error');
  const L = [
    '# Fidelity eval',
    '',
    `Run ${meta.date}. Provider \`${meta.provider}\`${meta.model ? `, model \`${meta.model}\`` : ''}. ${results.length} cut points, thresholds ${thresholds.join(', ')}.`,
    `Calls made: ${meta.modelCalls} model, ${meta.jevRequests} Jev.`,
    '',
    '## Threshold sweep',
    '',
    `Over the ${scored.length} cut points where the full-context baseline reproduced the real action.`,
    '',
    '| threshold | n | mean agreement | exact match | unparsed | errors | mean context saved |',
    '|---|---|---|---|---|---|---|',
    ...agg.map((a) => `| ${a.threshold.toFixed(2)} | ${a.n} | ${f2(a.meanAgreement)} | ${a.exactRate === null ? 'n/a' : pct(a.exactRate)} | ${a.unparsed} | ${a.errors} | ${a.meanSaved === null ? 'n/a' : pct(a.meanSaved)} |`),
    '',
    '## Baseline and exclusions',
    '',
    `Baseline miss rate: ${missed.length} of ${results.length} cut points (${results.length ? pct(missed.length / results.length) : 'n/a'}).`,
    `Excluded from scoring: ${results.length - scored.length} of ${results.length} cut points.`,
    `- baseline_miss: ${missed.length}. The full context did not reproduce the real action (same tool and same target), so the cut point says nothing about compaction. Compacted conditions were not run for these.`,
    `- baseline_error: ${baseErr.length}. The model call for the baseline failed.`,
    `- compaction_error: ${compErr.length}. The baseline matched but compaction failed.`,
    `- Cut points never selected: ${meta.candidates - results.length} of ${meta.candidates} candidates (${meta.tooEarly} had a prefix too short to compact, the rest were beyond \`--cuts\`).`,
    '',
    '## Per cut point',
    '',
    `Cell format: agreement (context saved). \`u\` = unparsed answer, \`err\` = call failed.`,
    '',
    `| K | status | baseline | ${thresholds.map((t) => t.toFixed(2)).join(' | ')} |`,
    `|---|---|---|${thresholds.map(() => '---').join('|')}|`,
    ...results.map((r) => {
      const cells = thresholds.map((t) => {
        const c = r.conditions.find((x) => x.threshold === t);
        if (!c) return '-';
        if (c.score === null) return 'err';
        return `${c.score.toFixed(1)}${c.unparsed ? 'u' : ''} (${pct(c.saved)})`;
      });
      const b = r.baseline.error ? 'err' : `${r.baseline.score.toFixed(1)}${r.baseline.unparsed ? 'u' : ''}`;
      return `| ${r.index} | ${r.status} | ${b} | ${cells.join(' | ')} |`;
    }),
    '',
    '## How to read this',
    '',
    '- Agreement: 1.0 same tool and target, 0.5 same tool other target, 0.0 different tool or unparsable answer. Deterministic, no judge.',
    '- Baseline agreement is 1.0 by construction (cut points where it was not are excluded), so the table shows the loss relative to a baseline that worked, not absolute accuracy.',
    '- Every threshold at a cut point is judged on one shared Jev pass, so thresholds are comparable with each other. Jev has run to run variance (see FINDINGS.md), so a fresh run can differ.',
    '- One model sample per condition. Model nondeterminism is not controlled; treat small differences between neighbouring thresholds as noise.',
    '- Context saved is measured on the rendered transcript text sent to the model.',
    '',
  ];
  return L.join('\n');
}

// ---------------------------------------------------------------- cli

export function parseArgs(argv) {
  const o = { cuts: DEFAULT_CUTS, thresholds: DEFAULT_THRESHOLDS, provider: 'claude', maxCalls: DEFAULT_MAX_CALLS, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--cuts') o.cuts = Number(val());
    else if (a === '--thresholds') o.thresholds = val().split(',').map((s) => Number(s.trim()));
    else if (a === '--model') o.model = val();
    else if (a === '--provider') o.provider = val();
    else if (a === '--out') o.out = val();
    else if (a === '--max-calls') o.maxCalls = Number(val());
    else if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error('expected exactly one <messages.json>');
  o.input = rest[0];
  if (!Number.isInteger(o.cuts) || o.cuts < 1) throw new Error('--cuts must be a positive integer');
  if (!Number.isInteger(o.maxCalls) || o.maxCalls < 1) throw new Error('--max-calls must be a positive integer');
  if (!o.thresholds.length || o.thresholds.some((t) => !Number.isFinite(t) || t < 0 || t > 1)) throw new Error('--thresholds must be numbers between 0 and 1');
  if (!['claude', 'openrouter', 'fake'].includes(o.provider)) throw new Error(`unknown provider "${o.provider}" (expected claude, openrouter or fake)`);
  return o;
}

// `deps` lets tests inject a provider and compactor. Returns the process exit code.
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  let o;
  try { o = parseArgs(argv); } catch (e) {
    console.error(`${e.message}\nusage: node fidelity.mjs <messages.json> [--cuts N] [--thresholds LIST] [--model NAME] [--provider claude|openrouter|fake] [--out PREFIX] [--max-calls N] [--dry-run]`);
    return 2;
  }
  const messages = JSON.parse(readFileSync(o.input, 'utf8'));
  if (!Array.isArray(messages)) { console.error('input is not a Message[] (run adapt.mjs first)'); return 2; }

  const sel = selectCutPoints(messages, { cuts: o.cuts });
  const plan = planFor({ cuts: sel.cuts, thresholds: o.thresholds, maxCalls: o.maxCalls });
  log(formatPlan(messages, sel, o.thresholds, plan, o));
  if (!sel.cuts.length) { console.error('no usable cut points in this transcript'); return 1; }
  if (plan.overBudget) return 2;
  if (o.dryRun) { log('dry run: no calls made'); return 0; }
  if (!o.out) { console.error('--out PREFIX is required for a real run'); return 2; }

  let provider, compactor;
  try {
    provider = deps.provider ?? makeProvider(o.provider, { model: o.model });
    compactor = deps.compactor ?? (o.provider === 'fake' ? fakeCompactor() : await loadJevCompactor());
  } catch (e) { console.error(e.message); return 2; }

  const results = await runFidelity({ messages, cuts: sel.cuts, thresholds: o.thresholds, provider, compactor });
  const meta = {
    date: new Date().toISOString(), provider: provider.name, model: o.model ?? null, input: o.input,
    candidates: sel.candidates, tooEarly: sel.tooEarly, modelCalls: provider.calls, jevRequests: compactor.jevRequests,
  };
  writeFileSync(`${o.out}-fidelity.json`, JSON.stringify(buildJson(meta, results, o.thresholds), null, 2));
  writeFileSync(`${o.out}-fidelity.md`, buildMarkdown(meta, results, o.thresholds));
  log(`wrote ${o.out}-fidelity.json and ${o.out}-fidelity.md (${meta.modelCalls} model calls, ${meta.jevRequests} Jev requests)`);
  for (const a of aggregate(results, o.thresholds)) log(`  t=${a.threshold.toFixed(2)}  n=${a.n}  agreement=${f2(a.meanAgreement)}  saved=${a.meanSaved === null ? 'n/a' : pct(a.meanSaved)}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main(process.argv.slice(2)));
}
