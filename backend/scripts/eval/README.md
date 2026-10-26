# Host agent evaluation

Measures how each Host prompt version behaves, with numbers instead of hand-typed mock interviews.

Scripted students answer the interview. The runner drives the real interview service
(`shared/nodejs/services/interview-service.js`, the code the endpoints use) with the real engine and prompts,
a simulated clock, and an in-memory store instead of DynamoDB. Nothing in AWS is written. With a real model,
the code and the scripted answers are sent to Bedrock in `us-east-1`.

## Run it

From `backend/`:

```
# 1. No Bedrock: checks the runner and the report
node scripts/eval/run-eval.js --fake-model --prompts host.v2,host.v3 --yes

# 2. Small real run: one case, two profiles, one repeat
node scripts/eval/run-eval.js --prompts host.v3 --cases case1 --profiles strong,vague --repeats 1

# 3. Full comparison
node scripts/eval/run-eval.js --prompts host.v1,host.v2,host.v3 --cases all --profiles all --repeats 3
```

It prints the number of interviews and an estimated number of model calls first, and asks to confirm unless `--yes`
is given.

| Option | Meaning | Default |
| --- | --- | --- |
| `--prompts` | comma-separated prompt versions (`host.v1`, `host.v2`, `host.v3`) | the current default |
| `--cases` | `all` or a list: `case1`, `case2`, `case3` | `all` |
| `--profiles` | `all` or a list: `strong`, `vague`, `wrong`, `short`, `idk`, `mixed` | `all` |
| `--repeats` | how many times each combination runs | 1 |
| `--out` | output folder | `backend/eval-results/<timestamp>/` (ignored by git) |
| `--fake-model` | deterministic fake instead of Bedrock | off |
| `--yes` | do not ask for confirmation | off |
| `--delay-ms` | pause before every model call | 500 (0 with the fake) |
| `--answer-seconds` | simulated seconds per answer (use a large value to force time-outs) | 30 |
| `--model` | Bedrock model ID | `AGENT_MODEL_ID`, else Qwen3 Coder 30B |
| `--price-in`, `--price-out` | USD per million input / output tokens for the cost estimate | 0.15 / 0.60 |
| `--seed`, `--fake-chaos` | fake model seed, and the share of calls (0 to 1) that misbehave | 1, 0.26 |

Interviews run one at a time. A throttled call is retried once; if it is throttled again the engine falls back to
the next main question (recorded as a throttled failure) and the run continues. The prices are a third-party
figure, not an AWS quote: check the Bedrock pricing page, and pass your own with `--price-in/--price-out`.

## What is in the output folder

- `transcripts/<prompt>__<case>__<profile>__r<N>.json`: one per interview. Host turns have `kind`, `reason`,
  `modelReason`, `fallback` and `modelCall` (attempts, retries, whether it failed because of throttling, tokens,
  latency). Student turns have `scripted`: `{ profile, label, answerType, mainOrdinal }`.
- `summary.json`: all numbers, per prompt version: `overall`, `byCase`, `byProfile`.
- `summary.csv`: the same as one row per prompt and scope.
- `summary.md`: comparison tables across prompts, then one table per prompt.

## Test cases and students

- `cases/` and `../sample.cpp`: three programs (linked list, array stack, word counter with a bug), each with an
  interview config in the same format as an assessment's `interview` field.
- `students/case<N>.json`: five profiles per case (strong, vague, wrong, short, idk), each with a main answer
  and a follow-up answer per main question, and a label per answer. The follow-up answer is used for whatever
  follow-up the Host asks about that main question. `mixed` is a fixed list of labels, one per main question, so it is
  the same in every prompt and repeat.
- `answers.md`: every question with every scripted answer and label in one place. Regenerate it after editing
  the students with `node scripts/eval/build-answers.js` (a Jest test fails if it is stale).

Case 1 shares code and wording with the examples inside `host.v2` and `host.v3`, so those two are advantaged on
that case; `host.v1` has no examples. Judge prompts mainly on case 2 and case 3.

## Metrics

All heuristics are in `metrics.js`. Rates are shown as `percent (count/total)`; `n/a` means there was nothing to
measure. A decision is one Host choice after a student answer (follow-up, next main question, or end).

| Metric | Meaning |
| --- | --- |
| Unnecessary follow-up | Follow-ups asked after a main answer labelled `good`, out of good main answers where a follow-up was allowed. Lower is better. |
| Missed follow-up | No follow-up after a main answer labelled `vague`, `wrong`, `short` or `idk`, out of those answers where a follow-up was allowed. Also broken down by label. Lower is better. |
| Overrides | Decisions where the engine replaced the model's choice, by type: `followUpLimit` (model asked for a follow-up with none left), `earlyEnd` (asked to end with main questions left), `nextMainNoneRemain` (asked for another main question with none left). Out of all decisions. |
| Fallbacks | Decisions where the model gave no usable answer: `invalid output`, `model unavailable` (any failure except throttling), `throttled` (Bedrock throttling that was still failing after one retry). `throttle retries` counts calls that were throttled once and then succeeded. |
| Yes/no questions | Follow-ups that start with Is, Are, Does, Do, Did, Can, Could, Will, Would, Should, Has or Have. |
| Multi-part questions | Follow-ups with more than one `?`, or two questions joined by "and" (for example "... and why ..."). |
| Reason contradicts action | The model's own reason argues for the other action: for example "no follow-up needed" on a follow-up, or "needs clarification" / "probe" / "incomplete" on a move to the next main question or end. Reasons written by the engine (overrides, fallbacks) are not checked. A negation such as "no need to probe" is ignored. |
| Questions per interview | Host questions asked, including the first. |
| Completed / timed out / errored | How each interview ended. Timed out means the simulated clock passed the time limit; errored means the runner hit an unexpected error. |
| Latency | Median and 95th percentile of successful model calls, in milliseconds. |
| Tokens and cost | Input and output tokens from all calls (including ones that fell back), and an estimated cost at the given prices. |

Decisions that fell back are left out of the unnecessary and missed follow-up rates, because the model did not
choose the action. The checks are text heuristics: use them to compare prompts, and read some transcripts to confirm.

## Known limits

- The final "end" decision is not stored by the service, so its tokens and latency come from the runner's own
  record of each call.
- Criteria are per theme, so in a theme with two main questions the model sees both questions' criteria each time.
  Unnecessary follow-ups after a good answer there may partly come from that.
- The fake model ignores the prompt, so fake runs give identical numbers for every prompt version.
