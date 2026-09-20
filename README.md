# jev-compaction-bench

Can an AI agent's memory be trimmed safely?

Agents free up room by deleting old context. Tools that do this ask you to trust them. This repo
measures what that costs, instead of assuming it.

### The problem
A coding agent works for a long time. Its context fills up, and something has to delete the old material
to make room. The tool we tested asks a fast AI model, "is this old tool call and its result still
needed?" and deletes whatever it says no to.

Nobody knows what that costs. It frees the most room, and it quietly removes the material the agent was
working from.

### The test
We take a real recorded session. We rewind to a moment in the middle, show the agent everything that had
happened up to that point, and ask: what do you do next? We compare that to what it actually did at that
moment. Then we run the same moment again with the context trimmed.

If trimming costs nothing, the answer comes back the same. If it costs something, the answer changes.

### The safety check
Before comparing anything, we confirm the agent gets the right answer when nothing is trimmed. If it
cannot, that moment is a bad test and we throw it out, rather than blaming trimming for it. This is what
every result below is conditional on.

### The result
Stated at the precision the evidence supports:

> Preliminary result from one recording: across the three of four selected moments where the full-context
> baseline reproduced the recorded next tool and normalized target, threshold 0.25 matched that
> signature in 8 of 9 samples (mean normalized agreement 0.89) while removing 47.8% to 59.4% of
> rendered context. At threshold 0.50, the same moments matched in 1 of 9 samples (mean 0.28) while
> removing 64.2% to 93.9%. One moment was excluded because its own control did not reproduce the
> recorded action. There were no unparsed answers and no provider errors. This suggests the default can
> remove action-relevant context here; it does not establish a generally safe threshold, semantic
> action equivalence, or task completion.

In plainer words: at the milder setting the agent produced the same next action in 8 of 9 tries; at the
default, 1 of 9. That points at the default removing material the agent still needed, on this session.
It is not a safety boundary, and it is not proof that trimming is generally safe below some percentage.

### Limitations
- One recorded session, one model, one task type. Four moments were selected; three had a control that
  reproduced the recorded action, and only those three are counted.
- Three samples per condition, so nine samples per threshold.
- The measure is **normalized next-action agreement**: the same tool against the same normalized target.
  Two different edits to the same file count as a match. It is not task success, and it says nothing
  about correctness or about what information the agent retained generally.
- Threshold is not a fixed percentage saved. The same value removed different amounts at different
  moments: 47.8% to 59.4% at 0.25, and 64.2% to 93.9% at 0.5.

### Why it matters
The project this measures has dozens of proposed fixes and no way to tell which are safe. A measurement
of what trimming does to an agent's next action, even a preliminary one, is a missing referee.

---

## Reproduce it

```bash
git clone https://github.com/OrMizL/jev-compaction-bench && cd jev-compaction-bench

# 1. a Claude Code session log -> the message array the harness takes
node adapt.mjs ~/.claude/projects/<slug>/<session-id>.jsonl session.json

# 2. plan the run (makes no calls, needs no key)
node fidelity.mjs session.json --dry-run --cuts 4 --repeats 3 --thresholds 0.25,0.5

# 3. run it: model under test + live Jev for compaction
TYPESAFE_API_KEY=... JEV_LIB=fast-jev-compaction \\
  node fidelity.mjs session.json --cuts 4 --repeats 3 --thresholds 0.25,0.5 \\
  --max-prefix-chars 250000 --out run1

# 4. the report
cat run1-fidelity.md
```

Requirements: Node 18+, a TypeSafe API key (early access, waitlisted, also available through gateways
such as Vercel or Cloudflare), and a session log. `JEV_LIB` points at the compaction library; it is
**not published to npm** at the time of writing (the library's README documents
`npm install fast-jev-compaction`, but the registry returns 404), so point it at a local checkout or its
built `dist/`.

## What is in here

