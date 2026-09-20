# Patch spec: make the baseline trustworthy, then re-sweep the interesting band

## What the first real run showed (and why it is not yet evidence)
One real session, three cut points, four thresholds. Result: **only 1 of 3 cut points was usable**
because the full-context baseline failed to reproduce the real action at the other two (scores 0.5 and
0.0). The one usable point showed agreement 1.00 up to threshold 0.15 (7.8% saved) and 0.00 at 0.20
and above (39% to 86% saved).

n=1 with a 67% baseline miss rate cannot support a conclusion. Fix the control first.

## Root cause of the baseline misses
At every cut point, the "instruction" sent is the most recent user prose, which in a real session is the
original prompt from ~90 messages earlier. The real agent decided from its immediate local state: its own
last actions, the results it had just seen, and its own narration. Asking a model "here is the whole
history, the instruction is that old message, predict the next action" is not the situation the agent
actually faced, so the control fails for reasons unrelated to compaction.

## Required changes

### 1. Frame the situation, do not just replay a stale instruction
Build the prompt explicitly as *mid-task state*, in two labelled parts:
- `standing task (may be old)`: the most recent qualifying user prose before K.
- `most recent state`: the rendered prefix, ending with the newest observation.
Then one explicit ask: the single next action, one line, format `TOOL <name> <target>`.
Keep the standing task clearly labelled as background so the model never treats it as a fresh ask.
Add `--prompt-style` with `situation` (new default) and `legacy` (current behaviour), so the two can be
compared on the same cut points.

### 2. Repeats, so a baseline miss means something
Add `--repeats N` (default 1, we will run 3). Each condition is sampled N times.
- Agreement per condition = mean over repeats.
- The baseline counts as reproduced when at least `ceil(N/2)` repeats score exactly 1.0. Otherwise the
  cut point is excluded as `baseline_miss`, as before.
- Report per condition: mean, min, max, and the repeat count, so variance is visible rather than hidden.
- A model call that fails is still an `error`, excluded from means and counted.

### 3. Budget arithmetic must stay honest
Repeats multiply model calls. `planFor` must include repeats in the count, the dry-run must print the
real total, and `--max-calls` (default 60, raisable) must abort before the first call if the plan
exceeds it. Do not silently reduce repeats or thresholds to fit.

### 4. Tests
- Repeats: baseline excluded when only 1 of 3 repeats matches, kept when 2 of 3 do.
- `--prompt-style situation` and `legacy` both render, and the situation style includes the labels.
- Plan arithmetic with repeats counts correctly, and the over-budget abort fires.
- All existing tests keep passing; update counts only where the rule genuinely changed, and say so.

## Verification bar (show all four in your final message)
1. `npm test` passes.
2. `node fidelity.mjs /home/or/dev/jev-compaction-eval/dial-in.json --dry-run --cuts 4 --repeats 3 --thresholds 0.15,0.2,0.25 --max-prefix-chars 250000 --max-calls 90` prints the real call count, per-cut-point prefix size, and makes zero calls with no API key set.
3. Same dry-run with `--prompt-style legacy` still works, for comparison.
4. State plainly what you did NOT verify.

## Constraints
- Branch `feat/fidelity-eval`, push when done. Do not touch `main`, do not edit `FINDINGS.md`.
- No new dependencies, no session data, no keys in the repo.
- Keep the honest-reporting style of the existing output: skipped, unparsed and errored items are always
  counted and always visible.
