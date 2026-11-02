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

// return true if the reading is valid (not negative, not above s.max)
bool isValid(double reading, const Settings& s) {
    return reading >= 0 && reading <= s.max;
}

// return the next state, following the rules in the problem statement
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
