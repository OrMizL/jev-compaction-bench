# Patch spec: cut-point selection fails on real Claude Code transcripts

## Symptom (reproduced, not theoretical)
```
node fidelity.mjs /home/or/dev/jev-compaction-eval/dial-in.json --dry-run --cuts 3
transcript: 279 messages; 1 cut point candidates, 1 dropped for a prefix under 8 messages
cut points (0)
no usable cut points in this transcript        <- exits 1
```
A 279-message session with 99 tool calls and 42 text-bearing messages produced **one** candidate.
The synthetic fixture you built is chat-shaped, so it passes; real transcripts are not.

## Root cause
`isInstruction()` requires `role === 'user'`, no `toolResults`, non-empty text, and not matching
`NOT_AN_INSTRUCTION`. In a real Claude Code session, user messages are mostly tool-result carriers and
the prose lives in assistant messages, so nearly nothing qualifies.

## Required change
Re-anchor cut points on the **action**, not on the instruction message.

1. A candidate cut point is any index `k` where `messages[k].role === 'assistant'` and
   `messages[k].toolUses?.length`, **and** there is at least one instruction-like user message at an
   index `< k` (keep the existing `NOT_AN_INSTRUCTION` filtering for identifying instruction text).
2. The prefix under test is `messages[0..k)` — everything before the acting message. The acting
   message itself is never part of the context, or the answer leaks.
3. The **instruction text** sent with the condition is the text of the *most recent* qualifying user
   message before `k`. If none exists, skip the candidate and count it as `no_instruction`.
4. Keep the even spread across candidates, and keep `minPrefix`.
5. **Add `--max-prefix-chars` (default 80000).** Skip candidates whose rendered prefix exceeds it and
   count them as `too_large` in the plan and the report. Real prefixes run to 250k characters, and
   sending that per condition makes a sweep unusably slow and expensive. Report it rather than
   truncating the prefix, since truncation would change what is being tested.
6. The dry-run must print, per cut point, the prefix size and the truth action, and must still make
   zero calls and require no API key.

## Tests
- Add a fixture shaped like a real transcript: user messages carrying only `toolResults`, prose on
  assistant messages, ~30 messages, several tool calls. Assert that candidates are found and that a
  chosen cut point's prefix excludes the acting message.
- Add a test for `too_large` skipping and for `no_instruction` skipping.
- Keep every existing test passing. If a count legitimately changes because the rule changed, update
  the assertion and say so in the commit message.

## Verification bar (all must be shown in your final message)
1. `npm test` passes.
2. `node fidelity.mjs /home/or/dev/jev-compaction-eval/dial-in.json --dry-run --cuts 3` prints **at
   least 3 usable cut points** (or as many as are within the prefix budget, with the skips explained),
   and makes zero calls.
3. Same dry-run on `test/fixtures/todo-cli-messages.json` still works.
4. No API key present, and no network call made, in any dry-run.

## Constraints
- Branch `feat/fidelity-eval`, push when done. Do not touch `main`, do not edit `FINDINGS.md`.
- No new dependencies. Do not add session data or any real transcript to the repo.
- Report honestly: if something still does not work on real transcripts, say so.
