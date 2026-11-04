# Security of the C++ runner

This document describes how the runner (the Lambda in `backend/runner/`) protects the platform from the code students
submit, and, just as important, what it does **not** protect against. The goal is "secure enough for a sophomore
course", not "bulletproof". The design follows what other Lambda-based judges do (for example the cpinitiative online
judge and LambdaJudge): **the Lambda itself is the sandbox**, the credentials it holds are **made worthless instead of
hidden**, the runner **never learns the answers**, and **every call runs in a fresh process** (with Lambda's tenant isolation on top when the account allows it).

## 1. What we are defending against

**The attacker** is a student who can submit any C++ program. The program is compiled and run by the runner, so the student
controls code that executes inside our AWS account, as well as the compiler's input.

**What the student might try**

| Goal | Example |
|---|---|
| Steal secrets | read the runner's AWS credentials, another student's code, the answer key |
| Reach other systems | call the internet, other AWS services, our database |
| Cheat the grader | make a wrong program pass, change the verdict of someone else's submission |
| Break the service | infinite loops, memory or fork bombs, huge output, filling the disk, killing the handler |
| Persist | leave something behind that affects the next submission run in the same container |

**Out of scope.** Flaws in AWS itself (the Lambda / Firecracker isolation), a malicious instructor or administrator, a
compromised backend, timing and CPU side channels, and ordinary academic dishonesty (plagiarism, sharing solutions). Test
*inputs* are visible to the program on purpose; that is how a program reads its input.

## 2. What real Lambda lets us do (measured, not assumed)

We first planned a sandbox of our own (a seccomp system-call filter, a Landlock file policy, `no_new_privs`, and a launcher that
adopts leftover processes). The probe tool `sandbox-probe` (run through `scripts/diagnose.ps1`) showed what standard Lambda
allows. Result on the deployed function:

| Step | Result on Lambda |
|---|---|
| Kernel | 5.10.255 |
| `/proc/self/status` | `Seccomp: 2` with **6 filters installed by Lambda**, `NoNewPrivs: 1` already set, `CapEff: 0` (no capabilities) |
| `prctl(PR_SET_NO_NEW_PRIVS)` | EPERM (although the bit is already 1) |
| `seccomp(SET_MODE_FILTER)`, every variant, and `prctl(PR_SET_SECCOMP)` | EPERM |
| `prctl(PR_SET_CHILD_SUBREAPER)`, `PR_SET_PDEATHSIG`, `PR_SET_DUMPABLE` | EPERM |
| `ptrace(PTRACE_TRACEME)` | EPERM |
| Landlock (`landlock_create_ruleset`) | ENOSYS (kernel too old, needs 5.13) |
| `setrlimit` (all the limits we use), `setpgid`, `setsid` | work |
| Yama `ptrace_scope` | file absent (no extra ptrace restriction) |
| `/proc/<parent pid>/mem` from student code | opens for reading **and** writing |

So **Lambda's own seccomp filter is the system-call sandbox, and ours cannot be added on top.** Consequences for the design:

* Our seccomp filter, Landlock and `no_new_privs` are **optional**. The launcher applies them when the platform allows it
  (they work in local Docker tests and on any kernel that permits them), reports what happened in `diagnostics`
  (`seccomp`, `seccompErrno`, `landlock`, `nnp`, `subreaperErrno`), and never fails because of them.
* The launcher **fails closed** (the program is not run, every run returns `internal_error` "sandbox unavailable" with
  `diagnostics.sandboxStep` / `errno`) only when it cannot start the program safely: a resource limit (`setrlimit`), the
  program's own process group (`setpgid`), the work folder, or `exec` fails, or the child never reported.
* Leftover processes (fork bombs, daemons, `setsid` escapes) cannot be adopted by the launcher without
  `CHILD_SUBREAPER`, so the Node handler finds and kills them itself (section 3, item 8).

## 3. How the runner is built

1. **The Lambda is the sandbox.** Every invocation runs in an AWS Lambda execution environment (a Firecracker micro-VM) as an
   unprivileged user with no capabilities. The runner is its own function and its own stack, separate from the rest of the
   backend. It has no secrets of its own.
2. **No network.** The function lives in a VPC with private subnets only: no NAT gateway, no internet gateway, no VPC endpoints,
   and a security group whose only outbound rule points at `127.0.0.1/32`, so nothing can leave the VPC. (The Lambda
   Runtime API on `127.0.0.1` is local to the environment and is **not** blocked, see limit 1 in section 5.)
3. **The expected output never enters the runner.** The runner receives `{ source, runs: [{ stdin }], timeLimitMs,
   memoryLimitKb }` and answers with what the program printed. `accepted` only means "the program ran fine". The comparison
   with the expected output happens in the backend (`shared/nodejs/utils/codeRunnerOwn.js`, rule in `outputCompare.js`,
   identical to Judge0's), which turns a mismatch into `wrong_answer`. An event that contains `expectedOutput` is **rejected**
   by the runner, not ignored. So a student who takes over the runner finds no answer key there, and cannot read one from
   memory either.
4. **Every call runs in a fresh process (custom runtime).** The image's ENTRYPOINT is a tiny C bootstrap (`bootstrap.c`) that
   loops forever: start one worker (`node once.js`), wait for it, repeat. The worker talks to the Lambda Runtime API itself:
   it fetches one event, runs the handler, posts the response and **exits**. So the process that handles a call, and every
   byte of its memory, is new for each call and never seen by a later call. (An earlier design ended the Node runtime process after
   each response; Lambda then failed the next invocation with `Runtime.ExitError`. Here the process Lambda talks to never exits.)
   The bootstrap never reads event data and keeps nothing besides the worker's pid.
5. **Students are kept apart only when tenant isolation is on (optional).** With the template parameter `TenantIsolation=on` the
   function gets `TenancyConfig: TenantIsolationMode: PER_TENANT`, every invocation must carry a tenant id (the backend sends the
   **SHA-256 of the user id**, never the raw id) and AWS guarantees "Execution environments are never reused across different
   tenants". Our account cannot use it in us-east-1 ("not supported for this account"), so the default is `off`: students then
   share execution environments, and what separates them is the fresh worker per call, the cleanup below, and the bootstrap
   holding no data. See limit 9 for what remains.
6. **Worthless credentials.** The execution role can only write to its own log group and use the network-interface actions Lambda
   needs to put a function in a VPC. On top of that it has an explicit **Deny** on those network-interface actions whenever the
   request carries `lambda:SourceFunctionArn` equal to the runner (AWS sets that on requests made with the function's own
   credentials; Lambda's own networking does not carry it and keeps working). Nothing else is allowed: no S3, DynamoDB, Secrets
   Manager, Lambda, IAM. A student who finds the credentials can do almost nothing with them (see limit 2).
7. **Resource limits for every run** (set by the launcher with `setrlimit`, so the kernel enforces them): CPU time, address
   space (memory), stack, number of processes, file size, open files, no core dumps. On top: a wall-clock kill at twice the
   time limit, at most 1 MB of output (more is a runtime error), 64 KB of compiler output and of stderr, 5 MB for the whole
   reply, and the function's own 30-second timeout. Compilation has its own limits and `-fmax-errors=50`, which stops
   compile-time bombs (template recursion, macro explosions, `constexpr` loops).
8. **Own process group.** The program runs in its own process group; when it ends or times out the launcher kills the whole group
   with one `kill(-pgid)`, which is atomic even while a fork bomb is forking.
9. **Clean slate for every run.** The program starts with an **empty environment** (no `AWS_*` variables). At start-up the handler
   records every process that exists (the Lambda runtime and itself). After every run, every live process of the same user that
   is not in that list is killed, repeatedly, until none remain or a deadline passes; if any survive, the call fails with
   `internal_error`. `/tmp` is emptied before and after every call. If zombie processes (orphans that nobody reaps) have used up the
   process limit, the call says so at once, instead of hanging.
10. **Optional extras when the platform allows them:** a seccomp filter that makes network, `ptrace`, `mount`, `bpf` and similar system
   calls fail with `EPERM` (also installed for the compiler), and a Landlock file policy that hides `/proc`, `/etc` and the
   runner's code. They are used in the local Docker tests, where the corpus below verifies them. On standard Lambda they are
   absent and the protections above carry the weight.

## 4. How we check it

* `test/hostile.js`: 37 hostile programs run in a Docker container with no network and the same limits as Lambda: infinite
  loops, sleeping, memory bombs, fork bombs, output floods, sockets and `curl`, reading `/proc` and `/etc`, writing outside the
  work folder, stack overflow, killing the launcher or the handler, daemons and background processes, compile-time bombs, and a
  program that tries every denied system call. Each must end with the expected status, leave no process and no file behind, and
  the next call must be healthy. It runs in three configurations: everything available; Landlock missing; and **Lambda-like**
  (`--lambda-like`: the platform refuses seccomp, Landlock and the prctls, and `NoNewPrivs` is already 1), where cases that
  need Landlock or our filter are skipped and all the rest, including the daemon and background-process cases, must pass.
* `test/run-failclosed.js` and `test/failclosed.test.js` cover the paths: Lambda-like, seccomp refused, prctl refused, Landlock
  missing, `setrlimit` refused (fails closed), `chdir` and `exec` failures, a PID 1 that never reaps zombies, the tenant rules, and
  the tenant rules; `test/once.test.js` (one worker, one invocation, against a fake Runtime API) and `test/run-fresh.js` (10 sequential
  calls through the Lambda Runtime Interface Emulator: no error, 10 different workers, one bootstrap).
* `scripts/diagnose.ps1` (and `sandbox-probe`) report what the deployed platform allows, step by step.
* `test/run-deployed.js` checks the **deployed** function: the launcher starts the program safely; sockets to the internet and
  `169.254.100.1:9001` fail; the program sees no AWS variables; no event ever contains `expectedOutput` and the runner refuses
  one that does; IAM simulation shows the network-interface deny and that S3, DynamoDB and Secrets Manager are denied; calls with
  different tenant ids never share an execution environment (and a call without a tenant id is refused) when tenant isolation is on; 10 sequential
  calls each run in a fresh worker (call #1) with no FunctionError, with the wall time of each; and the whole hostile corpus passes. It also reports, as information, what our seccomp/Landlock did, whether the Runtime API is reachable and what
  `/proc/<pid>/mem` allows.

## 5. What is NOT protected (read this before trusting the runner)

These are known, accepted limits.

1. **The Lambda Runtime API is reachable from student code.** It listens on `127.0.0.1` inside the environment and nothing on
   standard Lambda stops a program from connecting to it (our seccomp filter would, but Lambda refuses it). Through it, a program can
   read the event of the call it runs in (its own source and test inputs), call `/runtime/invocation/next` or post an
   error, and **post its own response for the current call**. That last one matters for grading: the program can make the runner
   *report* any output it likes. It cannot make that output *correct* unless it knows the expected output, because the comparison
   happens in the backend and the expected output never reaches the runner. The practical consequence: **hidden test
   outputs must stay hidden**, and tests whose answers can be guessed or looked up can be passed by printing the answer, which is
   also possible without any tampering (hard-coding). With tenant isolation on, a program can only affect calls of its own
   tenant (itself); with it off, see limit 9.
2. **Student code can read and write the memory of the runner's own process**, and read its environment, including the
   role's temporary credentials. There is no Landlock and no Yama on standard Lambda, the program runs as the same user as the
   Node handler, and `/proc/<pid>/mem` of its parent and of the handler opens for reading and writing. Within one student's
   calls this means a student can tamper with their own environment, for example to change what the handler reports for a
   later call of **the same student**. With tenant isolation this cannot reach any other student; without it, see limit 9. The credentials are
   readable but worthless: the only things they allow are writing log lines to the runner's own log group (log spam and a
   little cost, no reading) for the few hours they last, and they cannot create or change network interfaces (explicit deny).
3. **No file restrictions.** Without Landlock the program can read any file the Lambda user can read: the runner's code in
   `/var/task`, `/etc`, `/proc` (and `#include "/proc/..."` can print some of it in a compile error). None of it holds secrets other than the
   credentials above. The root file system is read-only, so writes are limited to `/tmp`, which is cleaned between calls.
4. **Lambda's seccomp filter, not ours, is the system-call boundary.** We cannot add a deny list on Lambda. A kernel exploit is not
   prevented by anything of ours; if one succeeds the attacker is root inside the Lambda micro-VM, which holds only the worthless
   credentials, and AWS's own isolation is the next boundary (out of scope here).
5. **Orphaned zombie processes.** Without `CHILD_SUBREAPER`, a fork bomb's orphans go to PID 1. If PID 1 on Lambda does not reap
   them, they stay as zombies and use up the per-user process limit of that environment. The handler detects this and
   refuses to continue in that environment. (The deployment check on the real Lambda showed that its PID 1 reaps orphaned zombies.) The probe `orphaned zombies are reaped by PID 1` in `diagnose.ps1` shows whether Lambda's PID 1 reaps.
6. **Denial of service is limited, not prevented.** One submission can occupy one container for up to the function's 30-second
   timeout with 1769 MB of memory. Tenant isolation makes every student their own set of environments (and Lambda charges a small
   fee for each new tenant-specific environment and counts at most 2,500 of them per 1,000 concurrent executions), so many
   students mean more cold starts and some cost. Use reserved concurrency and AWS budget alarms for the runner if the course
   is large.
7. **The output is a channel.** A program can print anything it can read (the credentials, other files, the event) and its
   own student sees it. Test inputs are visible to the program by design; the expected outputs are not.
8. **Side channels and AWS-level attacks** (CPU timing, shared hardware, a flaw in Firecracker or in tenant isolation) are not addressed.
9. **The bootstrap lives as long as the environment, and student code can write to its memory.** The bootstrap runs as the same user
   as everything else and, like the handler, its `/proc/<pid>/mem` can be opened for writing on standard Lambda. It holds no data (no
   events, no responses, no credentials of ours), but a very skilled attacker could rewrite its code so that it tampers with **later
   calls**: for example, run extra code next to every later worker and read its memory or forge its response. With tenant
   isolation off, those later calls may belong to other students, so this is the one way a student could reach another student's
   call. It needs a working memory-corruption of a live process through `/proc` by a program whose every other step is watched
   (its process is killed when the call ends), and it is not something the hostile corpus tests. The cleanup kills every
   leftover process after each call, which removes a background process but not changes made to the bootstrap itself. Turning
   tenant isolation on (`TenantIsolation=on`) confines it to the attacker's own calls; a kernel with Landlock or a separate user
   for the program would close it.

## 6. Why grades cannot be faked

A student who wants a wrong program to pass needs the backend to see output equal to the expected output. The expected output
is never sent to the runner, so a program cannot read it (not from its input, its memory, the event or the Runtime API); the
comparison happens in the backend, outside the sandbox, on the text the runner reports. The runner can be made to report
arbitrary text (limit 1), so the only thing that can be faked is output the student can already guess; with hidden tests that
is no better than not solving the problem. A student also cannot change another student's result by any ordinary means: every call
runs in a fresh worker process, the runner rejects an event that carries expected output, and (with tenant isolation on) different
students never share an execution environment. With tenant isolation off the one remaining path is limit 9.

## 7. If you want to tighten it later

* A kernel with Landlock, or a way to run the program as another user, would close limits 2, 3 and 9 (and make limit 1 harder to use).
* Tenant isolation, if AWS enables it for the account (`TenantIsolation=on`), confines limits 1, 2 and 9 to the attacker's own calls.
* Reserved concurrency and a budget alarm for the runner (limit 6).
* A tiny AWS account for the runner and its logs, so a leak can never reach other resources.
* A second, independent check of the output in the backend for tests whose answers are easy to guess.
