/*
 * sandbox-probe: finds out which sandbox steps the platform allows, each with success or errno. No student code is
 * involved. Used by the handler's diagnose mode ({ "diagnose": true }).
 *
 *   sandbox-probe run     run every probe in this process tree and print one JSON line {"results":[...]}
 *   sandbox-probe relay   fork and exec "sandbox-probe run" (so the probe runs as a grandchild of whoever started the relay)
 *
 * Every probe runs in its own forked child, so one probe cannot change the state another one sees (for example a
 * seccomp filter or a lowered resource limit), and a probe that gets killed by a signal is reported instead of
 * ending the whole run. Results: { name, ok, errno, err, detail }.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <unistd.h>

#include "sandbox_filter.h"

#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef PR_SET_CHILD_SUBREAPER
#define PR_SET_CHILD_SUBREAPER 36
#endif
#ifndef PR_GET_CHILD_SUBREAPER
#define PR_GET_CHILD_SUBREAPER 37
#endif
#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif
#ifndef PR_GET_NO_NEW_PRIVS
#define PR_GET_NO_NEW_PRIVS 39
#endif

#define DETAIL 240
struct result { char name[96]; int ok; int err; char detail[DETAIL]; };

static pid_t g_parent; /* the process that started this probe: its /proc/<pid>/mem is what we try to open */

static const char *errno_name(int e) {
  switch (e) {
    case 0: return "";
    case EPERM: return "EPERM";
    case EACCES: return "EACCES";
    case EINVAL: return "EINVAL";
    case ENOSYS: return "ENOSYS";
    case EFAULT: return "EFAULT";
    case ENOENT: return "ENOENT";
    case ESRCH: return "ESRCH";
    case EBUSY: return "EBUSY";
    case EAGAIN: return "EAGAIN";
    case ENOMEM: return "ENOMEM";
    case EOPNOTSUPP: return "EOPNOTSUPP";
    default: return "";
  }
}

typedef int (*probe_fn)(char *detail, size_t n); /* returns 0 on success, otherwise the errno */

/* Run fn in a forked child and collect its result through a pipe. */
static void run_probe(struct result *out, const char *name, probe_fn fn) {
  memset(out, 0, sizeof(*out));
  snprintf(out->name, sizeof(out->name), "%s", name);
  int fds[2];
  if (pipe(fds) != 0) { out->err = errno; snprintf(out->detail, DETAIL, "pipe failed"); return; }
  pid_t pid = fork();
  if (pid < 0) { out->err = errno; snprintf(out->detail, DETAIL, "fork failed"); close(fds[0]); close(fds[1]); return; }
  if (pid == 0) {
    close(fds[0]);
    struct result r;
    memset(&r, 0, sizeof(r));
    int rc = fn(r.detail, DETAIL);
    r.ok = rc == 0;
    r.err = rc;
    (void)!write(fds[1], &r, sizeof(r));
    _exit(0);
  }
  close(fds[1]);
  struct result r;
  ssize_t got = read(fds[0], &r, sizeof(r));
  close(fds[0]);
  int status = 0;
  waitpid(pid, &status, 0);
  if (got == (ssize_t)sizeof(r)) {
    snprintf(r.name, sizeof(r.name), "%s", name);
    *out = r;
  } else if (WIFSIGNALED(status)) {
    out->err = -WTERMSIG(status);
    snprintf(out->detail, DETAIL, "probe was killed by signal %d", WTERMSIG(status));
  } else {
    out->err = -1;
    snprintf(out->detail, DETAIL, "probe produced no result");
  }
}

/* ---- the probes ---- */

static struct sock_filter allow_all[] = { BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW) };
static struct sock_fprog allow_all_prog = { .len = 1, .filter = allow_all };

static int p_no_new_privs(char *d, size_t n) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return errno;
  snprintf(d, n, "PR_GET_NO_NEW_PRIVS=%d", prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
  return 0;
}

static int seccomp_allow_all(unsigned flags, int set_nnp, char *d, size_t n) {
  if (set_nnp && prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) { snprintf(d, n, "could not set no_new_privs first"); return errno; }
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, flags, &allow_all_prog) != 0) return errno;
  snprintf(d, n, "installed");
  return 0;
}
static int p_seccomp_flags0(char *d, size_t n) { return seccomp_allow_all(0, 1, d, n); }
static int p_seccomp_tsync(char *d, size_t n) { return seccomp_allow_all(SECCOMP_FILTER_FLAG_TSYNC, 1, d, n); }
static int p_seccomp_log(char *d, size_t n) { return seccomp_allow_all(SECCOMP_FILTER_FLAG_LOG, 1, d, n); }
static int p_seccomp_spec(char *d, size_t n) { return seccomp_allow_all(SECCOMP_FILTER_FLAG_SPEC_ALLOW, 1, d, n); }
static int p_seccomp_without_nnp(char *d, size_t n) {
  int rc = seccomp_allow_all(0, 0, d, n);
  if (rc == 0) snprintf(d, n, "installed without setting no_new_privs first (it may already be set by the platform)");
  return rc;
}