| file | what it does |
|---|---|
| `fidelity.mjs` | the rewind-and-continue evaluation: cut-point selection, the full and compacted conditions, scoring, reports, CLI |
| `providers.mjs` | the models `fidelity.mjs` can test: headless `claude -p`, any OpenAI-compatible endpoint, and a fake for tests |
| `adapt.mjs` | Claude Code session log (`.jsonl`) to the message array the harness takes |
| `run.mjs` | runs compaction at a chosen threshold against the live Jev API, prints stats and writes decisions |
| `inspect.mjs` | what was dropped: by tool, with error output, and whether a dropped target is still referenced |
| `report.mjs` | single page HTML report with a threshold slider, so you can watch the decision ladder re-decide |
| `FINDINGS.md` | the decision-level measurements: three real sessions, thresholds swept |
| `specs/` | the build specs, in the order they were written, including the bugs each one fixed |

## How the scoring works

The number the harness reports is **normalized next-action agreement**: 1.0 same tool and same target,
0.5 same tool with a different target, 0.0 different tool. It is not task success, and two different
edits to the same file agree. No LLM judge. Targets are compared after normalising paths. A shell command is
compared by signature (its program, any `python3 -m` module, and the set of paths it names), so an inline
script rewritten against the same files still matches: same program and paths 1.0, same program other
paths 0.5, another program 0.0. A truth command naming no path is flagged `loose_target` and scored by a
weaker rule, and the reports count those per threshold.

An answer the harness cannot parse into an action is a protocol failure, not disagreement, so it is not
scored. Each threshold's mean is over the parsed answers only. The reports give `samples_parsed` next to
`samples_total`, count `unparsed`, and star any mean that has unparsed answers behind it; the raw text of
every unparsable answer is kept in the JSON. A condition with no parsed answer is `unparsed_all` and is left
out of the mean, like a condition where every call failed. If a compaction call throws at one threshold, that
moment and threshold is recorded as `compaction_error`, counted, and the other thresholds still run.

Conditions per moment: `full` (the baseline) and the prefix compacted at each threshold. If the baseline
does not reproduce the real action, the moment is `baseline_miss` and is excluded, and the report says how
many. Every condition is sampled `--repeats N` times; the baseline counts as reproduced when at least
`ceil(N/2)` repeats score exactly 1.0. An unparsable or failed baseline sample is not a hit; if it could
have changed that verdict the moment is `baseline_error` (undecided) instead of `baseline_miss`. Jev is
asked once per moment and every threshold reuses those answers through the library's own decision ladder,
so thresholds are compared on identical judgements.

Options: `--cuts N`, `--thresholds LIST`, `--model`, `--provider claude|openrouter|fake`, `--out PREFIX`,
`--max-calls N` (aborts before calling if the plan is larger; nothing is trimmed to fit),
`--max-prefix-chars N` (oversized prefixes are skipped and reported as `too_large`, never truncated),
`--repeats N`, `--prompt-style situation|legacy`, `--dry-run`, `--help`.

Output: `PREFIX-fidelity.json` and `PREFIX-fidelity.md`, both gitignored because they hold session text.
The JSON carries `metric: "normalized_next_action_agreement"` so a consumer cannot mistake it for task success.

## Status

- Built and run: the fidelity evaluation above, on one recorded session.
- Built and measured: the decision-level sweep in `FINDINGS.md`, which is how the 0.5 default was caught
  in the first place (it keeps zero non-pinned calls).
- Not done: a second session with a different task shape; scoring proposed fixes against each other at
  matched savings; and a `compact(messages, options)` interface so any pruner, not just this one, can be
  plugged in. Today this is a bench for one plugin, and the method is the part that generalises.

## Caveats

- One model under test (headless Claude Code), one prompt style per comparison, one session. Treat this
  as a preliminary measurement, which is how it is written.
- Unparsable answers are excluded from the means, not scored as disagreement. They are counted per
  threshold (`unparsed`, next to `samples_parsed` of `samples_total`) and a mean with any behind it is
  starred, so read a starred mean as conditional on the answers that parsed. A model that often fails the
  answer format can therefore look better than it is: check `samples_parsed` before quoting a mean.
- The adapter drops `thinking` blocks when reshaping a transcript, which yields empty messages on input.
  That is a property of this tool, not of the library.
- Jev's answers have small run-to-run variance, so a threshold simulation built from one run is not a
  byte-exact replay of a fresh call.
- Not affiliated with TypeSafe or with the author of `fast-jev-compaction`.

## License

MIT
