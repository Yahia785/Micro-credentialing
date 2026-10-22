#include <iostream>

struct Node {
    int value;
    Node* next;
};

class LinkedList {
public:
    LinkedList() : head(nullptr) {}

    ~LinkedList() {
        while (head != nullptr) {
            Node* temp = head;
            head = head->next;
            delete temp;
        }
    }

    void pushFront(int value) {
        Node* node = new Node{value, head};
        head = node;
    }

    bool removeFront(int& out) {
        if (head == nullptr) {
            return false;
        }
        Node* temp = head;
        out = temp->value;
        head = head->next;
        delete temp;
        return true;
    }

    void print() const {
        for (Node* cur = head; cur != nullptr; cur = cur->next) {
            std::cout << cur->value << " ";
        }
        std::cout << std::endl;
    }

private:
    Node* head;
};

int main() {
    LinkedList list;
    list.pushFront(3);
    list.pushFront(2);
    list.pushFront(1);
    list.print();

    int removed = 0;
    if (list.removeFront(removed)) {
        std::cout << "Removed " << removed << std::endl;
    }
    list.print();
    return 0;
}