static int p_prctl_seccomp(char *d, size_t n) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) { snprintf(d, n, "could not set no_new_privs first"); return errno; }
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &allow_all_prog, 0, 0) != 0) return errno;
  snprintf(d, n, "installed");
  return 0;
}

static int p_real_filter(char *d, size_t n) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) { snprintf(d, n, "could not set no_new_privs first"); return errno; }
  if (!install_seccomp()) return errno;
  errno = 0;
  int s = socket(AF_INET, SOCK_STREAM, 0);
  snprintf(d, n, "installed; socket() afterwards: %s", s < 0 ? (errno == EPERM ? "EPERM (denied, as designed)" : strerror(errno)) : "WORKED (filter not effective)");
  if (s >= 0) { close(s); return EINVAL; }
  return 0;
}

static int p_subreaper(char *d, size_t n) {
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) return errno;
  int v = -1;
  prctl(PR_GET_CHILD_SUBREAPER, &v, 0, 0, 0);
  snprintf(d, n, "PR_GET_CHILD_SUBREAPER=%d", v);
  return 0;
}

static int p_pdeathsig(char *d, size_t n) {
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) return errno;
  int v = -1;
  prctl(PR_GET_PDEATHSIG, &v, 0, 0, 0);
  snprintf(d, n, "PR_GET_PDEATHSIG=%d", v);
  return 0;
}

static int p_dumpable(char *d, size_t n) {
  int before = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) { snprintf(d, n, "dumpable before=%d", before); return errno; }
  snprintf(d, n, "dumpable before=%d after=%d", before, prctl(PR_GET_DUMPABLE, 0, 0, 0, 0));
  return 0;
}

static int p_landlock_abi(char *d, size_t n) {
  long v = syscall(SYS_landlock_create_ruleset, NULL, 0, 1UL << 0); /* LANDLOCK_CREATE_RULESET_VERSION */
  if (v < 0) return errno;
  snprintf(d, n, "Landlock ABI version %ld", v);
  return 0;
}

static int p_landlock_create(char *d, size_t n) {
  struct { uint64_t handled_access_fs; } attr = { (1ULL << 13) - 1 };
  long fd = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (fd < 0) return errno;
  close((int)fd);
  snprintf(d, n, "ruleset created");
  return 0;
}

static int set_limit(int resource, rlim_t soft, rlim_t hard, char *d, size_t n) {
  struct rlimit before;
  getrlimit(resource, &before);
  struct rlimit rl = { soft, hard };
  if (setrlimit(resource, &rl) != 0) {
    snprintf(d, n, "current soft=%llu hard=%llu", (unsigned long long)before.rlim_cur, (unsigned long long)before.rlim_max);
    return errno;
  }
  snprintf(d, n, "was soft=%llu hard=%llu", (unsigned long long)before.rlim_cur, (unsigned long long)before.rlim_max);
  return 0;
}
#define MB (1024UL * 1024UL)
static int p_rl_cpu(char *d, size_t n) { return set_limit(RLIMIT_CPU, 5, 6, d, n); }
static int p_rl_as(char *d, size_t n) { return set_limit(RLIMIT_AS, 1400 * MB, 1400 * MB, d, n); }
static int p_rl_stack(char *d, size_t n) { return set_limit(RLIMIT_STACK, 64 * MB, 64 * MB, d, n); }
static int p_rl_nproc(char *d, size_t n) { return set_limit(RLIMIT_NPROC, 200, 200, d, n); }
static int p_rl_fsize(char *d, size_t n) { return set_limit(RLIMIT_FSIZE, 16 * MB, 16 * MB, d, n); }
static int p_rl_nofile(char *d, size_t n) { return set_limit(RLIMIT_NOFILE, 64, 64, d, n); }
static int p_rl_core(char *d, size_t n) { return set_limit(RLIMIT_CORE, 0, 0, d, n); }

static int p_setpgid(char *d, size_t n) {
  if (setpgid(0, 0) != 0) return errno;
  snprintf(d, n, "pgid=%d", (int)getpgrp());
  return 0;
}
static int p_setsid(char *d, size_t n) {
  pid_t s = setsid();
  if (s < 0) return errno;
  snprintf(d, n, "sid=%d", (int)s);
  return 0;
}

