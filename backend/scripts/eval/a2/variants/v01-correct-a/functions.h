#ifndef FUNCTIONS_H
#define FUNCTIONS_H

#include <vector>
#include <string>
#include <iostream>
#include <algorithm>
#include <limits>
#include <cctype>

using namespace std;

// Reverses the vector in place.
void reverseList(vector<int>& vec);

// Splits str at every delim. Empty parts are kept.
vector<string> splitString(string str, char delim);

// 0 = player wins, 1 = house wins, 2 = more rolls needed, -1 = invalid dice value.
int playCraps(const vector<int>& rolls);

// Most frequent number, ties go to the smallest.
int mode(const vector<int>& vec);

#endif
