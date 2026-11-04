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
 *   exit=<code or -1> sig=<signal or 0> cpu_ms=<n> rss_kb=<n> landlock=<0|1> seccomp=<0|1> reaped=<leftover processes killed>
 *   nnp=<failed|set|already> nnp_errno=<n> seccomp_errno=<errno of the seccomp call> subreaper_errno=<errno of PR_SET_CHILD_SUBREAPER>
 *   step=<none|setrlimit|setpgid|chdir|exec|no_report> errno=<errno of the failed step>
 *
 * Fail closed (the program is not run, step is not "none") only when launching it safely is impossible: a resource
 * limit cannot be set, the program's own process group cannot be created, the work folder cannot be entered, the program
 * cannot be executed, or the child never reported.
 * Landlock, seccomp, no_new_privs and CHILD_SUBREAPER are best effort: they are applied when the platform allows it and
 * reported either way. (Standard Lambda runs its own seccomp filter that refuses all of them, and that filter is then
 * the sandbox.) The handler decides what the reported flags mean.
 *
 * The launcher tries to become a "subreaper": every descendant the program leaves behind (fork, daemon, setsid
 * escape) is then re-parented to it. When the program ends, or on SIGUSR1 from the Node handler (wall-clock
 * timeout), the launcher SIGKILLs and reaps the whole tree. Where the platform refuses PR_SET_CHILD_SUBREAPER
 * (Lambda does) orphans go elsewhere; the Node handler then finds and kills them by scanning /proc.
 *
 * Before exec the child sets no_new_privs (skipped when /proc/self/status already shows NoNewPrivs: 1) and then:
 *
 *   - Landlock (optional, needs kernel 5.13+): read/execute on system directories only, read/write on RWDIR
 *     only. That hides /proc, /etc, /var/task etc. from the program.
 *   - seccomp (optional): a filter that makes network, ptrace and a few other system calls fail with EPERM.
 *     The same filter is installed for the compiler ("compile" mode).
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stddef.h>
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

#include "sandbox_filter.h"

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

  /* no_new_privs is already set by the caller (landlock_restrict_self requires it) */
  if (!ok || syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) {
    close(ruleset);
    return 0;
  }
  close(ruleset);
  return 1;
}

/*
 * What the child tells the launcher over a pipe. First a `report` right after the best-effort steps (always sent), then,
 * only if launching fails afterwards, a `failure`. The pipe is close-on-exec, so after a successful exec the launcher
 * simply sees end-of-file instead of a failure.
 */
enum { STEP_NONE = 0, STEP_SETRLIMIT = 1, STEP_CHDIR = 2, STEP_EXEC = 3, STEP_NO_REPORT = 4, STEP_SETPGID = 5 };
enum { NNP_FAILED = 0, NNP_SET = 1, NNP_ALREADY = 2 };
struct report { char landlock; char seccomp; char nnp; int nnp_err; int seccomp_err; };
struct failure { int step; int err; };

static const char *step_name(int step) {
  switch (step) {
    case STEP_NONE: return "none";
    case STEP_SETRLIMIT: return "setrlimit";
    case STEP_CHDIR: return "chdir";
    case STEP_EXEC: return "exec";
    case STEP_SETPGID: return "setpgid";
    default: return "no_report";
  }
}

static const char *nnp_name(int nnp) {
  return nnp == NNP_ALREADY ? "already" : (nnp == NNP_SET ? "set" : "failed");
}

/* True when /proc/self/status already shows NoNewPrivs: 1 (Lambda sets it, and then refuses the prctl with EPERM). */
static int no_new_privs_already_set(void) {
  FILE *f = fopen("/proc/self/status", "r");
  if (!f) return 0;
  char line[256];
  int set = 0;
  while (fgets(line, sizeof(line), f)) {
    if (strncmp(line, "NoNewPrivs:", 11) == 0) { set = atoi(line + 11) == 1; break; }
  }
  fclose(f);
  return set;
}

static volatile sig_atomic_t interrupted = 0;
static void on_usr1(int sig) { (void)sig; interrupted = 1; }

/*
 * Kill and reap everything the program started. The program runs in its own process group (child pgid == child pid), and one
 * kill(-pgid) signals every member atomically, even while a fork bomb is still forking, so this is fast. Anything that
 * escaped the group (setsid, daemons) is found by scanning /proc for our children, which only works when we are a subreaper;
 * otherwise the Node handler's own /proc sweep kills those.
 */
static long kill_and_reap_all(pid_t pgid) {
  long total = 0;
  pid_t self = getpid();
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
      if (state == 'Z') continue; /* only its parent (or init) can reap a zombie: waitpid below, or nobody */
      if (ppid == self || pgrp == pgid) {
        if (kill(pid, SIGKILL) == 0) total++;
        killed++;
      }
    }
    if (d) closedir(d);
    kill(-pgid, SIGKILL); /* the whole group again, atomically: nothing that is forking right now survives this */
    while (waitpid(-1, NULL, WNOHANG) > 0) { /* reap */ }
    if (killed == 0 && waitpid(-1, NULL, WNOHANG) < 0 && errno == ECHILD) return total;
    usleep(2000);
  }
  return total;
}

/* Returns 0, or the errno of the failed setrlimit. */
static int set_limit(int resource, rlim_t soft, rlim_t hard) {
  struct rlimit rl = { soft, hard };
  return setrlimit(resource, &rl) == 0 ? 0 : errno;
}

