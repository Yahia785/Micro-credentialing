# Harness check (M2)

Runner: local g++.exe (GCC) 14.2.0. Flags: -O2 -std=c++17 (the runner image's). Built with services/harness-builder.js, run through services/interview-runs.js (runAllQuestions). 11 submissions x 4 functions.

## Summary

| check | result |
|---|---|
| plain outputs match the M1 matrix | 187 of 187 cells |
| trace copy built, compiled, stdout equals plain stdout, chosen K-th stop exists | 43 of 43 (1 not applicable: no line to put a breakpoint on) |
| tracing K-th stop differs from the reference's | 7 of 43 (targeted inputs: 3 of 6) |
| what-if passes both rules | 44 of 44; 0 skipped with a reason |
| system errors | 0 |
| agent runs in one A2 interview (limit 30) | most: 17 (form A: 17, form B: 15) |

## What-if follow-ups that are skipped

None.

## System errors

None.

## Agent runs per interview

Counted the way run-limiter counts them: one per input sent to the runner. Candidate inputs of the three main functions (usable target inputs + the first standard input), one trace run per tracing question, one run per prepared what-if. mode is counted only when it replaces a function that cannot be asked.

| submission | form A | form B | mode used (A / B) |
|---|---|---|---|
| ref | 14 | 15 | no / no |
| v01 | 14 | 15 | no / no |
| v02 | 14 | 15 | no / no |
| v03 | 14 | 15 | no / no |
| v04 | 14 | 15 | no / no |
| v05 | 14 | 15 | no / no |
| v06 | 14 | 15 | no / no |
| v07 | 14 | 15 | no / no |
| v08 | 14 | 15 | no / no |
| v09 | 14 | 15 | no / no |
| v10 | 17 | 15 | yes / no |

## Per submission and function

| submission | function | input (targeted?) | breakpoint line → K-th stop | what-if (line: change) → output |
|---|---|---|---|---|
| ref | reverseList | `reverseList 10 20 30 40 50` (standard) | line 7, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `- 1` → `- 2` → `[40, 30, 20, 10, 50]` |
| ref | splitString | `splitString , a,b,c` (standard) | line 23, 2nd of 2: piece="b" (differs from reference: no) | 22: `str[i] == delim` → `str[i] == ' '` → `["a,b,c"]` |
| ref | playCraps | `playCraps 2 2 1 2 3 4` (standard) | line 42, 2nd of 3: sum=3 (differs from reference: no) | 54: `7` → `6` → `2` |
| ref | mode | `mode 5` (standard) | line 74, 1st of 1: value=5, count=1 (differs from reference: no) | 75: `sorted[i]` → `0` → `0` |
| v01 | reverseList | `reverseList 10 20 30 40 50` (standard) | line 7, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `- 1` → `- 2` → `[40, 30, 20, 10, 50]` |
| v01 | splitString | `splitString , a,b,c` (standard) | line 23, 2nd of 2: piece="b" (differs from reference: no) | 22: `str[i] == delim` → `str[i] == ' '` → `["a,b,c"]` |
| v01 | playCraps | `playCraps 2 2 1 2 3 4` (standard) | line 52, 2nd of 2: sum=7 (differs from reference: yes) | 55: `7` → `6` → `2` |
| v01 | mode | `mode 5` (standard) | line 72, 1st of 1: value=5, count=1 (differs from reference: no) | 73: `vec[i]` → `0` → `0` |
| v02 | reverseList | `reverseList 10 20 30 40 50` (standard) | line 6, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `/ 2` → `/ 3` → `[50, 20, 30, 40, 10]` |
| v02 | splitString | `splitString , a,b,c` (standard) | line 18, 2nd of 2: piece="b" (differs from reference: no) | 19: `+ 1` → `+ 2` → `["a", "", ""]` |
| v02 | playCraps | `playCraps 2 2 1 2 3 4` (standard) | line 36, 2nd of 3: sum=3 (differs from reference: no) | 47: `7` → `6` → `2` |
| v02 | mode | `mode 5` (standard) | line 67, 1st of 1: value=5, count=1 (differs from reference: no) | 68: `sorted[i]` → `0` → `0` |
| v03 | reverseList | `reverseList 3 5 8` (targeted) | line 6, 2nd of 3: left number=5, right number=5 (differs from reference: yes) | 7: `vec[vec.size() - 1 - i]` → `vec[0]` → `[3, 5, 3]` |
| v03 | splitString | `splitString , a,b,c` (standard) | line 20, 2nd of 2: piece="b" (differs from reference: no) | 21: `+ 1` → `+ 2` → `["a", "", ""]` |
| v03 | playCraps | `playCraps 2 2 1 2 3 4` (standard) | line 47, 2nd of 2: sum=7 (differs from reference: yes) | 50: `7` → `6` → `2` |
| v03 | mode | `mode 5` (standard) | line 69, 1st of 1: value=5, count=1 (differs from reference: no) | 70: `sorted[i]` → `0` → `0` |
| v04 | reverseList | `reverseList 10 20 30 40 50` (standard) | line 7, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `- 1` → `- 2` → `[40, 30, 20, 10, 50]` |
| v04 | splitString | `splitString , a,b,c` (standard) | line 23, 2nd of 2: piece="b" (differs from reference: no) | 22: `str[i] == delim` → `str[i] == ' '` → `["a,b,c"]` |
| v04 | playCraps | `playCraps 2 2 1 2 3 4` (standard) | line 43, 2nd of 3: sum=3 (differs from reference: no) | 54: `7` → `6` → `2` |
| v04 | mode | `mode 5` (standard) | line 72, 1st of 1: value=5, count=1 (differs from reference: no) | 73: `vec[i]` → `0` → `0` |
| v05 | reverseList | `reverseList 10 20 30 40 50` (standard) | line 7, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `- 1` → `- 2` → `[40, 30, 20, 10, 50]` |
| v05 | splitString | `splitString , a,b,c` (targeted) | line 20, 2nd of 2: piece="b" (differs from reference: no) | 19: `str[i] == delim` → `str[i] == ' '` → `[]` |
| v05 | playCraps | `playCraps 2 2 1 2 3 4` (standard) | line 49, 2nd of 2: sum=7 (differs from reference: yes) | 52: `7` → `6` → `2` |
| v05 | mode | `mode 5` (standard) | line 71, 1st of 1: value=5, count=1 (differs from reference: no) | 72: `sorted[i]` → `0` → `0` |
| v06 | reverseList | `reverseList 10 20 30 40 50` (standard) | line 6, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `/ 2` → `/ 3` → `[50, 20, 30, 40, 10]` |
| v06 | splitString | `splitString , ,apple,banana,orange` (targeted) | line 17, 1st of 2: piece="apple" (differs from reference: yes) | 16: `!=` → `==` → `["", "orange"]` |
| v06 | playCraps | `playCraps 2 2 1 2 3 4` (standard) | line 39, 2nd of 3: sum=3 (differs from reference: no) | 50: `7` → `6` → `2` |
| v06 | mode | `mode 5` (standard) | line 68, 1st of 1: value=5, count=1 (differs from reference: no) | 69: `vec[i]` → `0` → `0` |
| v07 | reverseList | `reverseList 10 20 30 40 50` (standard) | line 6, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `/ 2` → `/ 3` → `[50, 20, 30, 40, 10]` |
| v07 | splitString | `splitString , a,b,c` (standard) | line 18, 2nd of 2: piece="b" (differs from reference: no) | 17: `str[i] == delim` → `str[i] == ' '` → `["a,b,c"]` |
| v07 | playCraps | `playCraps 2 2 1 2 7 5` (targeted) | line 38, 1st of 3: sum=4 (differs from reference: yes) | 47: `sum == point` → `sum == 3` → `0` |
| v07 | mode | `mode 5` (standard) | line 69, 1st of 1: value=5, count=1 (differs from reference: no) | 70: `sorted[i]` → `0` → `0` |
| v08 | reverseList | `reverseList 10 20 30 40 50` (standard) | line 7, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `- 1` → `- 2` → `[40, 30, 20, 10, 50]` |
| v08 | splitString | `splitString , a,b,c` (standard) | line 23, 2nd of 2: piece="b" (differs from reference: no) | 24: `+ 1` → `+ 2` → `["a", "", ""]` |
| v08 | playCraps | `playCraps 2 2 1 2` (targeted) | line 41, 2nd of 2: sum=3 (differs from reference: no) | 57: `return 0;` → `return 1;` → `1` |
| v08 | mode | `mode 5` (standard) | line 70, 1st of 1: value=5, count=1 (differs from reference: no) | 71: `vec[i]` → `0` → `0` |
| v09 | reverseList | `reverseList 10 20 30 40 50` (standard) | line 6, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `/ 2` → `/ 3` → `[50, 20, 30, 40, 10]` |
| v09 | splitString | `splitString , a,b,c` (standard) | line 18, 2nd of 2: piece="b" (differs from reference: no) | 17: `str[i] == delim` → `str[i] == ' '` → `["a,b,c"]` |
| v09 | playCraps | `playCraps 2 2 1 2 3 4` (standard) | line 47, 2nd of 2: sum=7 (differs from reference: yes) | 50: `7` → `6` → `2` |
| v09 | mode | `mode 3 1 3 1` (targeted) | line 69, 2nd of 2: value=3, count=2 (differs from reference: no) | 70: `sorted[i]` → `0` → `0` |
| v10 | reverseList | `reverseList 10 20 30 40 50` (standard) | line 7, 2nd of 2: left number=20, right number=40 (differs from reference: no) | 5: `- 1` → `- 2` → `[40, 30, 20, 10, 50]` |
| v10 | splitString | `splitString , a,b,c` (targeted) | not available: the function has no line that adds a piece to the result (it is an unfinished stub) | 17: `{}` → `{str}` → `["a,b,c"]` |
| v10 | playCraps | `playCraps 2 2 1 2 3 4` (standard) | line 30, 2nd of 3: sum=3 (differs from reference: no) | 41: `7` → `6` → `2` |
| v10 | mode | `mode 5` (standard) | line 61, 1st of 1: value=5, count=1 (differs from reference: no) | 62: `sorted[i]` → `0` → `0` |

