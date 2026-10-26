#include <iostream>

const int CAPACITY = 4;

class IntStack {
public:
    IntStack() : top(-1) {}

    bool push(int value) {
        if (top == CAPACITY - 1) {
            return false;
        }
        top++;
        data[top] = value;
        return true;
    }

    bool pop(int& out) {
        if (top < 0) {
            return false;
        }
        out = data[top];
        top--;
        return true;
    }

    int size() const {
        return top + 1;
    }

private:
    int data[CAPACITY];
    int top;
};

int main() {
    IntStack stack;
    for (int i = 1; i <= 6; i++) {
        if (!stack.push(i * 10)) {
            std::cout << "Full at " << i << std::endl;
        }
    }

    int value = 0;
    while (stack.pop(value)) {
        std::cout << value << " ";
    }
    std::cout << std::endl;
    std::cout << "Size: " << stack.size() << std::endl;
    return 0;
}
