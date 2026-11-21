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
    if (rolls.size() < 2) {
        return 2;
    }
    int firstSum = rolls[0] + rolls[1];
    if (firstSum == 7 || firstSum == 11) {
        return 0;
    }
    if (firstSum == 2 || firstSum == 3 || firstSum == 12) {
        return 1;
    }
    int point = firstSum;
    for (size_t i = 2; i + 1 < rolls.size(); i += 2) {
        int sum = rolls[i] + rolls[i + 1];
        if (sum == point) {
            return 0;
        }
        if (sum == 7) {
            return 1;
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
