# Case 4: Tank Fill Controller (state machine)

Intro C++ (ECE 2514), mid-November. Uses only topics covered by then: `enum class`, `struct`, functions, `switch`/`if`, loops, `cin`/`cout`.
Coding time: **20 minutes**. Students write two functions; everything else is provided.

---

## 1. Problem statement (what students see)

A pump keeps a water tank between two levels. A sensor sends one level reading at a time, and your controller decides what state the tank is in after each reading.

The controller has four states:

- `IDLE`: pump off, level is fine.
- `FILLING`: pump on.
- `FULL`: pump off, the tank reached the high level.
- `ALARM`: pump off because of a sensor error. Once in `ALARM`, the controller stays in `ALARM` for every later reading.

The settings are three numbers: `low`, `high` and `max`.

Rules for each reading, starting from `IDLE`:

1. If the controller is already in `ALARM`, it stays in `ALARM`.
2. A reading is **invalid** if it is negative or greater than `max`. An invalid reading moves the controller to `ALARM`.
3. A reading below `low` moves the controller to `FILLING`.
4. A reading at or above `high` moves the controller to `FULL`.
5. A reading between `low` and `high` keeps the controller in the state it is already in.

Write these two functions:

- `bool isValid(double reading, const Settings& s)` returns true if the reading is valid.
- `TankState step(TankState current, double reading, const Settings& s)` returns the next state.

`main` is provided. It reads `low high max` and then readings until the end of input, prints the state after each reading, and counts how many times the pump started (each time the controller enters `FILLING` from another state).

**Example.** Input `20 80 100 50 18 40 85 70 15` prints:

```
50 -> IDLE
18 -> FILLING
40 -> FILLING
85 -> FULL
70 -> FULL
15 -> FILLING
Pump starts: 2
```

---

## 2. Starter code (provided to students)

```cpp
#include <iostream>
#include <string>

enum class TankState { IDLE, FILLING, FULL, ALARM };

struct Settings {
    double low;   // start filling below this level
    double high;  // stop filling at or above this level
    double max;   // readings above this are sensor errors
};

std::string toString(TankState s) {
    switch (s) {
        case TankState::IDLE:    return "IDLE";
        case TankState::FILLING: return "FILLING";
        case TankState::FULL:    return "FULL";
        case TankState::ALARM:   return "ALARM";
    }
    return "?";
}

// TODO: return true if the reading is valid (not negative, not above s.max)
bool isValid(double reading, const Settings& s) {
    // your code here
}

// TODO: return the next state, following the rules in the problem statement
TankState step(TankState current, double reading, const Settings& s) {
    // your code here
}

int main() {
    Settings s;
    std::cin >> s.low >> s.high >> s.max;

    TankState state = TankState::IDLE;
    int pumpStarts = 0;
    double reading;
    while (std::cin >> reading) {
        TankState next = step(state, reading, s);
        if (next == TankState::FILLING && state != TankState::FILLING) {
            pumpStarts++;
        }
        state = next;
        std::cout << reading << " -> " << toString(state) << "\n";
    }
    std::cout << "Pump starts: " << pumpStarts << "\n";
    return 0;
}
```

---

## 3. Reference solution (the two functions)

```cpp
bool isValid(double reading, const Settings& s) {
    return reading >= 0 && reading <= s.max;
}

TankState step(TankState current, double reading, const Settings& s) {
    if (current == TankState::ALARM) {
        return TankState::ALARM;
    }
    if (!isValid(reading, s)) {
        return TankState::ALARM;
    }
    if (reading < s.low) {
        return TankState::FILLING;
    }
    if (reading >= s.high) {
        return TankState::FULL;
    }
    return current;  // between low and high: keep the current state
}
```

Compiled with `g++ -std=c++17 -Wall -Wextra` (no warnings) and checked against every test below.

---

## 4. Test cases (stdin → expected stdout)

