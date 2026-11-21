#include "functions.h"

void reverseList(vector<int>& vec) {
    size_t left = 0;
    size_t right = vec.size() - 1;
    while (left < right) {
        int temp = vec[left];
        vec[left] = vec[right];
        vec[right] = temp;
        left++;
        right--;
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
    for (int x : rolls) {
        if (x < 1 || x > 6) {
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
    int best = vec[0];
    int bestCount = 0;
    for (size_t i = 0; i < vec.size(); i++) {
        int c = 0;
        for (size_t j = 0; j < vec.size(); j++) {
            if (vec[j] == vec[i]) {
                c++;
            }
        }
        if (c > bestCount || (c == bestCount && vec[i] < best)) {
            best = vec[i];
            bestCount = c;
        }
    }
    return best;
}
