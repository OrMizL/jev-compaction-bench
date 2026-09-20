// Context-ablation fidelity eval: does pruning context cost the agent its ability to continue?
// Method (rewind-and-continue): pick points in a real session where the agent acted, i.e.
// an assistant message with a tool call. Replay each point with the full prefix before
// that message (baseline) and with the prefix compacted at each threshold, ask a model for the
// single next action, and score it against what the agent really did. No LLM judge.
//
// Usage: node fidelity.mjs <messages.json> [--cuts N] [--thresholds LIST] [--model NAME]
//          [--provider claude|openrouter|fake] [--out PREFIX] [--max-calls N]
//          [--max-prefix-chars N] [--repeats N] [--prompt-style situation|legacy] [--dry-run]
// Compaction is live, so TYPESAFE_API_KEY and JEV_LIB are needed exactly as for run.mjs
// (not for --dry-run or --provider fake).
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeProvider } from './providers.mjs';

export const DEFAULT_THRESHOLDS = [0.05, 0.10, 0.15, 0.20, 0.30, 0.50];
export const DEFAULT_CUTS = 5;
export const DEFAULT_MAX_CALLS = 60;
export const DEFAULT_REPEATS = 1;
export const PROMPT_STYLES = ['situation', 'legacy'];
export const DEFAULT_PROMPT_STYLE = 'situation';
// The library pins the first message and the newest 6, so a prefix shorter than this has
// nothing compactable and every threshold would trivially save 0%.
export const MIN_PREFIX = 8;
// Rendered-prefix ceiling per condition. Bigger prefixes are skipped and reported, never
// truncated: truncation would change what is being tested.
export const MAX_PREFIX_CHARS = 80000;
const PRESERVE_RECENT = 6;
const TRUNCATE_HEAD = 300;

// Legacy prompt (--prompt-style legacy): the newest user instruction as a fresh ask, JSON answer.
export const SYSTEM_PROMPT = [
  'You are the coding agent in the session transcript you are given. The transcript is your',
  'history so far; the newest user instruction follows it. Decide the single next tool call',
  'you would make in response, using the tool names and input fields seen in the transcript.',
  'Reply with exactly one line of JSON and nothing else:',
  '{"tool":"<ToolName>","input":{...}}',
  'Do not explain, do not ask questions, and do not use markdown.',
].join(' ');

// Situation prompt (default): the agent is partway through a task, so the standing task is
// background and the decision comes from the most recent state.
export const SITUATION_SYSTEM_PROMPT = [
  'You are the coding agent in the session below, partway through a task. You are given two',
  'parts. The standing task may have been set many steps ago: it is background, not a new',
  'request. The most recent state is your own recent actions, narration, and the results you',
  'have just seen, ending with the newest observation. Decide the single next tool call you',
  'would make right now, from that state, using the tool names seen in the transcript.',
  'Reply with exactly one line and nothing else: TOOL <name> <target>',
  'where <target> is what the call acts on: the file path, the shell command, or the search',
  'pattern or URL (leave it out for a tool that has no target).',
  'Do not explain, do not ask questions, do not use JSON, and do not use markdown.',
].join(' ');

// ---------------------------------------------------------------- cut points

