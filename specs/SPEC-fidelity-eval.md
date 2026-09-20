# Build spec: context-ablation fidelity eval for jev-compaction-bench

## Objective
Build the missing measurement: **does pruning context cost the agent its ability to continue the task?**

The existing rig measures decisions (kept / truncated / dropped, context saved). This adds the outcome
measure, so a threshold can be chosen on evidence instead of taste, and so any proposed fix PR can be
scored rather than debated.

## Repo
`OrMizL/jev-compaction-bench` (already cloned at `/home/or/dev/jev-compaction-bench`). Node 18+, ESM,
zero runtime dependencies, everything `.mjs`. Match the style of the existing files (`adapt.mjs`,
`run.mjs`, `inspect.mjs`): plain, commented, no framework, no TypeScript, no new deps.

## Method: rewind-and-continue
For a real session transcript already adapted by `adapt.mjs` into `Message[]`:

1. **Pick cut points.** A cut point is an index `K` in the transcript. Everything before `K` is the
   context under test; the real instruction at `K` and the real action that followed it are the ground
   truth. Choose cut points automatically: scan for messages that (a) contain user text, and (b) are
   followed within 3 messages by an assistant `toolUses` entry. Take up to `--cuts N` of them (default
   5), spread across the session (not clustered).
2. **Run conditions at each cut point.** For each context variant, send the variant plus the ground
   truth instruction to a model, and ask for the single next action in a strict format:
   - `full` — the unmodified prefix, **baseline**. If the baseline itself does not reproduce the real
     action, the cut point is not informative: mark it `baseline_miss` and exclude it from scoring.
   - `compacted` — the prefix passed through the compaction library at threshold `t`, for each `t` in a
     sweep (default `0.05,0.10,0.15,0.20,0.30,0.50`).
3. **Score action agreement** deterministically, no LLM judge:
   - `1.0` same tool **and** same target (compare `input.file_path` or the leading command/path string,
     normalised),
   - `0.5` same tool, different target,
   - `0.0` different tool, or no parsable action.
4. **Report** fidelity and savings per threshold, per cut point and aggregated.

## Model under test
Must be pluggable behind one interface: `respond(systemPrompt, contextText, instruction) -> string`.
- Default implementation: shell out to `claude -p` with `--output-format text` (headless Claude Code),
  because that is the environment the compaction actually runs in. Cost is on Or's subscription, so
  keep runs small and print an estimated call count before starting.
- Second implementation: any OpenAI-compatible chat endpoint via `OPENROUTER_API_KEY` and a
  `--model` flag, for cheap large sweeps.
- A `fake` implementation that returns canned output, used by the test suite so tests never touch the
  network.

## CLI
```
node fidelity.mjs <messages.json> [options]
  --cuts N            number of cut points (default 5)
  --thresholds LIST   comma separated (default 0.05,0.10,0.15,0.20,0.30,0.50)
  --model NAME        model under test
  --provider claude|openrouter|fake   (default claude)
  --out PREFIX        writes <PREFIX>-fidelity.json and <PREFIX>-fidelity.md
  --dry-run           prints the plan (cut points, conditions, call count) and exits without calling
```

## Output
- `<PREFIX>-fidelity.json`: per cut point, per threshold, the raw model answer, the parsed action, the
  ground truth action, the agreement score, and the context size before/after.
- `<PREFIX>-fidelity.md`: a table of threshold → mean agreement → mean context saved, plus the
  baseline miss rate and an explicit statement of how many cut points were excluded and why.
- The README gets a short section describing the method and how to run it. `FINDINGS.md` is **not**
  edited by this build; results get added later, once they exist.

## Hard requirements
- **Never commit session data or secrets.** `*.jsonl`, `*-decisions.json`, `*-fidelity.json` and
  `report.html` stay gitignored; add the new outputs if needed. No API keys anywhere in the repo.
- **Print a cost/plan summary before making calls**; abort cleanly if the plan exceeds `--max-calls`
  (default 60).
- **Degrade honestly.** If the model answer cannot be parsed, record it as `unparsed` with the raw
  text. Never invent a score. Never silently skip a cut point without counting it.
- **Tests**: `node --test` with the fake provider only. Cover: cut-point selection, target
  normalisation, scoring bands, unparsed handling, and that `--dry-run` makes zero calls.
- **Verification bar for "done"**: `node --test` passes, `node fidelity.mjs --dry-run` works on a
  fixture, and one real end-to-end run with the claude provider on a small fixture (`--cuts 2
  --thresholds 0.15`) completes and writes both output files.

## Deliverable
Commit to a branch `feat/fidelity-eval` and push. Do not touch `main`. Do not edit `FINDINGS.md`.
Report in your final message: the files written, the test result, the real end-to-end numbers from the
small fixture run (calls made, agreement scores), and anything you could not do.
