# Patch spec: the three honesty fixes from the implementation review

Source: `/tmp/jevres/sirius-harness-review.md` (independent review of this harness). The published
README currently documents the unparsed behaviour as a caveat, so this patch must update the README or
the docs go stale immediately.

## Fix 1: unparsable answers must not be averaged in as disagreement
Today an unparsable answer is scored 0 and included in the mean. A parse failure is a protocol failure,
not evidence that the model disagreed with the recorded action, so a clean-looking mean can silently mix
the two.

Required:
- Compute each threshold's mean over **parsed samples only**. Report `samples_parsed` alongside
  `samples_total`.
- Keep the `unparsed` count per threshold, and keep the raw text of every unparsable answer in the JSON.
- If a condition has **no** parsed samples, mark it `unparsed_all` and exclude it from the mean (the way
  all-error conditions are handled today).
- Baseline rule: an unparsable baseline sample is not a hit. If unparsable or failed samples could have
  changed the baseline verdict, mark the moment `baseline_error` (undecided) rather than `baseline_miss`.
- The markdown report must make this readable: a mean whose `unparsed` count is non-zero should be
  obviously conditional, not quietly smaller.

## Fix 2: a compaction failure must not kill the run
A threshold-specific compaction call is unguarded (around `fidelity.mjs:533`), so an exception ends the
process with no report at all. Wrap it: on failure, record that condition as `compaction_error` for that
moment and threshold, count it, continue the other thresholds, and still write both output files.
`compactor.prepare()` failures are already handled; this is the per-threshold path.

## Fix 3: name the metric what it measures
Rename the human-facing metric to **normalized next-action agreement** everywhere it appears: report
headers, `--help`, README, console summary lines, and the "How to read this" section. Add a
`metric: "normalized_next_action_agreement"` field to the JSON so a consumer cannot mistake it for task
success. Internal JSON keys such as `agreement` may stay, but every place a person reads it must say what
it is.

## README
- Replace the caveat that says unparsable answers are "scored as 0 agreement and included in the means"
  with what the code now does.
- Update any place the metric is named.
- Do not touch the published claim block at the top of the README (the "The result" quote). Its numbers
  do not change, and it is already reviewed.

## Tests (fake provider and fake compactor only, no network)
- Unparsable answers are excluded from the mean, counted, and reported; a condition with only unparsable
  samples is excluded and flagged.
- An unparsable baseline sample that could flip the verdict yields `baseline_error`, not `baseline_miss`.
- A compactor that throws at one threshold produces a `compaction_error` for that threshold and the run
  still completes and writes both files.
- Existing tests keep passing; update assertions only where the rule genuinely changed, and say so.

## Verification bar (show in your final message)
1. `npm test` passes, with the new tests named.
2. `node fidelity.mjs test/fixtures/todo-cli-messages.json --dry-run --repeats 3 --thresholds 0.25,0.5`
   still makes zero calls and needs no key.
3. A fake-provider run that includes an unparsable answer and a throwing compactor completes, writes the
   report, and shows the exclusions in it. Paste the relevant report lines.
4. State plainly what you did not verify.

## Constraints
- Branch `fix/harness-honesty`, push it. Do **not** push to `main`; the maintainer merges after review.
- No new dependencies, no session data, no keys.
- Do not change the scoring bands, the cut-point selection, or the baseline `ceil(N/2)` rule.
