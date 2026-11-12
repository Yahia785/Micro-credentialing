## Tank Fill Controller

A pump keeps a water tank between two levels. A sensor sends one level reading at a time. After each reading, your controller decides which state the tank is in.

You write two functions, `isValid` and `step`. The rest of the program, including `main`, is already written for you.

### Settings

Three numbers, given at the start of the input, control the tank:

| Name | Meaning |
| --- | --- |
| `LOW` | The pump should start filling when a reading is below this level. |
| `HIGH` | The tank counts as full when a reading is at or above this level. |
| `MAX` | The largest reading a sensor can send. A reading above `MAX` is a sensor error. |

In the starter code these are the fields `low`, `high` and `max` of the `Settings` struct.

### States

| State | Meaning |
| --- | --- |
| `IDLE` | The pump is off and the level is fine. This is the starting state. |
| `FILLING` | The pump is on. |
| `FULL` | The pump is off because the tank reached `HIGH`. |
| `ALARM` | The pump is off because of a sensor error. |

### Rules for `step`

For each reading, check these rules in this order. Use the first one that applies.

1. If the current state is `ALARM`, the next state is `ALARM`. Once the controller is in `ALARM`, it stays there for every later reading.
2. If the reading is invalid, the next state is `ALARM`. A reading is invalid if it is negative or greater than `MAX`.
3. If the reading is below `LOW`, the next state is `FILLING`.
4. If the reading is at or above `HIGH`, the next state is `FULL`.
5. Otherwise the reading is between `LOW` and `HIGH`, and the state does not change.

### What you write

- `bool isValid(double reading, const Settings& s)` returns `true` if the reading is valid.
- `TankState step(TankState current, double reading, const Settings& s)` returns the next state.

### Input

The input starts with three numbers: `LOW`, `HIGH` and `MAX`. After them come the readings, separated by spaces or new lines, until the end of the input. There can be no readings at all.

### Output

For each reading, `main` prints one line with the reading, an arrow and the state after that reading:

```
<reading> -> <STATE>
```

After the last reading, `main` prints how many times the pump started:

```
Pump starts: <count>
```

The pump starts each time the controller enters `FILLING` from a different state.