static int p_traceme(char *d, size_t n) {
  (void)d; (void)n;
  if (ptrace(PTRACE_TRACEME, 0, 0, 0) != 0) return errno;
  return 0;
}

static int p_yama(char *d, size_t n) {
  FILE *f = fopen("/proc/sys/kernel/yama/ptrace_scope", "r");
  if (!f) { snprintf(d, n, "file not readable (no Yama, or hidden)"); return errno; }
  char b[32] = {0};
  if (fgets(b, sizeof(b), f)) { b[strcspn(b, "\n")] = 0; snprintf(d, n, "ptrace_scope=%s", b); }
  fclose(f);
  return 0;
}

static int p_mem(int flags, char *d, size_t n) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/%d/mem", (int)g_parent);
  int fd = open(path, flags);
  if (fd < 0) { snprintf(d, n, "%s", path); return errno; }
  if ((flags & O_ACCMODE) == O_RDONLY) {
    char mp[64], buf[8];
    snprintf(mp, sizeof(mp), "/proc/%d/maps", (int)g_parent);
    FILE *m = fopen(mp, "r");
    unsigned long start = 0, end = 0;
    char perms[8] = {0};
    if (m && fscanf(m, "%lx-%lx %7s", &start, &end, perms) == 3 && perms[0] == 'r') {
      ssize_t got = pread(fd, buf, sizeof(buf), (off_t)start);
      if (got < 0) snprintf(d, n, "%s opened; reading 8 bytes: %s", path, strerror(errno));
      else snprintf(d, n, "%s opened; read %zd bytes", path, got);
    } else {
      snprintf(d, n, "%s opened; maps not readable", path);
    }
    if (m) fclose(m);
  } else {
    snprintf(d, n, "%s opened for writing (nothing written)", path);
  }
  close(fd);
  return 0;
}
static int p_mem_read(char *d, size_t n) { return p_mem(O_RDONLY, d, n); }
static int p_mem_write(char *d, size_t n) { return p_mem(O_WRONLY, d, n); }

static int p_uname(char *d, size_t n) {
  struct utsname u;
  if (uname(&u) != 0) return errno;
  snprintf(d, n, "%s", u.release);
  return 0;
}

/*
 * Does whoever adopts orphans (PID 1 on Lambda, since PR_SET_CHILD_SUBREAPER is refused) reap them? A -> B, B exits first
 * (a zombie, as A does not wait), then A exits: B is re-parented. If it is still a zombie 400 ms later, nobody reaps it,
 * and every orphaned child of a student program (a fork bomb) stays a zombie that uses up RLIMIT_NPROC.
 */
static int p_orphan_reaped(char *d, size_t n) {
  int fds[2];
  if (pipe(fds) != 0) return errno;
  pid_t a = fork();
  if (a < 0) return errno;
  if (a == 0) {
    close(fds[0]);
    pid_t b = fork();
    if (b == 0) _exit(0);
    (void)!write(fds[1], &b, sizeof(b));
    _exit(0); /* without waiting for b */
  }
  close(fds[1]);
  pid_t b = 0;
  (void)!read(fds[0], &b, sizeof(b));
  close(fds[0]);
  waitpid(a, NULL, 0);
  usleep(400 * 1000);
  char path[64], buf[256];
  snprintf(path, sizeof(path), "/proc/%d/stat", (int)b);
  FILE *f = fopen(path, "r");
  char comm1[64] = "?";
  FILE *p1 = fopen("/proc/1/comm", "r");
  if (p1) { if (fgets(comm1, sizeof(comm1), p1)) comm1[strcspn(comm1, "\n")] = 0; fclose(p1); }
  if (!f) { snprintf(d, n, "orphan zombie was reaped (PID 1 is %s)", comm1); return 0; }
  char state = '?';
  if (fgets(buf, sizeof(buf), f)) { char *p = strrchr(buf, ')'); if (p) state = p[2]; }
  fclose(f);
  if (state == 'Z') { snprintf(d, n, "orphan zombie %d is still a zombie after 400 ms: PID 1 (%s) does not reap", (int)b, comm1); return ECHILD; }
  snprintf(d, n, "orphan %d is gone or alive (state %c; PID 1 is %s)", (int)b, state, comm1);
  return 0;
}

