// C++ programs used by run-deployed.js to check the deployed sandbox from the inside.

// Tries to open a TCP connection to the three places that matter on Lambda: the internet, the Lambda Runtime API
// (127.0.0.1:9001 inside the sandbox) and a second link-local address in the 169.254.100.x range Lambda uses.
// Prints one line per target: "<ip>:<port> socket=EPERM" (blocked by seccomp), "socket=<errno>" (other error),
// "connect=failed" (socket opened but nothing answered) or "CONNECTED".
const OUTBOUND = `
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cerrno>
#include <cstdio>
#include <cstring>
static void probe(const char* ip, int port) {
  printf("%s:%d ", ip, port);
  errno = 0;
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) { if (errno == EPERM) puts("socket=EPERM"); else printf("socket=%d\\n", errno); return; }
  fcntl(s, F_SETFL, O_NONBLOCK);
  sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(port); inet_pton(AF_INET, ip, &a.sin_addr);
  int rc = connect(s, (sockaddr*)&a, sizeof a);
  bool ok = false;
  if (rc == 0) ok = true;
  else if (errno == EINPROGRESS) {
    pollfd p{s, POLLOUT, 0};
    if (poll(&p, 1, 2000) == 1) { int err = 1; socklen_t l = sizeof err; getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &l); ok = (err == 0); }
  }
  close(s);
  puts(ok ? "CONNECTED" : "connect=failed");
}
int main() {
  probe("1.1.1.1", 443);
  probe("169.254.100.1", 9001);
  probe("127.0.0.1", 9001);
}`;

// Prints the program's own environment (the launcher starts it with no variables at all) and counts AWS-looking
// variables in the environment of a child shell started with popen("env"). The shell adds PWD/SHLVL/_ by itself;
// those are not AWS variables. Expected output: "count=0" and "child_aws=0".
const ENV_PRINT = `
#include <cstdio>
#include <cstring>
extern char** environ;
int main() {
  int n = 0;
  for (char** e = environ; e && *e; e++) { n++; puts(*e); }
  printf("count=%d\\n", n);
  int aws = 0;
  FILE* p = popen("/usr/bin/env", "r");
  if (p) {
    char line[1024];
    while (fgets(line, sizeof line, p)) {
      if (strstr(line, "AWS") || strstr(line, "LAMBDA") || strstr(line, "_HANDLER")) { aws++; fputs(line, stdout); }
    }
    pclose(p);
  }
  printf("child_aws=%d\\n", aws);
}`;

// Informational only (not a pass/fail check): can the program read other processes' environment? Without Landlock it
// can, which is why the role's credentials are made worthless instead of hidden (see SECURITY.md).
// Prints the number of bytes read plus "LEAK" when any of it looks like Lambda's environment.
const ENVIRON = `
#include <cstdio>
#include <string>
#include <fstream>
#include <sstream>
int main() {
  size_t total = 0; bool leak = false;
  for (int pid = 1; pid < 2000; pid++) {
    std::ifstream f("/proc/" + std::to_string(pid) + "/environ", std::ios::binary);
    std::stringstream ss; ss << f.rdbuf();
    std::string s = ss.str();
    total += s.size();
    if (s.find("AWS_") != std::string::npos || s.find("LAMBDA_") != std::string::npos || s.find("_HANDLER") != std::string::npos) leak = true;
  }
  printf("%zu%s\\n", total, leak ? " LEAK" : "");
}`;

// Informational: the value of /proc/sys/kernel/yama/ptrace_scope as seen by student code, or why it cannot be read.
// (0 = any process of the same user may be traced / have its memory opened, 1 = only descendants, 2 = admin only, 3 = off.)
const PTRACE_SCOPE = `
#include <cerrno>
#include <cstdio>
#include <cstring>
int main() {
  FILE* f = fopen("/proc/sys/kernel/yama/ptrace_scope", "r");
  if (!f) { printf("not readable: %s\\n", strerror(errno)); return 0; }
  char b[32] = {0}; fgets(b, sizeof b, f); fclose(f);
  printf("ptrace_scope=%s", b);
}`;

// Informational: can student code open /proc/<pid>/mem of its parent (the launcher) and grandparent (the Node handler)
// for reading and for writing? For reading it also tries to read 8 bytes at the first readable mapping. It never writes.
const PROC_MEM = `
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <cstdio>
#include <cstring>
static void probe(const char* label, long pid) {
  char path[64];
  snprintf(path, sizeof path, "/proc/%ld/mem", pid);
  printf("%s pid=%ld: ", label, pid);
  errno = 0;
  int r = open(path, O_RDONLY);
  if (r < 0) printf("open(read)=%s", strerror(errno));
  else {
    printf("open(read)=OK");
    char mp[64]; snprintf(mp, sizeof mp, "/proc/%ld/maps", pid);
    FILE* m = fopen(mp, "r");
    unsigned long start = 0, end = 0; char perms[8] = {0};
    if (m && fscanf(m, "%lx-%lx %7s", &start, &end, perms) == 3 && perms[0] == 'r') {
      char buf[8]; errno = 0;
      ssize_t n = pread(r, buf, sizeof buf, (off_t)start);
      if (n < 0) printf(" read(8 bytes)=%s", strerror(errno)); else printf(" read(8 bytes)=%zd bytes", n);
    } else printf(" read=maps not readable");
    if (m) fclose(m);
    close(r);
  }
  errno = 0;
  int w = open(path, O_WRONLY);
  if (w < 0) printf("  open(write)=%s\\n", strerror(errno)); else { printf("  open(write)=OK\\n"); close(w); }
}
int main() {
  long parent = getppid(), grand = 0;
  char sp[64]; snprintf(sp, sizeof sp, "/proc/%ld/stat", parent);
  FILE* f = fopen(sp, "r");
  if (f) { char line[512] = {0}; fgets(line, sizeof line, f); fclose(f); char* p = strrchr(line, ')'); char st; long pp; if (p && sscanf(p + 1, " %c %ld", &st, &pp) == 2) grand = pp; }
  probe("parent (launcher)", parent);
  if (grand > 0) probe("grandparent (handler)", grand); else puts("grandparent: not found");
}`;

module.exports = { OUTBOUND, ENV_PRINT, ENVIRON, PTRACE_SCOPE, PROC_MEM };
