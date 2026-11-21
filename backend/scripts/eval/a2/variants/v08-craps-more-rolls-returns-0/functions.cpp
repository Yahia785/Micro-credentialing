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
    if (str.length() == 0) {
        return parts;
    }
    size_t start = 0;
    size_t pos = str.find(delim);
    while (pos != string::npos) {
        parts.push_back(str.substr(start, pos - start));
        start = pos + 1;
        pos = str.find(delim, start);
    }
    parts.push_back(str.substr(start));
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
    return 0;
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