/* The Seccomp / NoNewPrivs / Cap lines of /proc/self/status, on one line. */
static int p_status(char *d, size_t n) {
  FILE *f = fopen("/proc/self/status", "r");
  if (!f) return errno;
  char line[256];
  size_t used = 0;
  d[0] = 0;
  while (fgets(line, sizeof(line), f)) {
    if (strncmp(line, "Seccomp", 7) == 0 || strncmp(line, "NoNewPrivs", 10) == 0 || strncmp(line, "CapEff", 6) == 0) {
      line[strcspn(line, "\n")] = 0;
      for (char *c = line; *c; c++) if (*c == '\t') *c = ' ';
      int w = snprintf(d + used, n - used, "%s%s", used ? "; " : "", line);
      if (w < 0 || (size_t)w >= n - used) break;
      used += (size_t)w;
    }
  }
  fclose(f);
  return 0;
}

/* ---- JSON output ---- */

static void json_string(const char *s) {
  putchar('"');
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
    else if (c < 0x20) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}

static int do_run(void) {
  g_parent = getppid();
  struct { const char *name; probe_fn fn; } probes[] = {
    { "/proc/self/status: Seccomp, NoNewPrivs, CapEff", p_status },
    { "uname -r", p_uname },
    { "orphaned zombies are reaped by PID 1", p_orphan_reaped },
    { "prctl(PR_SET_NO_NEW_PRIVS)", p_no_new_privs },
    { "seccomp(SET_MODE_FILTER) allow-all, flags=0 [launcher uses this]", p_seccomp_flags0 },
    { "seccomp(SET_MODE_FILTER) allow-all, flags=TSYNC [launcher does not use]", p_seccomp_tsync },
    { "seccomp(SET_MODE_FILTER) allow-all, flags=LOG [launcher does not use]", p_seccomp_log },
    { "seccomp(SET_MODE_FILTER) allow-all, flags=SPEC_ALLOW [launcher does not use]", p_seccomp_spec },
    { "seccomp(SET_MODE_FILTER) allow-all, without no_new_privs", p_seccomp_without_nnp },
    { "prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER) allow-all", p_prctl_seccomp },
    { "seccomp(SET_MODE_FILTER) the launcher's real filter", p_real_filter },
    { "prctl(PR_SET_CHILD_SUBREAPER)", p_subreaper },
    { "prctl(PR_SET_PDEATHSIG)", p_pdeathsig },
    { "prctl(PR_SET_DUMPABLE, 0)", p_dumpable },
    { "landlock_create_ruleset (ABI version)", p_landlock_abi },
    { "landlock_create_ruleset (create)", p_landlock_create },
    { "setrlimit(RLIMIT_CPU)", p_rl_cpu },
    { "setrlimit(RLIMIT_AS)", p_rl_as },
    { "setrlimit(RLIMIT_STACK)", p_rl_stack },
    { "setrlimit(RLIMIT_NPROC)", p_rl_nproc },
    { "setrlimit(RLIMIT_FSIZE)", p_rl_fsize },
    { "setrlimit(RLIMIT_NOFILE)", p_rl_nofile },
    { "setrlimit(RLIMIT_CORE)", p_rl_core },
    { "setpgid(0, 0)", p_setpgid },
    { "setsid()", p_setsid },
    { "ptrace(PTRACE_TRACEME)", p_traceme },
    { "/proc/sys/kernel/yama/ptrace_scope", p_yama },
    { "open(/proc/<parent>/mem, read)", p_mem_read },
    { "open(/proc/<parent>/mem, write)", p_mem_write },
  };
  size_t count = sizeof(probes) / sizeof(probes[0]);

  printf("{\"pid\":%d,\"ppid\":%d,\"results\":[", (int)getpid(), (int)g_parent);
  for (size_t i = 0; i < count; i++) {
    struct result r;
    run_probe(&r, probes[i].name, probes[i].fn);
    printf("%s{\"name\":", i ? "," : "");
    json_string(r.name);
    printf(",\"ok\":%s,\"errno\":%d,\"err\":", r.ok ? "true" : "false", r.err);
    json_string(r.ok ? "" : (errno_name(r.err)[0] ? errno_name(r.err) : (r.err > 0 ? strerror(r.err) : "")));
    printf(",\"detail\":");
    json_string(r.detail);
    printf("}");
  }
  printf("]}\n");
  fflush(stdout);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "run") == 0) return do_run();
  if (argc >= 2 && strcmp(argv[1], "relay") == 0) {
    pid_t pid = fork();
    if (pid < 0) return 1;
    if (pid == 0) {
      execl("/proc/self/exe", argv[0], "run", (char *)NULL);
      _exit(127);
    }
    int status = 0;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
  }
  fprintf(stderr, "usage: sandbox-probe run|relay\n");
  return 2;
}