// Claude Code injects non-instruction "user" text: command echoes, interrupt markers.
const NOT_AN_INSTRUCTION = /^\s*(<command-|<local-command|<system-reminder|Caveat:|\[Request interrupted)/;

function isInstruction(m) {
  return m.role === 'user' && !(m.toolResults?.length) && m.text.trim().length > 0 &&
    !NOT_AN_INSTRUCTION.test(m.text);
}

// A cut point K is an assistant message with a tool call, so the prefix under test is
// messages[0..K) and the acting message stays out of it. Real Claude Code sessions are
// mostly tool-result carriers with the prose on assistant turns, so anchoring on the
// action rather than on an instruction message is what finds cut points in them. The
// instruction sent with the prompt is the newest genuine user instruction before K.
// Returns { cuts, candidates, tooEarly, noInstruction, tooLarge }: the chosen cut points
// (spread evenly across the usable candidates), the number of acting messages, and how
// many were dropped for each reason.
export function selectCutPoints(messages, { cuts = DEFAULT_CUTS, minPrefix = MIN_PREFIX, maxPrefixChars = MAX_PREFIX_CHARS } = {}) {
  const usable = [];
  let candidates = 0, noInstruction = 0, tooEarly = 0, tooLarge = 0;
  let instructionIndex = -1; // newest instruction strictly before k
  messages.forEach((a, k) => {
    if (a.role === 'assistant' && a.toolUses?.length) {
      candidates++;
      if (instructionIndex < 0) noInstruction++;
      else if (k < minPrefix) tooEarly++;
      else if (renderContext(messages.slice(0, k)).length > maxPrefixChars) tooLarge++;
      else {
        usable.push({
          index: k, instructionIndex, instruction: messages[instructionIndex].text,
          truth: { tool: a.toolUses[0].tool, input: a.toolUses[0].input ?? {} },
        });
      }
    }
    if (isInstruction(a)) instructionIndex = k;
  });
  const chosen = [];
  if (usable.length <= cuts) chosen.push(...usable);
  else for (let i = 0; i < cuts; i++) chosen.push(usable[Math.floor(((i + 0.5) * usable.length) / cuts)]);
  return { cuts: chosen, candidates, tooEarly, noInstruction, tooLarge };
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

// What a provider is sent, per prompt style. `transcript` is renderContext(...) of whichever
// prefix is under test; the standing task is the same for every condition at a cut point.
export function buildPrompt(style, transcript, standingTask) {
  if (style === 'legacy') return { system: SYSTEM_PROMPT, context: transcript, instruction: instructionPrompt(standingTask) };
  if (style !== 'situation') throw new Error(`unknown prompt style "${style}" (expected ${PROMPT_STYLES.join(' or ')})`);
  return {
    system: SITUATION_SYSTEM_PROMPT,
    context: [
      'STANDING TASK (may be old; background only, not a new request):',
      standingTask,
      '',
      'MOST RECENT STATE (oldest first; ends with the newest observation):',
      transcript,
    ].join('\n'),
    instruction: 'Given the most recent state above, what single tool call do you make next? Reply with one line: TOOL <name> <target>',
  };
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

// `TOOL <name> <target>` on its own line (the situation answer format), or null. The first
// such line wins; a wrapping pair of quotes or backticks around the target is removed.
export function parseToolLine(raw) {
  if (typeof raw !== 'string') return null;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().replace(/^[`*>\s-]+/, '').match(/^TOOL\s+([A-Za-z_][\w.:-]*)(?:\s+(.*))?$/);
    if (!m) continue;
    let target = (m[2] ?? '').trim().replace(/[`*]+$/, '').trim();
    const q = target[0];
    if (target.length > 1 && '"\'`'.includes(q) && target.endsWith(q)) target = target.slice(1, -1).trim();
    return { tool: m[1], input: {}, target };
  }
  return null;
}

// Answer parsing per prompt style. The situation style asks for a TOOL line but still takes
// the JSON form, since it carries the same information.
export function parseAnswer(style, raw) {
  return style === 'legacy' ? parseAction(raw) : (parseToolLine(raw) ?? parseAction(raw));
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

// A TOOL-line target is free text, so it is read the way the real action's target is
// normalised (path, command or search text), taking the kind from the truth.
function targetFromText(want, text) {
  if (!text.trim()) return null;
  if (!want) return { kind: 'other', value: text.trim() };
  if (want.kind === 'path') return { kind: 'path', value: normPath(text) };
  if (want.kind === 'command') return { kind: 'command', value: normCommand(text) };
  return { kind: 'other', value: text.trim().replace(/\s+/g, ' ') };
}

// 1.0 same tool and target, 0.5 same tool other target, 0.0 different tool or no action.
export function scoreAction(truth, got) {
  if (!got) return 0;
  if (got.tool !== truth.tool) return 0;
  const want = normaliseTarget(truth.tool, truth.input);
  const have = typeof got.target === 'string' ? targetFromText(want, got.target) : normaliseTarget(got.tool, got.input);
  return sameTarget(want, have) ? 1 : 0.5;
}

// Ask the model once and score the answer. An unparsable answer scores 0 per the bands but
// is flagged `unparsed` with its raw text, so it never passes for a real disagreement.
// A provider failure is recorded as an error with no score at all.
async function sample(provider, style, transcript, standingTask, truth) {
  const p = buildPrompt(style, transcript, standingTask);
  let raw;
  try {
    raw = await provider.respond(p.system, p.context, p.instruction);
  } catch (e) {
    return { raw: null, parsed: null, unparsed: false, error: String(e.message ?? e), score: null };
  }
  const parsed = parseAnswer(style, raw);
  return { raw, parsed, unparsed: parsed === null, score: scoreAction(truth, parsed) };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Sample one condition `repeats` times. Errored samples are kept and counted but left out of
// the score statistics; `score` is the mean over the rest, null if every sample errored.
async function attempt(provider, style, transcript, standingTask, truth, repeats) {
  const samples = [];
  for (let i = 0; i < repeats; i++) samples.push(await sample(provider, style, transcript, standingTask, truth));
  const scores = samples.filter((s) => s.score !== null).map((s) => s.score);
  return {
    repeats, n: scores.length, errors: repeats - scores.length,
    unparsed: samples.filter((s) => s.score !== null && s.unparsed).length,
    exact: scores.filter((x) => x === 1).length,
    score: mean(scores), min: scores.length ? Math.min(...scores) : null, max: scores.length ? Math.max(...scores) : null,
    samples,
  };
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

// Every condition (the baseline and each threshold) is sampled `repeats` times, so repeats
// multiply the model calls. Jev is asked once per cut point however many repeats there are.
export function planFor({ cuts, thresholds, maxCalls, repeats = DEFAULT_REPEATS }) {
  const conditions = 1 + thresholds.length;
  const modelCalls = cuts.length * conditions * repeats;
  // At least one Jev request per cut point; long transcripts need more batches.
  const jevRequests = cuts.length;
  return { modelCalls, jevRequests, total: modelCalls + jevRequests, maxCalls, repeats, conditions, overBudget: modelCalls + jevRequests > maxCalls };
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;

const clip = (x, n) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);

function describeTruth(truth) {
  const t = normaliseTarget(truth.tool, truth.input);
  return t ? `${truth.tool} ${clip(t.value.replace(/\s+/g, ' '), 60)}` : truth.tool;
}

export function formatPlan(messages, sel, thresholds, plan, opts) {
  const maxPrefixChars = opts.maxPrefixChars ?? MAX_PREFIX_CHARS;
  const repeats = plan.repeats ?? DEFAULT_REPEATS;
  const lines = [
    `transcript: ${messages.length} messages; ${sel.candidates} acting messages (assistant tool calls) as cut point candidates`,
    `skipped: ${sel.noInstruction} no_instruction (no user instruction before it), ${sel.tooEarly} prefix under ${MIN_PREFIX} messages, ` +
      `${sel.tooLarge} too_large (rendered prefix over --max-prefix-chars ${maxPrefixChars})`,
    `provider: ${opts.provider}${opts.model ? ` (${opts.model})` : ''}`,
    `prompt style: ${opts.promptStyle ?? DEFAULT_PROMPT_STYLE}, repeats: ${repeats} per condition`,
    `cut points (${sel.cuts.length}):`,
    ...sel.cuts.map((c) => `  K=${c.index}  prefix ${c.index} messages, ${renderContext(messages.slice(0, c.index)).length} chars  instruction at ${c.instructionIndex} (${c.index - c.instructionIndex} messages back)  truth: ${describeTruth(c.truth)}`),
    `conditions per cut: full + compacted at ${thresholds.join(', ')}`,
    `calls: ${plan.modelCalls} model (${sel.cuts.length} cuts x ${plan.conditions} conditions x ${repeats} repeat${repeats === 1 ? '' : 's'}) + >=${plan.jevRequests} Jev = ${plan.total} (max ${plan.maxCalls})` +
      ` (compacted conditions are skipped for cut points where the baseline is not reproduced, so this is an upper bound)`,
  ];
  if (plan.overBudget) lines.push(`ABORT: plan of ${plan.total} calls exceeds --max-calls ${plan.maxCalls}; nothing was reduced or called. Lower --cuts, --thresholds or --repeats, or raise --max-calls`);
  return lines.join('\n');
}

// Baseline verdict over `repeats` samples: reproduced when at least ceil(repeats / 2) score
// exactly 1.0. Errored samples are neither hits nor misses: if they could have tipped the
// verdict the cut point is a baseline_error, and only a miss that holds even if every error
// had matched is a baseline_miss.
export function baselineStatus(b) {
  const need = Math.ceil(b.repeats / 2);
  if (b.exact >= need) return 'scored';
  return b.exact + b.errors >= need ? 'baseline_error' : 'baseline_miss';
}

export async function runFidelity({ messages, cuts, thresholds, provider, compactor, repeats = DEFAULT_REPEATS, promptStyle = DEFAULT_PROMPT_STYLE }) {
  const results = [];
  for (const cut of cuts) {
    const prefix = messages.slice(0, cut.index);
    const fullText = renderContext(prefix);
    const r = {
      index: cut.index, prefixMessages: prefix.length, instruction: cut.instruction, truth: cut.truth,
      status: 'scored', baseline: { ...(await attempt(provider, promptStyle, fullText, cut.instruction, cut.truth, repeats)), chars: fullText.length }, conditions: [],
    };
    r.status = baselineStatus(r.baseline);
    if (r.status === 'scored') {
      let at;
      try { at = await compactor.prepare(prefix); } catch (e) { r.status = 'compaction_error'; r.error = String(e.message ?? e); }
      for (const t of r.status === 'scored' ? thresholds : []) {
        const text = renderContext(at(t).messages);
        r.conditions.push({ threshold: t, charsBefore: fullText.length, charsAfter: text.length, saved: 1 - text.length / fullText.length, ...(await attempt(provider, promptStyle, text, cut.instruction, cut.truth, repeats)) });
      }
    }
    results.push(r);
  }
  return results;
}

// Per threshold, over cut points whose baseline reproduced the real action. `meanAgreement`
// is the mean over cut points of each cut point's mean over its repeats; min and max are over
// individual samples, so run-to-run variance stays visible. Errored samples are counted in
// `errors` and left out of everything else.
export function aggregate(results, thresholds) {
  const scored = results.filter((r) => r.status === 'scored');
  return thresholds.map((t) => {
    const cs = scored.map((r) => r.conditions.find((c) => c.threshold === t)).filter(Boolean);
    const ok = cs.filter((c) => c.score !== null);
    const scores = ok.flatMap((c) => c.samples.filter((x) => x.score !== null).map((x) => x.score));
    return {
      threshold: t, n: ok.length, samples: scores.length, errors: cs.reduce((a, c) => a + c.errors, 0),
      meanAgreement: mean(ok.map((c) => c.score)),
      minSample: scores.length ? Math.min(...scores) : null, maxSample: scores.length ? Math.max(...scores) : null,
      exactRate: scores.length ? scores.filter((x) => x === 1).length / scores.length : null,
      unparsed: ok.reduce((a, c) => a + c.unparsed, 0),
      meanSaved: mean(ok.map((c) => c.saved)),
    };
  });
}

export function buildJson(meta, results, thresholds) {
  return { meta, aggregate: aggregate(results, thresholds), cutPoints: results };
}

const f2 = (x) => (x === null ? 'n/a' : x.toFixed(2));

// mean [min-max] n=k, with unparsed / failed counts only when there are some
const cell = (c) => (c.score === null ? 'err' :
  `${f2(c.score)} [${f2(c.min)}-${f2(c.max)}] n=${c.n}${c.unparsed ? ` u${c.unparsed}` : ''}${c.errors ? ` e${c.errors}` : ''}`);

// Contains no session text (no instructions, tool targets or model answers), only counts
// and scores; the raw material lives in the gitignored json.
export function buildMarkdown(meta, results, thresholds) {
  const agg = aggregate(results, thresholds);
  const scored = results.filter((r) => r.status === 'scored');
  const missed = results.filter((r) => r.status === 'baseline_miss');
  const baseErr = results.filter((r) => r.status === 'baseline_error');
  const compErr = results.filter((r) => r.status === 'compaction_error');
  const repeats = meta.repeats ?? 1;
  const need = Math.ceil(repeats / 2);
  const L = [
    '# Fidelity eval',
    '',
    `Run ${meta.date}. Provider \`${meta.provider}\`${meta.model ? `, model \`${meta.model}\`` : ''}. ${results.length} cut points, thresholds ${thresholds.join(', ')}.`,
    `Prompt style \`${meta.promptStyle ?? 'legacy'}\`, ${repeats} repeat${repeats === 1 ? '' : 's'} per condition.`,
    `Calls made: ${meta.modelCalls} model, ${meta.jevRequests} Jev.`,
    '',
    '## Threshold sweep',
    '',
    `Over the ${scored.length} cut points where the full-context baseline reproduced the real action.`,
    '',
    'n = cut points, samples = scored model answers behind them. Min and max are over single samples.',
    '',
    '| threshold | n | samples | mean agreement | min | max | exact match (of samples) | unparsed | errors | mean context saved |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...agg.map((a) => `| ${a.threshold.toFixed(2)} | ${a.n} | ${a.samples} | ${f2(a.meanAgreement)} | ${f2(a.minSample)} | ${f2(a.maxSample)} | ${a.exactRate === null ? 'n/a' : pct(a.exactRate)} | ${a.unparsed} | ${a.errors} | ${a.meanSaved === null ? 'n/a' : pct(a.meanSaved)} |`),
    '',
    '## Baseline and exclusions',
    '',
    `Baseline miss rate: ${missed.length} of ${results.length} cut points (${results.length ? pct(missed.length / results.length) : 'n/a'}).`,
    `Excluded from scoring: ${results.length - scored.length} of ${results.length} cut points.`,
    `- baseline_miss: ${missed.length}. Fewer than ${need} of ${repeats} baseline repeats reproduced the real action (same tool and same target, score exactly 1.0), even counting failed calls as hits, so the cut point says nothing about compaction. Compacted conditions were not run for these.`,
    `- baseline_error: ${baseErr.length}. Failed baseline model calls left the verdict undecided.`,
    `- compaction_error: ${compErr.length}. The baseline matched but compaction failed.`,
    `- Cut points never selected: ${meta.candidates - results.length} of ${meta.candidates} candidates (${meta.noInstruction ?? 0} no_instruction, ${meta.tooEarly} prefix too short to compact, ${meta.tooLarge ?? 0} too_large for \`--max-prefix-chars\`, the rest beyond \`--cuts\`).`,
    '',
    '## Per cut point',
    '',
    `Cell format: mean [min-max] over repeats, n=scored repeats, then (context saved). \`u<k>\` = k unparsed answers, \`e<k>\` = k failed calls, \`err\` = every call failed.`,
    '',
    `| K | status | baseline | ${thresholds.map((t) => t.toFixed(2)).join(' | ')} |`,
    `|---|---|---|${thresholds.map(() => '---').join('|')}|`,
    ...results.map((r) => {
      const cells = thresholds.map((t) => {
        const c = r.conditions.find((x) => x.threshold === t);
        return c ? `${cell(c)} (${c.score === null ? 'n/a' : pct(c.saved)})` : '-';
      });
      return `| ${r.index} | ${r.status} | ${cell(r.baseline)} exact ${r.baseline.exact}/${repeats} | ${cells.join(' | ')} |`;
    }),
    '',
    '## How to read this',
    '',
    '- Agreement: 1.0 same tool and target, 0.5 same tool other target, 0.0 different tool or unparsable answer. Deterministic, no judge.',
    `- A baseline counts as reproduced when at least ${need} of ${repeats} repeats scored exactly 1.0; cut points where it did not are excluded. The table shows the loss relative to a baseline that worked, not absolute accuracy. Repeats that missed on a kept cut point still show in its baseline cell.`,
    '- Every threshold at a cut point is judged on one shared Jev pass, so thresholds are comparable with each other. Jev has run to run variance (see FINDINGS.md), so a fresh run can differ.',
    `- ${repeats === 1 ? 'One model sample per condition, so model nondeterminism is not visible at all' : `${repeats} model samples per condition, so the min and max show how much the model varies on its own`}. Treat differences between neighbouring thresholds smaller than that spread as noise.`,
    '- Prompt style `situation` frames the newest user prose as a possibly old standing task and asks for the next action from the most recent state; `legacy` sends it as a fresh instruction. Runs in different styles are not directly comparable.',
    '- Context saved is measured on the rendered transcript text sent to the model.',
    '',
  ];
  return L.join('\n');
}

// ---------------------------------------------------------------- cli

export function parseArgs(argv) {
  const o = { cuts: DEFAULT_CUTS, thresholds: DEFAULT_THRESHOLDS, provider: 'claude', maxCalls: DEFAULT_MAX_CALLS, maxPrefixChars: MAX_PREFIX_CHARS, repeats: DEFAULT_REPEATS, promptStyle: DEFAULT_PROMPT_STYLE, dryRun: false };
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
    else if (a === '--max-prefix-chars') o.maxPrefixChars = Number(val());
    else if (a === '--repeats') o.repeats = Number(val());
    else if (a === '--prompt-style') o.promptStyle = val();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error('expected exactly one <messages.json>');
  o.input = rest[0];
  if (!Number.isInteger(o.cuts) || o.cuts < 1) throw new Error('--cuts must be a positive integer');
  if (!Number.isInteger(o.maxCalls) || o.maxCalls < 1) throw new Error('--max-calls must be a positive integer');
  if (!Number.isInteger(o.maxPrefixChars) || o.maxPrefixChars < 1) throw new Error('--max-prefix-chars must be a positive integer');
  if (!Number.isInteger(o.repeats) || o.repeats < 1) throw new Error('--repeats must be a positive integer');
  if (!PROMPT_STYLES.includes(o.promptStyle)) throw new Error(`unknown prompt style "${o.promptStyle}" (expected ${PROMPT_STYLES.join(' or ')})`);
  if (!o.thresholds.length || o.thresholds.some((t) => !Number.isFinite(t) || t < 0 || t > 1)) throw new Error('--thresholds must be numbers between 0 and 1');
  if (!['claude', 'openrouter', 'fake'].includes(o.provider)) throw new Error(`unknown provider "${o.provider}" (expected claude, openrouter or fake)`);
  return o;
}

// `deps` lets tests inject a provider and compactor. Returns the process exit code.
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  let o;
  try { o = parseArgs(argv); } catch (e) {
    console.error(`${e.message}\nusage: node fidelity.mjs <messages.json> [--cuts N] [--thresholds LIST] [--model NAME] [--provider claude|openrouter|fake] [--out PREFIX] [--max-calls N] [--max-prefix-chars N] [--repeats N] [--prompt-style situation|legacy] [--dry-run]`);
    return 2;
  }
  const messages = JSON.parse(readFileSync(o.input, 'utf8'));
  if (!Array.isArray(messages)) { console.error('input is not a Message[] (run adapt.mjs first)'); return 2; }

  const sel = selectCutPoints(messages, { cuts: o.cuts, maxPrefixChars: o.maxPrefixChars });
  const plan = planFor({ cuts: sel.cuts, thresholds: o.thresholds, maxCalls: o.maxCalls, repeats: o.repeats });
  log(formatPlan(messages, sel, o.thresholds, plan, o));
  if (!sel.cuts.length) { console.error('no usable cut points in this transcript'); return 1; }
  if (plan.overBudget) { console.error('aborting before any call: plan exceeds --max-calls'); return 2; }
  if (o.dryRun) { log('dry run: no calls made'); return 0; }
  if (!o.out) { console.error('--out PREFIX is required for a real run'); return 2; }

  let provider, compactor;
  try {
    provider = deps.provider ?? makeProvider(o.provider, { model: o.model });
    compactor = deps.compactor ?? (o.provider === 'fake' ? fakeCompactor() : await loadJevCompactor());
  } catch (e) { console.error(e.message); return 2; }

  const results = await runFidelity({ messages, cuts: sel.cuts, thresholds: o.thresholds, provider, compactor, repeats: o.repeats, promptStyle: o.promptStyle });
  const meta = {
    date: new Date().toISOString(), provider: provider.name, model: o.model ?? null, input: o.input,
    candidates: sel.candidates, tooEarly: sel.tooEarly, noInstruction: sel.noInstruction, tooLarge: sel.tooLarge,
    maxPrefixChars: o.maxPrefixChars, repeats: o.repeats, promptStyle: o.promptStyle, modelCalls: provider.calls, jevRequests: compactor.jevRequests,
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
