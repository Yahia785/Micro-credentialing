#include "functions.h"

void reverseList(vector<int>& vec) {
    // swap the first and last, then the second and second to last, ...
    for (int i = 0; i < vec.size() / 2; i++) {
        swap(vec[i], vec[vec.size() - 1 - i]);
    }
}

vector<string> splitString(string str, char delim) {
    vector<string> parts;
    if (str.empty()) {
        return parts;
    }
    string current = "";
    for (size_t i = 0; i < str.size(); i++) {
        if (str[i] == delim) {
            parts.push_back(current);
            current = "";
        } else {
            current += str[i];
        }
    }
    parts.push_back(current);
    return parts;
}

int playCraps(const vector<int>& rolls) {
    if (rolls.size() >= 2) {
        if (rolls[0] < 1 || rolls[0] > 6 || rolls[1] < 1 || rolls[1] > 6) {
            return -1;
        }
    }
    int numRolls = rolls.size() / 2;
    int point = 0;
    for (int r = 0; r < numRolls; r++) {
        int sum = rolls[2 * r] + rolls[2 * r + 1];
        if (point == 0) {
            if (sum == 7 || sum == 11) {
                return 0;
            } else if (sum == 2 || sum == 3 || sum == 12) {
                return 1;
            } else {
                point = sum;
            }
        } else {
            if (sum == point) {
                return 0;
            } else if (sum == 7) {
                return 1;
            }
        }
    }
    return 2;
}

int mode(const vector<int>& vec) {
    vector<int> sorted = vec;
    sort(sorted.begin(), sorted.end());
    int best = sorted[0];
    int bestCount = 0;
    size_t i = 0;
    while (i < sorted.size()) {
        size_t j = i;
        while (j < sorted.size() && sorted[j] == sorted[i]) {
            j++;
        }
        int count = static_cast<int>(j - i);
        if (count > bestCount) {
            best = sorted[i];
            bestCount = count;
        }
        i = j;
    }
    return best;
}