/* Tell the launcher why the program could not be started, then stop (the launcher reports it; nothing was run). */
static void child_fail(int fd, int step, int err) {
  struct failure f = { step, err };
  (void)!write(fd, &f, sizeof(f));
  _exit(125);
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

  int subreaper_errno = prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0 ? 0 : errno; /* reported, not fatal */
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_usr1; /* no SA_RESTART: wait4 must return EINTR */
  sigaction(SIGUSR1, &sa, NULL);

  int ll_pipe[2];
  if (pipe2(ll_pipe, O_CLOEXEC) != 0) return 3;
  pid_t pid = fork();
  if (pid < 0) return 3;
  if (pid == 0) {
    struct report rep;
    memset(&rep, 0, sizeof(rep));
    if (no_new_privs_already_set()) {
      rep.nnp = NNP_ALREADY; /* do not call prctl: Lambda refuses it with EPERM even though the bit is set */
    } else if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0) {
      rep.nnp = NNP_SET;
    } else {
      rep.nnp = NNP_FAILED;
      rep.nnp_err = errno;
    }
    if (rep.nnp != NNP_FAILED) { /* both need no_new_privs */
      rep.landlock = apply_landlock(is_compile, rwdir) ? 1 : 0; /* optional */
      if (install_seccomp()) rep.seccomp = 1;                    /* optional */
      else rep.seccomp_err = errno;
    }
    (void)!write(ll_pipe[1], &rep, sizeof(rep));

    /* own process group: the launcher kills the whole group with one kill(-pgid) */
    if (setpgid(0, 0) != 0) child_fail(ll_pipe[1], STEP_SETPGID, errno);
    int e;
    if ((e = set_limit(RLIMIT_CPU, cpu_s, cpu_s + 1)) != 0) child_fail(ll_pipe[1], STEP_SETRLIMIT, e); /* soft: SIGXCPU, hard: SIGKILL */
    if ((e = set_limit(RLIMIT_AS, as_bytes, as_bytes)) != 0) child_fail(ll_pipe[1], STEP_SETRLIMIT, e);
    if ((e = set_limit(RLIMIT_STACK, stack_bytes, stack_bytes)) != 0) child_fail(ll_pipe[1], STEP_SETRLIMIT, e);
    if ((e = set_limit(RLIMIT_NPROC, nproc, nproc)) != 0) child_fail(ll_pipe[1], STEP_SETRLIMIT, e);
    if ((e = set_limit(RLIMIT_FSIZE, fsize, fsize)) != 0) child_fail(ll_pipe[1], STEP_SETRLIMIT, e);
    if ((e = set_limit(RLIMIT_NOFILE, nofile, nofile)) != 0) child_fail(ll_pipe[1], STEP_SETRLIMIT, e);
    if ((e = set_limit(RLIMIT_CORE, 0, 0)) != 0) child_fail(ll_pipe[1], STEP_SETRLIMIT, e);
    for (int fd = 3; fd < 1024; fd++) if (fd != ll_pipe[1]) close(fd);
    if (chdir(rwdir) != 0) child_fail(ll_pipe[1], STEP_CHDIR, errno);

    char tmpdir[4200], path[] = "PATH=/usr/bin:/bin";
    char *envp_compile[3];
    char *envp_run[1] = { NULL };
    snprintf(tmpdir, sizeof(tmpdir), "TMPDIR=%s", rwdir);
    envp_compile[0] = tmpdir;
    envp_compile[1] = path;
    envp_compile[2] = NULL;

    execve(prog_argv[0], prog_argv, is_compile ? envp_compile : envp_run);
    child_fail(ll_pipe[1], STEP_EXEC, errno); /* only reached when exec failed */
  }

  close(ll_pipe[1]);
  setpgid(pid, pid); /* same call as the child makes: whichever runs first wins, so the group exists before we may kill it */
  struct report rep;
  memset(&rep, 0, sizeof(rep));
  int step = STEP_NONE, step_err = 0;
  if (read(ll_pipe[0], &rep, sizeof(rep)) != (ssize_t)sizeof(rep)) {
    memset(&rep, 0, sizeof(rep));
    step = STEP_NO_REPORT;
  }
  int landlock = rep.landlock;
  int seccomp = rep.seccomp;

  int status = 0;
  struct rusage ru;
  memset(&ru, 0, sizeof(ru));
  while (wait4(pid, &status, 0, &ru) < 0) {
    if (errno == EINTR && interrupted) {
      kill(-pid, SIGKILL); /* the program's whole group */
      continue; /* keep waiting for the (now dying) child so its rusage is collected */
    }
    if (errno != EINTR) return 4;
  }
  long reaped = kill_and_reap_all(pid);

  /* A launch failure (setrlimit, chdir, exec) arrives on the pipe before the child exits; success closes the pipe. */
  fcntl(ll_pipe[0], F_SETFL, fcntl(ll_pipe[0], F_GETFL) | O_NONBLOCK);
  struct failure fl;
  if (step == STEP_NONE && read(ll_pipe[0], &fl, sizeof(fl)) == (ssize_t)sizeof(fl)) {
    step = fl.step;
    step_err = fl.err;
  }

  long cpu_ms = ru.ru_utime.tv_sec * 1000L + ru.ru_utime.tv_usec / 1000 + ru.ru_stime.tv_sec * 1000L + ru.ru_stime.tv_usec / 1000;
  dprintf(3, "exit=%d sig=%d cpu_ms=%ld rss_kb=%ld landlock=%d seccomp=%d reaped=%ld nnp=%s nnp_errno=%d seccomp_errno=%d subreaper_errno=%d step=%s errno=%d\n",
          WIFEXITED(status) ? WEXITSTATUS(status) : -1,
          WIFSIGNALED(status) ? WTERMSIG(status) : 0,
          cpu_ms, ru.ru_maxrss, landlock, seccomp, reaped,
          nnp_name(rep.nnp), rep.nnp_err, rep.seccomp_err, subreaper_errno, step_name(step), step_err);
  return 0;
}
