# Findings: Jev guided compaction, measured on real sessions

Measured 2026-09-20 against [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
(commit `e3f262a`, v0.2.0 library) with the live TypeSafe Jev API. Method: `adapt.mjs` turns a real
Claude Code session log into the message array the library takes, `run.mjs` compacts it at a chosen
threshold, `inspect.mjs` reports what was dropped.

## The sweep

Three real sessions. A: 279 messages, 99 tool calls. B: 381 messages, 153 calls. C: 222 messages,
78 calls.

| session | threshold | kept | result truncated | deleted | context saved |
|---|---|---|---|---|---|
| A | 0.50 | 0 | 0 | 97 | 94.0% |
| A | 0.30 | 0 | 37 | 60 | 71.1% |
| A | 0.15 | 38 | 59 | 0 | 28.9% |
| B | 0.50 | 0 | 4 | 147 | 96.4% |
| B | 0.15 | 118 | 33 | 0 | 7.8% |
| C | 0.50 | 0 | 2 | 74 | 88.8% |
| C | 0.15 | 30 | 46 | 0 | 57.9% |

Probability distributions, stable across all three sessions:

- `keepResult` ("does this result still need to stay verbatim"): median **0.14 to 0.17**, max 1.0, and
  the 1.0s are pinned calls only.
- `keepCall` ("does knowing this call happened still matter"): median **0.28 to 0.35**.

## Finding 1: the default threshold deletes everything

The decision ladder is: `keepResult >= t` keeps call and result; otherwise `keepCall >= t` keeps the
call and truncates the result; otherwise both are deleted.

Because both distributions sit below 0.4 for non pinned calls, a threshold of 0.5 skips both positive
branches and everything falls through to deletion. That is exactly what happened in all three
sessions: **zero kept calls at the documented default**, with 88.8% to 96.4% of characters removed.
The usable range is roughly **0.10 to 0.25**, not 0 to 1.

This reproduces open issue
[#56](https://github.com/tamaratran/fast-jev-compaction/issues/56), with numbers.

## Finding 2: one number swings the outcome

At 0.15 the same three sessions saved 28.9%, 57.9% and 7.8%. In the 7.8% case the library's own
`minReductionRatio` guard (0.25) trips, so the plugin falls back to the built in summary and Jev is
never used. A fixed threshold therefore has no stable meaning across sessions: it is aggressive in
one and inert in another.

## Finding 3: the model judges results it never sees

In the state sent with each Jev request, every tool result is replaced by a note such as
`ok, 4213 chars (omitted)`, and tool inputs are truncated (the observed fitting stage was
`inputs<=200`). The `keepResult` question is therefore answered from the tool name, a truncated
input, and a character count. For a large source file read, that is a judgment made without seeing a
line of the file.

## Finding 4: what got dropped

At 0.5 in session A, 97 of 99 calls were deleted: 51 shell commands, 23 file edits, 15 file reads and
8 file writes. Four of the dropped results were error output. Every edit and write in the session was
dropped, which means the assistant loses the record of what it changed and has to re-read files to
recover state.

Caveat on safety: a check for whether a dropped target is still referenced in the retained text
messages found none. That check only looks for the literal path in text, so it is weak evidence, not
proof that nothing important was lost.

## Finding 5: integrity is sound

In the compacted output there were no orphaned tool results (every surviving result kept its call),
and all 42 text messages came back byte identical. Nothing is rewritten.

An initial count suggested 39 empty messages survived in the output. That turned out to be an artifact
of `adapt.mjs`, which drops `thinking` blocks and so produces empty messages on input. The library
returned exactly what it was given. Not a library bug.

## Cost

2 to 3 requests per compaction, roughly 20,000 to 22,000 estimated tokens of state per request, about
**$0.002 per compaction** at Jev's advertised $0.042 per million input tokens. Wall time 1.1 to 1.2
seconds, independent of threshold.

## Why this matters

The tool works. The unattended risk is calibration: a single threshold whose default deletes
everything, no per session calibration, and a keep decision made blind to the content being judged.
The missing layer is evaluation. Nobody has measured whether pruning at a given threshold preserves
the agent's ability to finish its task. That is the next thing to build.
