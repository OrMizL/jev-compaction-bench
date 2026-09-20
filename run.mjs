// Run a Jev-guided compaction at a chosen threshold, with the live API.
// Usage: TYPESAFE_API_KEY=... JEV_LIB=<path-or-package> node run.mjs <messages.json> <out-prefix> [threshold]
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, prefix, thrArg] = process.argv;
if (!inPath || !prefix) {
  console.error('usage: node run.mjs <messages.json> <out-prefix> [keepThreshold]');
  process.exit(2);
}

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set. See README.');
  process.exit(2);
}

// The library is not published to npm yet, so point at a package name, a local
// checkout, or a built dist path.
const lib = await import(process.env.JEV_LIB || 'fast-jev-compaction');
const { compactMessages, reductionRatio } = lib;

const transcript = JSON.parse(readFileSync(inPath, 'utf8'));
const keepThreshold = thrArg ? Number(thrArg) : 0.5;

const t0 = Date.now();
const result = await compactMessages(transcript, { apiKey, keepThreshold });
const wall = Date.now() - t0;

writeFileSync(`${prefix}-compacted.json`, JSON.stringify(result.messages));
writeFileSync(`${prefix}-decisions.json`, JSON.stringify(result.decisions, null, 2));

const s = result.stats;
const out = {
  wallMs: wall,
  keepThreshold,
  reductionRatio: Number(reductionRatio(result).toFixed(4)),
  stats: s,
  scales: {
    keepCall: describe(result.decisions.map((d) => d.keepCall)),
    keepResult: describe(result.decisions.map((d) => d.keepResult)),
  },
  decisionsByTool: tally(result.decisions),
  dropped: result.decisions
    .filter((d) => d.action !== 'keep')
    .slice(0, 12)
    .map((d) => ({ tool: d.tool, action: d.action, keepCall: d.keepCall, keepResult: d.keepResult })),
};

console.log(JSON.stringify(out, null, 2));
writeFileSync(`${prefix}-summary.json`, JSON.stringify(out, null, 2));

function describe(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const q = (p) => Number(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(4));
  return {
    n: xs.length,
    min: q(0), p25: q(0.25), median: q(0.5), p75: q(0.75), max: q(0.999),
    at0: xs.filter((x) => x === 0).length,
    at1: xs.filter((x) => x >= 0.999).length,
  };
}

function tally(ds) {
  const t = {};
  for (const d of ds) {
    t[d.tool] ??= { keep: 0, drop_result: 0, drop_call: 0 };
    t[d.tool][d.action]++;
  }
  return t;
}