# Security of the C++ runner

This document describes how the runner (the Lambda in `backend/runner/`) protects the platform from the code students
submit, and, just as important, what it does **not** protect against. The goal is "secure enough for a sophomore
course", not "bulletproof". The design follows what other Lambda-based judges do (for example the cpinitiative online
judge and LambdaJudge): the Lambda itself is the sandbox, the credentials the sandbox holds are made worthless instead of
hidden, and the runner never learns the answers.

## 1. What we are defending against

**The attacker** is a student who can submit any C++ program. The program is compiled and run by the runner, so the student
controls code that executes inside our AWS account, as well as the compiler's input.

**What the student might try**

| Goal | Example |
|---|---|
| Steal secrets | read the runner's AWS credentials, other students' code, the answer key |
| Reach other systems | call the internet, the Lambda Runtime API, other AWS services, our database |
| Cheat the grader | make a wrong program pass, change the verdict of someone else's submission |
| Break the service | infinite loops, memory or fork bombs, huge output, filling the disk, killing the handler |
| Persist | leave something behind that affects the next submission run in the same container |

**Out of scope.** Flaws in AWS itself (the Lambda / Firecracker isolation), a malicious instructor or administrator, a
compromised backend, timing and CPU side channels, and ordinary academic dishonesty (plagiarism, sharing solutions). Test
*inputs* are visible to the program on purpose; that is how a program reads its input.

## 2. How the runner is built

1. **The Lambda is the sandbox.** Every invocation runs in an AWS Lambda execution environment, which is a
   Firecracker micro-VM, as an unprivileged user (not root). The runner is its own function and its own stack, separate
   from the rest of the backend. It has no environment variables and no secrets of its own.
2. **No network.** The function lives in a VPC with private subnets only: no NAT gateway, no internet gateway, no VPC
   endpoints, and a security group whose only outbound rule points at `127.0.0.1/32`, so nothing can leave.
3. **The expected output never enters the runner.** The runner receives `{ source, runs: [{ stdin }], timeLimitMs,
   memoryLimitKb }` and answers with what the program printed. `accepted` only means "the program ran fine". The
   comparison with the expected output happens in the backend (`shared/nodejs/utils/codeRunnerOwn.js`, rule in
   `outputCompare.js`, identical to Judge0's), which turns a mismatch into `wrong_answer`. An event that contains
   `expectedOutput` is **rejected** by the runner, not ignored. So even a student who completely takes over the runner
   finds no answer key there.
4. **System-call filter (seccomp, required).** Right before the program starts, the launcher sets `no_new_privs` and
   installs a seccomp filter that makes these system calls fail with `EPERM` (the program is not killed, it just gets
   an error): `socket, socketpair, connect, bind, listen, accept, accept4, sendto, sendmsg, recvfrom, recvmsg` (no network
   of any kind, including local sockets, so the Lambda Runtime API at `127.0.0.1:9001` is unreachable), `ptrace,
   process_vm_readv, process_vm_writev` (no debugging of other processes), `mount, unshare, setns` (no namespace or
   mount tricks), `keyctl, add_key, request_key, bpf, perf_event_open, userfaultfd, io_uring_setup` (kernel features
   that are common exploit surface). The filter also checks the architecture (a 32-bit `int 0x80` call is killed) and
   the x32 system-call range (answered with `EPERM`), so the list cannot be bypassed by calling the same service
   through another ABI. **The same filter is installed for the compiler.**
   **It fails closed:** if the filter cannot be installed, nothing runs and every run returns `internal_error`
   "sandbox unavailable" with `diagnostics.seccomp: false`.
5. **Worthless credentials.** The function's execution role can only write to its own log group and use the network
   interface actions Lambda needs to put a function in a VPC. On top of that it has an explicit **Deny** on those network
   interface actions whenever the request carries `lambda:SourceFunctionArn` equal to the runner (AWS sets that on
   requests made with the function's own credentials; this is AWS's documented way to stop function code from using
   them; Lambda's own networking does not carry it and keeps working). Nothing else is allowed: no S3, DynamoDB,
   Secrets Manager, Lambda, IAM. A student who finds the credentials can do almost nothing with them (see limits).
6. **Resource limits for every run** (set by the launcher with `setrlimit`, so the kernel enforces them): CPU time, address
   space (memory), stack, number of processes, file size, open files, no core dumps. On top: a wall-clock kill at twice the
   time limit, at most 1 MB of output (more is a runtime error), 64 KB of compiler output and of stderr, 5 MB for the whole
   reply, and the function's own 30-second timeout. Compilation has its own CPU, memory and time limits and
   `-fmax-errors=50`, which stops compile-time bombs (template recursion, macro explosions, `constexpr` loops).
7. **Clean slate for every run.** The program starts with an **empty environment** (no `AWS_*` variables). Every process
   it leaves behind (fork bombs, daemons, `setsid` escapes) is found and killed, the launcher reaps the whole tree, and
   `/tmp` is emptied before and after every call, because Lambda reuses a container for later calls.
8. **Landlock file policy (optional).** If the kernel supports Landlock (5.13 or newer), the program can only read system
   directories and read/write its own work folder, which hides `/proc`, `/etc` and the runner's code. Standard Lambda
   currently runs kernel 5.10, so **this protection is not active there**. The runner uses it automatically when it is
   there and reports `diagnostics.landlock`. It is no longer required, because the security model does not depend on it.

## 3. How we check it

* `test/hostile.js`: 37 hostile programs run in a Docker container with no network, a read-only file system and the same
  limits as Lambda: infinite loops, sleeping, memory bombs, fork bombs, output floods, sockets and `curl`, reading
  `/proc` and `/etc`, writing outside the work folder, stack overflow, killing the launcher or the handler, daemons,
  compile-time bombs, and a program that tries every denied system call. Each must end with the expected status, leave
  no process and no file behind, and the next call must be healthy. The corpus is also run with Landlock switched off,
  which is what Lambda looks like.
* Both fail-closed paths and the "no Landlock" path are tested (`test/failclosed.test.js`, `test/run-failclosed.js`).
* `test/run-deployed.js` checks the **deployed** function: seccomp is on; sockets to `1.1.1.1:443`,
  `169.254.100.1:9001` and `127.0.0.1:9001` fail; the program sees no AWS variables; no event ever contains
  `expectedOutput` and the runner refuses one that does; IAM simulation shows the network-interface deny and that S3,
  DynamoDB and Secrets Manager are denied; and the whole hostile corpus passes.

## 4. What is NOT protected (read this before trusting the runner)

These are known, accepted limits.

1. **Student code can read and write the memory of the runner's own process.** On standard Lambda there is no Landlock, and
   the student's program runs as the same user as the Node handler. Blocking `ptrace` does not close `/proc/<pid>/mem`.
   Consequences: the program can read the handler's environment (the role's temporary credentials, see 3), the inputs of the
   current call, and it can **change the handler's behaviour**. The most serious case is persistence: a warm Lambda
   container is reused, so a student who patches the handler could try to affect the next submission (leak its source code
   or change its result) until the container is recycled. Impact is bounded because the runner holds no answer key and no
   secrets, but it is a real academic-integrity risk. A cheap improvement, not implemented: end the handler's process after
   every call so Lambda starts a fresh one (costs some warm-up per call). The cleanest fix is a kernel with Landlock or a
   different runtime that can use a separate user.
2. **The credentials are readable, only worthless.** A student can print the role's temporary credentials (they come back
   in the output). The only things they allow are writing log lines to the runner's own log group (log spam and a little
   cost, no reading) for the few hours the credentials last. They cannot be used to create or change network interfaces
   (explicit deny), and they allow nothing else. Writing logs from inside the sandbox is impossible anyway (no network).
