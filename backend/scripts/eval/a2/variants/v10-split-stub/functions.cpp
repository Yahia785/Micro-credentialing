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
    // TODO: not finished yet
    return {};
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
