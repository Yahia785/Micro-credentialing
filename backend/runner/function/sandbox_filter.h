/*
 * The seccomp filter the launcher installs on the student program and on the compiler. It lives in a header so that
 * sandbox-probe (the diagnose tool) tests exactly the same code. install_seccomp() returns 1 on success; on failure it
 * returns 0 and errno holds the error of the seccomp(2) call.
 */
#ifndef SANDBOX_FILTER_H
#define SANDBOX_FILTER_H

#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif
#ifndef SECCOMP_SET_MODE_FILTER
#define SECCOMP_SET_MODE_FILTER 1
#endif
#ifndef SYS_io_uring_setup
#define SYS_io_uring_setup 425 /* same number on x86_64 and aarch64 */
#endif
#ifndef SYS_userfaultfd
#define SYS_userfaultfd 323
#endif

#if defined(__x86_64__)
#define AUDIT_ARCH_CURRENT AUDIT_ARCH_X86_64
#define X32_SYSCALL_BIT 0x40000000U /* x32 ABI numbers would slip past the number checks below */
#elif defined(__aarch64__)
#define AUDIT_ARCH_CURRENT AUDIT_ARCH_AARCH64
#else
#error "seccomp filter: unsupported architecture"
#endif

/* System calls the program (and the compiler) may not make. They fail with EPERM instead of killing the process. */
static const int denied_syscalls[] = {
  SYS_socket, SYS_socketpair, SYS_connect, SYS_bind, SYS_listen, SYS_accept, SYS_accept4,
  SYS_sendto, SYS_sendmsg, SYS_recvfrom, SYS_recvmsg,
  SYS_ptrace, SYS_process_vm_readv, SYS_process_vm_writev,
  SYS_mount, SYS_unshare, SYS_setns,
  SYS_keyctl, SYS_add_key, SYS_request_key,
  SYS_bpf, SYS_perf_event_open, SYS_userfaultfd, SYS_io_uring_setup
};

/*
 * Filter layout:  check arch (other arch, e.g. 32-bit int 0x80, kills the process) -> load syscall number ->
 * [x32 range -> EPERM] -> one compare per denied number (match -> EPERM) -> otherwise allow.
 * Uses the seccomp(2) system call directly, no libseccomp.
 */
static int install_seccomp(void) {
  const unsigned n = sizeof(denied_syscalls) / sizeof(denied_syscalls[0]);
  struct sock_filter f[n + 8];
  unsigned i = 0;

  f[i++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  f[i++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_CURRENT, 1, 0);
  f[i++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  f[i++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
  unsigned first_jump = i;
#ifdef X32_SYSCALL_BIT
  f[i++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, X32_SYSCALL_BIT, 0, 0);
#endif
  for (unsigned j = 0; j < n; j++) {
    f[i++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned)denied_syscalls[j], 0, 0);
  }
  unsigned allow = i;
  f[i++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  unsigned deny = i;
  f[i++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA));
  for (unsigned k = first_jump; k < allow; k++) f[k].jt = (unsigned char)(deny - k - 1);

  struct sock_fprog prog = { .len = (unsigned short)i, .filter = f };
  return syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) == 0;
}

#endif
