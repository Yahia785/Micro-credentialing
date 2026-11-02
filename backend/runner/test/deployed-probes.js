// C++ programs used by run-deployed.js to check the deployed sandbox from the inside.
const OUTBOUND = `
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cerrno>
#include <cstdio>
// Non-blocking connect with a 2 s cap to each address; prints "blocked" only if every attempt failed.
static bool reaches(const char* ip, int port) {
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) return false;
  fcntl(s, F_SETFL, O_NONBLOCK);
  sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(port); inet_pton(AF_INET, ip, &a.sin_addr);
  int rc = connect(s, (sockaddr*)&a, sizeof a);
  bool ok = false;
  if (rc == 0) ok = true;
  else if (errno != EINPROGRESS) ok = false; // refused or unreachable straight away
  else {
    pollfd p{s, POLLOUT, 0};
    if (poll(&p, 1, 2000) == 1) { int err = 1; socklen_t l = sizeof err; getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &l); ok = (err == 0); }
  }
  close(s);
  return ok;
}
int main() {
  bool any = reaches("1.1.1.1", 80) || reaches("8.8.8.8", 443) || reaches("169.254.169.254", 80) || reaches("169.254.170.2", 80);
  puts(any ? "CONNECTED" : "blocked");
}`;

const ENVIRON = `
#include <cstdio>
#include <string>
#include <fstream>
#include <sstream>
// Reads /proc/<pid>/environ for many pids. Prints the number of bytes obtained plus "LEAK" if any of it
// looks like Lambda's environment (AWS_*, LAMBDA_*, _HANDLER).
int main() {
  size_t total = 0; bool leak = false;
  for (int pid = 1; pid < 2000; pid++) {
    std::ifstream f("/proc/" + std::to_string(pid) + "/environ", std::ios::binary);
    std::stringstream ss; ss << f.rdbuf();
    std::string s = ss.str();
    total += s.size();
    if (s.find("AWS_") != std::string::npos || s.find("LAMBDA_") != std::string::npos || s.find("_HANDLER") != std::string::npos) leak = true;
  }
  std::ifstream me("/proc/self/environ", std::ios::binary); std::stringstream ms; ms << me.rdbuf(); total += ms.str().size();
  printf("%zu%s\\n", total, leak ? " LEAK" : "");
}`;

const AWS_CALL = `
#include <cstdio>
#include <cstdlib>
// No credentials reach the program and nothing it could call is reachable.
int main() {
  const char* names[] = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_LAMBDA_RUNTIME_API"};
  int n = 0; for (const char* v : names) if (getenv(v)) n++;
  puts(n == 0 ? "none" : "HAS AWS ENV");
}`;

module.exports = { OUTBOUND, ENVIRON, AWS_CALL };
