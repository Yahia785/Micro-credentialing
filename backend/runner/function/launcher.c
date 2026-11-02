/*
 * sandbox-launcher: runs one program under hard limits and reports how it ended.
 *
 *   sandbox-launcher MODE RWDIR CPU_S AS_BYTES STACK_BYTES NPROC FSIZE_BYTES NOFILE -- PROG [ARGS...]
 *
 * MODE is "compile" (g++ and its helpers) or "run" (student binary).
 *
 * The launcher forks; the child applies setrlimit, closes every fd above 2, and execve()s PROG
 * with an EMPTY environment ("run") or only TMPDIR/PATH ("compile"). The parent wait4()s the child
 * so the kernel's own accounting gives exact CPU time and peak memory, and writes one line to fd 3:
 *
 *   exit=<code or -1> sig=<signal or 0> cpu_ms=<n> rss_kb=<n> landlock=<0|1> reaped=<leftover processes killed>
 *
 * The launcher is a "subreaper": every descendant the program leaves behind (fork, daemon, setsid
 * escape) is re-parented to it. When the program ends, or on SIGUSR1 from the Node handler (wall-clock
 * timeout), the launcher SIGKILLs and reaps the whole tree, so nothing survives into the next run and no
 * zombie piles up (Lambda reuses warm containers, and zombies count against the process limit).
 *
 * The child restricts its own filesystem access with Landlock (no root needed):
 * read/execute on system directories only, read/write on RWDIR only. That hides /proc, /etc, /var/task
 * etc. from the program. If Landlock cannot be applied the program is NOT run: the child exits 125 and landlock=0 is reported.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

#define LL_EXECUTE (1ULL << 0)
#define LL_WRITE_FILE (1ULL << 1)
#define LL_READ_FILE (1ULL << 2)
#define LL_READ_DIR (1ULL << 3)
#define LL_ALL_V1 ((1ULL << 13) - 1)
#define LL_RULE_PATH_BENEATH 1

struct ll_ruleset_attr { uint64_t handled_access_fs; };
struct ll_path_beneath_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));

static int ll_add(int ruleset, const char *path, uint64_t access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return 0; /* missing path: nothing to allow */
  struct stat st;
  if (fstat(fd, &st) == 0 && !S_ISDIR(st.st_mode)) {
    access &= (LL_EXECUTE | LL_WRITE_FILE | LL_READ_FILE); /* file rules reject directory-only bits */
  }
  struct ll_path_beneath_attr attr = { access, fd };
  int rc = syscall(SYS_landlock_add_rule, ruleset, LL_RULE_PATH_BENEATH, &attr, 0);
  close(fd);
  return rc;
}

static int apply_landlock(int is_compile, const char *rwdir) {
  struct ll_ruleset_attr attr = { LL_ALL_V1 };
  int ruleset = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset < 0) return 0;

  const uint64_t ro = LL_EXECUTE | LL_READ_FILE | LL_READ_DIR;
  int ok = 1;
  ok &= ll_add(ruleset, "/usr", ro) == 0;
  ok &= ll_add(ruleset, "/lib", ro) == 0;
  ok &= ll_add(ruleset, "/lib64", ro) == 0;
  ok &= ll_add(ruleset, "/bin", ro) == 0;
  ok &= ll_add(ruleset, "/sbin", ro) == 0;
  ok &= ll_add(ruleset, "/etc/ld.so.cache", LL_READ_FILE) == 0;
  ok &= ll_add(ruleset, "/dev/null", LL_READ_FILE | LL_WRITE_FILE) == 0;
  if (!is_compile) ok &= ll_add(ruleset, "/dev/urandom", LL_READ_FILE) == 0;
  ok &= ll_add(ruleset, rwdir, LL_ALL_V1) == 0;

  if (!ok || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) {
    close(ruleset);
    return 0;
  }
  close(ruleset);
  return 1;
}

static volatile sig_atomic_t interrupted = 0;
static void on_usr1(int sig) { (void)sig; interrupted = 1; }

