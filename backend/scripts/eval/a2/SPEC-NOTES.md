# Spec notes: choices where the assignment text is silent

The reference solution (`reference/`) had to pick a behavior in these cases. They are choices, not spec
requirements. Check them against the real assignment text and the instructor's own solution before the
pilot, and keep them out of `standardInputs` until confirmed (the `questions.json` inputs avoid them).

## splitString: trailing delimiter

`splitString("a,b,", ',')` returns `"a", "b", ""` (three elements).

Why: the spec says empty parts are kept, and gives `",apple,banana,orange"` returning a leading `""`. The same
rule applied at the end gives a trailing `""`. `splitString(",", ',')` therefore returns `"", ""`.
Only the empty string is special (returns an empty vector). This also means `v06` (skips empty parts) is
wrong for a trailing delimiter too.

## playCraps: odd number of dice values

`playCraps({2, 2, 1})` ignores the last, unpaired value. An unpaired value is a roll that has not been completed.
So it behaves like `{2, 2}` and returns 2 (more rolls needed).

Related rules, also chosen by the reference:

- Validation comes first and covers EVERY value, including the unpaired one and values after the game would
  already have been decided: `{3, 4, 7, 1}` returns -1, not 0 (the spec says "any value outside 1 to 6").
- An empty vector, or a single value, returns 2 (no complete roll yet) unless that value is invalid (-1).
- Values after the game is decided are never played, only validated.

## Other limits of the test setup (not spec questions)

- The driver cannot pass a space as the `splitString` delimiter (the command line is split on spaces).
- `mode` is only called with at least one element, as the spec says. The driver does not test the empty case.
- `reverseList` has no return value, so questions ask what the vector holds afterwards.
