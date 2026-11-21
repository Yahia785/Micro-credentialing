// Test driver for the Assignment 02 functions. Reads ONE command line from stdin, calls the
// function and prints the result in a fixed format:
//
//   reverseList 10 20 30 40 50   ->  [50, 40, 30, 20, 10]
//   splitString , a,b,c          ->  ["a", "b", "c"]      (token 1 = delimiter, rest of line = string, may be empty)
//   playCraps 2 2 1 2 3 4        ->  1
//   mode 3 1 3 1                 ->  1
//
// Limits: the delimiter cannot be a space (the line is split on spaces), and the string cannot
// contain a newline. Errors go to stderr with a non-zero exit code.
#include "functions.h"
#include <sstream>

using namespace std;

static vector<int> readInts(const string& text) {
    vector<int> values;
    istringstream in(text);
    int x;
    while (in >> x) {
        values.push_back(x);
    }
    return values;
}

static void printInts(const vector<int>& values) {
    cout << "[";
    for (size_t i = 0; i < values.size(); i++) {
        if (i > 0) {
            cout << ", ";
        }
        cout << values[i];
    }
    cout << "]" << endl;
}

static void printStrings(const vector<string>& values) {
    cout << "[";
    for (size_t i = 0; i < values.size(); i++) {
        if (i > 0) {
            cout << ", ";
        }
        cout << "\"" << values[i] << "\"";
    }
    cout << "]" << endl;
}

int main() {
    string line;
    getline(cin, line);
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
        line.pop_back();
    }
    size_t space = line.find(' ');
    string command = line.substr(0, space);
    string rest = (space == string::npos) ? "" : line.substr(space + 1);

    if (command == "reverseList") {
        vector<int> vec = readInts(rest);
        reverseList(vec);
        printInts(vec);
    } else if (command == "splitString") {
        if (rest.empty()) {
            cerr << "splitString needs a delimiter" << endl;
            return 2;
        }
        char delim = rest[0];
        string str = rest.size() > 2 ? rest.substr(2) : "";
        printStrings(splitString(str, delim));
    } else if (command == "playCraps") {
        cout << playCraps(readInts(rest)) << endl;
    } else if (command == "mode") {
        cout << mode(readInts(rest)) << endl;
    } else {
        cerr << "unknown command: " << command << endl;
        return 2;
    }
    return 0;
}
