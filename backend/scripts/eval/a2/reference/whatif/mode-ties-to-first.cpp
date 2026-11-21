#include "functions.h"

void reverseList(vector<int>& vec) {
    int left = 0;
    int right = static_cast<int>(vec.size()) - 1;
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
    for (size_t i = 0; i < rolls.size(); i++) {
        if (rolls[i] < 1 || rolls[i] > 6) {
            return -1;
        }
    }
    int point = 0;
    for (size_t i = 0; i + 1 < rolls.size(); i += 2) {
        int sum = rolls[i] + rolls[i + 1];
        if (point == 0) {
            if (sum == 7 || sum == 11) {
                return 0;
            }
            if (sum == 2 || sum == 3 || sum == 12) {
                return 1;
            }
            point = sum;
        } else {
            if (sum == point) {
                return 0;
            }
            if (sum == 7) {
                return 1;
            }
        }
    }
    return 2;
}

int mode(const vector<int>& vec) {
    // MUTANT: ties go to the number that appears first in the vector
    int best = vec[0];
    int bestCount = 0;
    for (size_t i = 0; i < vec.size(); i++) {
        int c = 0;
        for (size_t j = 0; j < vec.size(); j++) {
            if (vec[j] == vec[i]) {
                c++;
            }
        }
        if (c > bestCount) {
            best = vec[i];
            bestCount = c;
        }
    }
    return best;
}
