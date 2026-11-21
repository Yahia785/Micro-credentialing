#ifndef FUNCTIONS_H
#define FUNCTIONS_H

#include <vector>
#include <string>
#include <iostream>
#include <algorithm>
#include <limits>
#include <cctype>

using namespace std;

void reverseList(vector<int> &vec);
vector<string> splitString(string str, char delim);
int playCraps(const vector<int> &rolls);
int mode(const vector<int> &vec);

#endif
