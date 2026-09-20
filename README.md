# jev-compaction-bench

Measure whether context pruning is safe, instead of assuming it.

Agents free up room by deleting or summarizing old context. Tools that do this
compaction ask you to trust them. This repo measures the parts nobody measures:
what actually gets deleted, how confident the model was in each decision, and
whether anything load bearing went with it.

It was built to test [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction),
a Claude Code plugin that asks TypeSafe's Jev model whether each old tool call and
result is still needed, then deletes what it says is not. The same rig works for any
compactor that exposes per item decisions.

## What is in here

| file | what it does |
|---|---|
| `adapt.mjs` | reads a Claude Code session log (`.jsonl`) and reshapes it into the message array a compaction library expects |
| `run.mjs` | runs compaction at a chosen threshold against the live Jev API, prints stats and writes decisions to disk |
| `inspect.mjs` | reports what was dropped: by tool, with error output, and whether a dropped target is still referenced elsewhere |
| `report.mjs` | builds a single page HTML report with a threshold slider, so you can watch the decision ladder re-decide |
| `fidelity.mjs` | rewinds a real session to points where the user gave an instruction, replays each with the full and the compacted context, and scores whether a model still takes the action the agent really took |
| `providers.mjs` | the models `fidelity.mjs` can test: headless `claude -p`, any OpenAI-compatible endpoint, and a fake for tests |
| `FINDINGS.md` | measured results, three real sessions, thresholds swept |

## Run it

Requirements: Node 18+, a TypeSafe API key (early access, currently waitlisted, also
available through gateways such as Vercel or Cloudflare), and a session log at
`~/.claude/projects/<path-slug>/<session-id>.jsonl`.

```bash
# 1. session log -> messages array
node adapt.mjs ~/.claude/projects/<slug>/<id>.jsonl session.json

# 2. compact at a threshold, live
TYPESAFE_API_KEY=... JEV_LIB=fast-jev-compaction node run.mjs session.json out 0.15

# 3. what did it drop?
node inspect.mjs session.json out-decisions.json
```

`JEV_LIB` points at the library. It is **not published to npm** at the time of writing
(the library's README documents `npm install fast-jev-compaction`, but the registry
returns 404), so use a local checkout or its built `dist/` path.

## Does pruning cost the agent its task? (`fidelity.mjs`)

Rewind and continue. Cut points are the agent's own tool calls (assistant messages with a
tool use) that come after at least one user instruction, spread evenly across the session.
At each one, a model gets the context before that message (never the message itself) plus
the newest real user instruction, and must name the single next tool call. That answer is scored against the real one:
1.0 same tool and same target, 0.5 same tool with a different target, 0.0 different tool
or an unparsable answer. Targets are compared after normalising paths and reducing shell
commands to program plus first argument. No LLM judge.

Conditions per cut point: `full` (the baseline) and the prefix compacted at each
threshold in the sweep. If the baseline does not reproduce the real action, the cut
point is marked `baseline_miss` and left out of scoring, and the report says how many.
Jev is asked once per cut point and every threshold reuses those answers through the
library's own decision ladder, so thresholds are compared on identical judgements.

```bash
# how many calls would this make? nothing is called
node fidelity.mjs session.json --dry-run

# headless Claude Code as the model under test, live Jev for compaction
TYPESAFE_API_KEY=... JEV_LIB=fast-jev-compaction \
  node fidelity.mjs session.json --cuts 5 --out run1

# any OpenAI-compatible endpoint, for cheaper sweeps (OPENROUTER_BASE_URL overrides the host)
OPENROUTER_API_KEY=... TYPESAFE_API_KEY=... node fidelity.mjs session.json \
  --provider openrouter --model <model> --out run1
```

Options: `--cuts N` (5), `--thresholds LIST` (0.05,0.10,0.15,0.20,0.30,0.50), `--model`,
`--provider claude|openrouter|fake` (claude), `--out PREFIX`, `--max-calls N` (60, the
run aborts before calling if the plan is larger), `--max-prefix-chars N` (80000; cut
points whose rendered prefix is larger are skipped and reported as `too_large`, never
truncated), `--dry-run`. Each real run makes
`cuts x (1 + thresholds)` model calls plus at least one Jev request per cut point, and
prints that before starting. The `claude` provider runs with tools off and no project
context, from a scratch directory.

Output: `PREFIX-fidelity.json` (raw answers, parsed and true actions, scores, context
size before and after) and `PREFIX-fidelity.md` (threshold, mean agreement, mean context
saved, baseline miss rate, and what was excluded and why). Both are gitignored because
the json holds session text. Unparsable answers are kept with their raw text, counted as
`unparsed`, and never silently dropped. Tests: `node --test` (fake provider only).

## Findings so far

Three real Claude Code sessions, 99 / 153 / 78 tool calls, threshold swept at 0.15,
0.30 and 0.50. Full tables in [`FINDINGS.md`](./FINDINGS.md).

The short version: the shipped default threshold of 0.5 keeps **zero** non pinned
calls, because Jev's answers sit around 0.14 to 0.17 for "result still needed" and
0.28 to 0.35 for "call still matters". Any threshold above roughly 0.2 makes both
positive branches of the decision ladder unreachable, so everything falls through to
deletion. The usable range is about 0.10 to 0.25, and a single fixed number meant
savings ranging from 7.8% to 57.9% across sessions.

## Status

- measured: per item decisions, threshold sweep, integrity of the compacted output
  (no orphaned tool results, text preserved byte for byte), cost and latency
- built, not yet run at scale: `fidelity.mjs`, the evaluation that answers the real
  question, "at this threshold, can the agent still finish its task?" No results are
  in `FINDINGS.md` yet.

## Caveats

- Jev's answers have small run to run variance, so a threshold simulation built from
  one run is not a byte exact replay of what the library would return on a fresh call.
- The adapter drops `thinking` blocks when reshaping a transcript, which produces
  empty messages on input. That is a property of this tool, not of the library.
- Not affiliated with TypeSafe or with the author of `fast-jev-compaction`.

## License

MIT