| # | What it checks | Input | Expected output |
|---|---|---|---|
| T1 | Example from the statement | `20 80 100 50 18 40 85 70 15` | `50 -> IDLE`, `18 -> FILLING`, `40 -> FILLING`, `85 -> FULL`, `70 -> FULL`, `15 -> FILLING`, `Pump starts: 2` |
| T2 | Invalid reading while filling; alarm stays | `20 80 100 10 30 -5 50 10` | `10 -> FILLING`, `30 -> FILLING`, `-5 -> ALARM`, `50 -> ALARM`, `10 -> ALARM`, `Pump starts: 1` |
| T3 | Exactly at `high` | `20 80 100 10 80` | `10 -> FILLING`, `80 -> FULL`, `Pump starts: 1` |
| T4 | Readings near the middle | `20 80 100 49 51 49 51` | four lines `-> IDLE`, `Pump starts: 0` |
| T5 | No readings | `20 80 100` | `Pump starts: 0` |
| T6 | First reading invalid | `20 80 100 -1 50` | `-1 -> ALARM`, `50 -> ALARM`, `Pump starts: 0` |
| T7 | Boundaries (`low`, just below, `high`, `max`, above `max`) | `20 80 100 20 19 79.9 80 100 101` | `20 -> IDLE`, `19 -> FILLING`, `79.9 -> FILLING`, `80 -> FULL`, `100 -> FULL`, `101 -> ALARM`, `Pump starts: 1` |

---

## 5. Instructor interview setup

One theme per main question, **one criterion per main question**, three gaps each. Main questions are asked word for word, in this order. 10-minute typed interview, follow-up budget 1 per main question (as now).

### Q1. Trace (theme: state transitions)
**Main question:** "With settings 20, 80, 100, walk me through what your controller does for the readings 50, 18, 40, 85, 70, 15, and how many times the pump starts."
**Criterion:** The student traces each reading to the correct state and explains why the state holds between the two levels.
**Gaps:**
- g1: At 40 the controller stays `FILLING`, because a reading between `low` and `high` keeps the current state.
- g2: At 70 the controller stays `FULL` for the same reason (it does not go back to `IDLE` or `FILLING`).
- g3: The pump starts twice (at 18 and at 15), because a start is counted only when entering `FILLING` from another state.

### Q2. Why two levels (theme: design reasoning)
**Main question:** "Why does the controller use two levels, 20 and 80, instead of switching the pump at a single level like 50?"
**Criterion:** The student explains the purpose of the gap between the levels (hysteresis) and its effect on the pump.
**Gaps:**
- g1: With a single level, readings that go back and forth around it (49, 51, 49, 51) would turn the pump on and off on every reading.
- g2: The gap between the levels means the pump runs until the tank is high, and stays off until it is low, so it switches rarely.
- g3: Fewer switches means less wear on the pump (and a more stable level), which is why real controllers do this.

### Q3. Invalid reading (theme: edge cases)
**Main question:** "Suppose the controller is FILLING and the next reading is -5. What happens, and what happens with the readings after that?"
**Criterion:** The student explains how an invalid reading is detected and what the alarm state does to later readings.
**Gaps:**
- g1: -5 is invalid because it is negative, so the controller moves to `ALARM`.
- g2: The pump turns off in `ALARM` (it is not `FILLING` any more).
- g3: The controller stays in `ALARM` for every later reading, even valid ones, because `step` checks `ALARM` first.

### Q4. What-if (theme: boundaries / fault injection)
**Main question:** "If the check `reading >= s.high` were changed to `reading > s.high`, what would change in the output?"
**Criterion:** The student identifies the boundary case the change affects and its consequence.
**Gaps:**
- g1: Only a reading of exactly 80 (exactly `high`) behaves differently.
- g2: An input that shows it, for example `10 80`: the second line becomes `80 -> FILLING` instead of `80 -> FULL`.
- g3: The pump keeps running at the high level, so the tank fills past the level it should stop at.

### Q5. Design of step (theme: functions and state)
**Main question:** "Your `step` function takes the current state and returns the next one, instead of changing a global variable. Why is that a useful way to write it?"
**Criterion:** The student explains the benefit of a pure function for a state machine.
**Gaps:**
- g1: It can be tested on its own: call it with any state and reading and check the result.
- g2: There is no hidden state, so the same inputs always give the same next state.
- g3: `main` stays in control of the current state, which makes the loop easy to read and trace.

**Mix of question families:** Q1 trace, Q3 edge case and Q4 what-if are tied to running the code; Q2 and Q5 are explanation. This keeps the explain vs. runtime comparison.

---

## 6. Optional case 5: same problem, common bug

Same statement and questions. The student's `step` ends with `return TankState::IDLE;` instead of `return current;` (forgets to hold the state between the levels).

On T1 it prints `40 -> IDLE` and `70 -> IDLE`, but still `Pump starts: 2`, so a check of only the final count would pass it. In the interview, a strong answer to Q1 should not match this student's own output. This tests whether the agent's follow-ups notice when an answer and the student's own code disagree.
