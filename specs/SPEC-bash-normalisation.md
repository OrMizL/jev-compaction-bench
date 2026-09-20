# Patch spec: Bash target normalisation is too crude to score fairly

## Symptom
On a real session, two of four cut points were excluded as `baseline_miss` because their truth action
is a script-shaped Bash command. The normaliser reduces a command to "program plus first non-flag
argument", so `python3 -c "<a long script>"` collapses to something like `python3 import`. A model that
writes a different inline script against the same file therefore scores at most 0.5 and can never reach
1.0, which excludes the cut point for reasons unrelated to compaction.

Observed: K=100 truth `Bash python3 import re def sections(...)` scored 0.00 on all 3 baseline repeats,
K=232 truth `Bash python3 import sqlite3 conn = sqlite3.connect('data/dial-in...')` scored 0.50 on all 3.

## Required change: signature-based Bash comparison
Replace the Bash branch of target normalisation with a signature that survives script rewriting:

1. Extract `program` = first token, with these special cases:
   - `python3 -m <module>` -> program `python3`, module `<module>`.
   - a leading `cd X && Y` or `X; Y` chain -> use the first command that is not `cd` or a pure
     environment assignment.
2. Extract `paths` = every token in the command that looks like a path, normalised: strips quotes and
   trailing punctuation, must contain `/` or a file extension, and must not be a flag or a URL. Sorted
   and de-duplicated.
3. Compare signatures:
   - same program **and** same path set -> **1.0** (this is the fix: a differently written script against
     the same targets is the same next action, and a baseline must be able to reach 1.0),
   - same program, different path set -> **0.5**,
   - different program -> **0.0**.
   If the truth command has no extractable paths (for example a pure one-liner with no file), fall back
   to the current behaviour and **flag the cut point in the report as `loose_target`** so its score is
   visibly weaker evidence.
4. Non-Bash tools keep the existing behaviour: exact path match where a path exists.

## Reporting
- The dry-run and the markdown report must print, per cut point, the **normalised truth signature** next
  to the raw truth action, so a human can audit whether the scoring is fair.
- Add a per-threshold count of cut points flagged `loose_target`, so a reader can see how much of a mean
  rests on weak comparisons.

## Tests
- A rewritten inline python script against the same file scores 1.0.
- Same program, different file scores 0.5.
- Different program scores 0.0.
- `python3 -m module` and command chains resolve to the expected program and path set.
- A path-less truth command is flagged `loose_target` and still scores by the fallback rule.
- All existing tests keep passing; where an existing assertion encodes the old Bash behaviour, change it
  and say so in the commit message.

## Verification bar (show in your final message)
1. `npm test` passes.
2. `node fidelity.mjs /home/or/dev/jev-compaction-eval/dial-in.json --dry-run --cuts 4 --repeats 3 --thresholds 0.15,0.2,0.25 --max-prefix-chars 250000 --max-calls 90` prints the normalised truth signature for each cut point, still makes zero calls, and requires no key. For K=100 and K=232 the printed signature must be one a model could plausibly match, not `python3 import`.
3. State plainly what you did not verify.

## Constraints
- Branch `feat/fidelity-eval`, push when done. Do not touch `main`, do not edit `FINDINGS.md`.
- No new dependencies, no session data, no keys in the repo.
- Do not change any scoring rule other than the Bash branch.
