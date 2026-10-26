#include <iostream>
#include <string>

// Counts the words in a sentence by looking at the spaces.
int countWords(const std::string& text) {
    int words = 1;
    for (size_t i = 0; i < text.size(); i++) {
        if (text[i] == ' ') {
            words++;
        }
    }
    return words;
}

bool isLetter(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

int countLetters(const std::string& text) {
    int letters = 0;
    for (char c : text) {
        if (isLetter(c)) {
            letters++;
        }
    }
    return letters;
}

int main() {
    std::string a = "the quick brown fox";
    std::string b = "hello  world";
    std::string c = "";

    std::cout << countWords(a) << std::endl;
    std::cout << countWords(b) << std::endl;
    std::cout << countWords(c) << std::endl;
    std::cout << countLetters(a) << std::endl;
    return 0;
}