3. **The file system is readable.** Without Landlock the program can read any file that the Lambda user can read: the runner's
   code in `/var/task`, `/etc`, `/proc`. None of these hold secrets other than the credentials above, and `#include
   "/proc/..."` can print them in a compile error. The root file system is read-only, so writes are limited to `/tmp`, which
   is cleaned between calls.
4. **The system-call filter is a deny list.** It removes the network, debugging and a few large exploit surfaces, but the
   Linux kernel has many other system calls. A kernel exploit is not prevented by this filter. If one succeeds the attacker is
   root inside the Lambda micro-VM, which holds only the worthless credentials, and AWS's own isolation is the next
   boundary (out of scope here). In particular, creating a new user namespace with `clone` is not blocked.
5. **Denial of service is limited, not prevented.** One submission can occupy one container for up to the function's 30-second
   timeout with 1769 MB of memory. Many submissions in parallel cost money and can hit the account's Lambda concurrency
   limit. Use reserved concurrency and AWS budget alarms for the runner if the course is large.
6. **The output is a channel.** A program can print anything it can read (for example the credentials, or other files) and the
   student sees it. Test inputs are visible to the program by design; hidden test *inputs* are therefore visible to a
   submission that is run against them, but expected outputs are not.
7. **A student can know the expected output of a public test** and print it (hard-coding). This is a problem of course design
   (use hidden tests), not of the sandbox.
8. **Side channels and AWS-level attacks** (CPU timing, shared hardware, a flaw in Firecracker) are not addressed.

## 5. If you want to tighten it later

* End the Node process after every call to throw away any in-memory tampering (limit 1).
* Use a kernel with Landlock if Lambda offers one (the runner switches it on by itself) or run the program under a
  different user.
* Add `clone`/`clone3` filtering for new user namespaces and move from a deny list to an allow list.
* Reserved concurrency and a budget alarm for the runner (limit 5).
* A tiny account for the runner and its logs, so a leak can never reach other resources.