/* Kill and reap everything that is our descendant or shares our process group. */
static long kill_and_reap_all(void) {
  long total = 0;
  pid_t self = getpid(), pg = getpgrp();
  for (int iter = 0; iter < 500; iter++) {
    int killed = 0;
    DIR *d = opendir("/proc");
    struct dirent *e;
    while (d && (e = readdir(d)) != NULL) {
      pid_t pid = atoi(e->d_name);
      if (pid <= 0 || pid == self) continue;
      char path[64], buf[512];
      snprintf(path, sizeof(path), "/proc/%d/stat", pid);
      int fd = open(path, O_RDONLY);
      if (fd < 0) continue;
      ssize_t n = read(fd, buf, sizeof(buf) - 1);
      close(fd);
      if (n <= 0) continue;
      buf[n] = 0;
      char *p = strrchr(buf, ')');
      char state;
      int ppid, pgrp;
      if (!p || sscanf(p + 1, " %c %d %d", &state, &ppid, &pgrp) != 3) continue;
      if (ppid == self || pgrp == pg) {
        if (kill(pid, SIGKILL) == 0 && state != 'Z') total++;
        killed++;
      }
    }
    if (d) closedir(d);
    while (waitpid(-1, NULL, WNOHANG) > 0) { /* reap */ }
    if (killed == 0 && waitpid(-1, NULL, WNOHANG) < 0 && errno == ECHILD) return total;
    usleep(2000);
  }
  return total;
}

static void set_limit(int resource, rlim_t soft, rlim_t hard) {
  struct rlimit rl = { soft, hard };
  setrlimit(resource, &rl);
}

int main(int argc, char **argv) {
  if (argc < 11 || strcmp(argv[9], "--") != 0) return 2;
  int is_compile = strcmp(argv[1], "compile") == 0;
  const char *rwdir = argv[2];
  long cpu_s = atol(argv[3]);
  unsigned long as_bytes = strtoul(argv[4], NULL, 10);
  unsigned long stack_bytes = strtoul(argv[5], NULL, 10);
  unsigned long nproc = strtoul(argv[6], NULL, 10);
  unsigned long fsize = strtoul(argv[7], NULL, 10);
  unsigned long nofile = strtoul(argv[8], NULL, 10);
  char **prog_argv = &argv[10];

  prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_usr1; /* no SA_RESTART: wait4 must return EINTR */
  sigaction(SIGUSR1, &sa, NULL);

  int ll_pipe[2];
  if (pipe2(ll_pipe, O_CLOEXEC) != 0) return 3;
  pid_t pid = fork();
  if (pid < 0) return 3;
  if (pid == 0) {
    char ll_ok = apply_landlock(is_compile, rwdir) ? '1' : '0';
    (void)!write(ll_pipe[1], &ll_ok, 1);
    if (ll_ok == '0') _exit(125); /* fail closed: never run the program without the file policy */
    /* stays in the launcher's process group so one kill(-pgid) reaches it and its children */
    set_limit(RLIMIT_CPU, cpu_s, cpu_s + 1); /* soft: SIGXCPU, hard: SIGKILL */
    set_limit(RLIMIT_AS, as_bytes, as_bytes);
    set_limit(RLIMIT_STACK, stack_bytes, stack_bytes);
    set_limit(RLIMIT_NPROC, nproc, nproc);
    set_limit(RLIMIT_FSIZE, fsize, fsize);
    set_limit(RLIMIT_NOFILE, nofile, nofile);
    set_limit(RLIMIT_CORE, 0, 0);
    for (int fd = 3; fd < 1024; fd++) close(fd);
    if (chdir(rwdir) != 0) _exit(126);

    char tmpdir[4200], path[] = "PATH=/usr/bin:/bin";
    char *envp_compile[3];
    char *envp_run[1] = { NULL };
    snprintf(tmpdir, sizeof(tmpdir), "TMPDIR=%s", rwdir);
    envp_compile[0] = tmpdir;
    envp_compile[1] = path;
    envp_compile[2] = NULL;

    execve(prog_argv[0], prog_argv, is_compile ? envp_compile : envp_run);
    _exit(127);
  }

  close(ll_pipe[1]);
  char ll_ok = '0';
  (void)!read(ll_pipe[0], &ll_ok, 1);
  int landlock = ll_ok == '1';

  int status = 0;
  struct rusage ru;
  memset(&ru, 0, sizeof(ru));
  while (wait4(pid, &status, 0, &ru) < 0) {
    if (errno == EINTR && interrupted) {
      kill(pid, SIGKILL);
      continue; /* keep waiting for the (now dying) child so its rusage is collected */
    }
    if (errno != EINTR) return 4;
  }
  long reaped = kill_and_reap_all();

  long cpu_ms = ru.ru_utime.tv_sec * 1000L + ru.ru_utime.tv_usec / 1000 + ru.ru_stime.tv_sec * 1000L + ru.ru_stime.tv_usec / 1000;
  dprintf(3, "exit=%d sig=%d cpu_ms=%ld rss_kb=%ld landlock=%d reaped=%ld\n",
          WIFEXITED(status) ? WEXITSTATUS(status) : -1,
          WIFSIGNALED(status) ? WTERMSIG(status) : 0,
          cpu_ms, ru.ru_maxrss, landlock, reaped);
  return 0;
}
