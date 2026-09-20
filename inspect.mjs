// Inspect what fast-jev-compaction dropped, and whether the transcript still references it.
// Usage: node inspect.mjs <adapted.json> <decisions.json>
import { readFileSync } from 'node:fs';

const [, , adaptedPath, decisionsPath] = process.argv;
const messages = JSON.parse(readFileSync(adaptedPath, 'utf8'));
const decisions = JSON.parse(readFileSync(decisionsPath, 'utf8'));

// walk the transcript, pairing each tool_use with its result, in order
const calls = [];
const byId = new Map();
messages.forEach((m, i) => {
  for (const tu of m.toolUses ?? []) {
    const c = { id: 't' + (calls.length + 1), idx: i, tool: tu.tool, input: tu.input ?? {}, result: '', resultIdx: -1 };
    calls.push(c); byId.set(tu.tool_use_id, c);
  }
  for (const tr of m.toolResults ?? []) {
    const c = byId.get(tr.tool_use_id);
    if (c) { c.result = tr.text ?? ''; c.resultIdx = i; c.isError = tr.isError; }
  }
});

// text the compaction keeps = every message text
const keptText = messages.map((m) => m.text).join('\n');

const dropped = [];
decisions.forEach((d, n) => {
  if (d.action === 'keep') return;
  const c = calls[n];
  if (!c) return;
  const path = c.input.file_path ?? c.input.path ?? c.input.command ?? JSON.stringify(c.input).slice(0, 80);
  const mentionedLater = typeof path === 'string' && path.length > 3 &&
    keptText.split(path).length > 2; // appears in text more than once
  dropped.push({
    tool: d.tool, action: d.action, keepCall: d.keepCall, keepResult: d.keepResult,
    target: String(path).slice(0, 90), resultChars: c.result.length, isError: c.isError === true,
    errorsDropped: c.isError === true && c.result.length > 0,
    referencedInKeptText: mentionedLater,
  });
});

const errors = dropped.filter((d) => d.errorsDropped);
const referenced = dropped.filter((d) => d.referencedInKeptText);
const big = [...dropped].sort((a, b) => b.resultChars - a.resultChars).slice(0, 10);

console.log(JSON.stringify({
  calls: calls.length,
  droppedCount: dropped.length,
  droppedChars: dropped.reduce((n, d) => n + d.resultChars, 0),
  droppedWithErrors: errors.length,
  droppedStillReferencedInKeptText: referenced.length,
  droppedByTool: dropped.reduce((a, d) => (a[d.tool] = (a[d.tool] ?? 0) + 1, a), {}),
  largestDropped: big,
  errorExamples: errors.slice(0, 5),
  referencedExamples: referenced.slice(0, 8).map((d) => ({ tool: d.tool, target: d.target })),
}, null, 2));