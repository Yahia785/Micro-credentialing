# C++ runner

Container-image Lambda that compiles and runs student C++ in a locked-down sandbox. Own stack
(`micro-credentialing-runner-<env>`), separate from `backend/template.yaml`.

- `function/` image: AWS Node 22 Lambda base + g++ (multi-stage: the launcher and the probe are built in a first stage and only the binaries are copied), `launcher.c` (setrlimit, own process group, and, when the platform allows, seccomp / Landlock / no_new_privs / subreaper), `probe.c` (diagnose tool), `bootstrap.c` (the ENTRYPOINT of a custom runtime: starts one fresh `node once.js` worker per invocation, forever), `once.js` (the worker: talks to the Lambda Runtime API, handles one event, exits), handler logic in `index.js`
- `template.yaml` VPC with private subnets only, no NAT/IGW/endpoints, no egress; role = own logs + ENI actions only, with an explicit Deny on the ENI actions for requests that carry `lambda:SourceFunctionArn` of the runner; the function is an `AWS::Lambda::Function`; tenant isolation (`TenancyConfig: PER_TENANT`) is an optional parameter, off by default
- `SECURITY.md` threat model, every protection and the remaining limits
- `build/` separate stack with a CodeBuild project that builds and pushes the image inside AWS (`buildspec.yml` is what it runs)
- `scripts/` ECR repository creation, image build/push (CodeBuild or crane) and deploy-template generation (see below)
- `test/` Docker tests (hostile corpus, normal-program fixture, timing, fail-closed), `compare.test.js` / `failclosed.test.js` (`node --test test/compare.test.js test/failclosed.test.js`), and `run-deployed.js` for the deployed function

Backend side: `CODE_RUNNER=own` and `CODE_RUNNER_FUNCTION=<function name>` (see `shared/nodejs/utils/codeRunnerOwn.js`).

The runner event is `{ source, runs: [{ stdin }], timeLimitMs, memoryLimitKb }`. The runner never receives the expected output
(an event with `expectedOutput` is rejected); `accepted` only means "ran fine". The provider compares the output with
the Judge0 rule (`shared/nodejs/utils/outputCompare.js`) and turns a mismatch into `wrong_answer`.

## Local tests (Docker, `--network none`)

```powershell
docker build -t cpp-runner:test function
node test/run-hostile.js                 # add --no-landlock, or --lambda-like (what standard Lambda allows: no seccomp/Landlock/prctls, NoNewPrivs already 1)
node test/run-fixtures.js
node test/run-fresh.js                  # 10 sequential calls through the Runtime Interface Emulator: no error, a fresh worker each time
node test/run-failclosed.js              # Lambda-like, seccomp/prctl/Landlock refused (still runs), setrlimit refused (fails closed), chdir/exec, zombies
node test/run-timing.js
node --test test/classify.test.js test/failclosed.test.js test/once.test.js
```

## Deploy (dev)

The image is not pushed by SAM. SAM's managed ECR repository is deleted by its companion stack when a template has
no image to build, and `docker push` from this machine fails (traffic leaving the Docker VM gets corrupted, and large
uploads from Windows are reset too). Instead the runner has its own ECR repository (`micro-credentialing-runner-<env>`,
last 5 images kept), the image is built and pushed inside AWS, and `sam deploy` uses a generated template that points at
the pushed image by digest. All commands run from `backend/runner`.

### Preferred: build in AWS (CodeBuild)

CodeBuild pulls the public GitHub repo, so the branch must be committed and pushed first. It builds what is on GitHub.

1. Once per environment, create the repository (not part of any stack, because the function needs the image before its stack can exist):
   `powershell -File scripts\create-repo.ps1`
2. Once (and after changes to `build/`), deploy the build stack:
   `sam deploy --template-file build\template.yaml --config-file "$PWD\build\samconfig-dev.toml" --config-env dev`
3. Commit and push the branch: `git push origin feature/cpp-runner`
4. Build and push the image in AWS: `powershell -File scripts\build-in-aws.ps1 -Branch feature/cpp-runner`. It starts the build, waits for it, tags the image `runnerfunction-<12-char commit>-<env>`, reads the digest from ECR with `aws ecr describe-images`, checks the image exists, and writes `.aws-sam/deploy-template.yaml` (UTF-8, no BOM) with `ImageUri` set to `<repo>@<digest>`.
5. Deploy the runner: `sam deploy --config-file "$PWD\samconfig-dev.toml" --config-env dev`. `samconfig-dev.toml` sets `template_file = ".aws-sam/deploy-template.yaml"` and `resolve_image_repos = false`, so SAM builds and pushes nothing.
6. Check the deployed function: `node test\run-deployed.js micro-credentialing-runner-dev-recycle [--region us-east-1]`. It prints PASS/FAIL tables for: the launcher started the program safely (seccomp and Landlock are INFO only); a socket to 1.1.1.1:443 fails (169.254.100.1:9001 and 127.0.0.1:9001, the Lambda Runtime API, are INFO: reachable by design, see SECURITY.md); an outbound-connect hostile case that ends as `time_limit` counts as a pass (the VPC drops packets, nothing connected); with tenant isolation on, different tenant ids never share an execution environment and a call without a tenant id is refused; always, 10 sequential calls each run in a fresh worker (call #1) with no FunctionError, and the wall time of each call is printed; no AWS variables in the program's environment; no event contains `expectedOutput`; IAM (uses your own AWS credentials, needs `iam:SimulatePrincipalPolicy`); and the full hostile corpus. Cases that depend on Landlock show SKIP on standard Lambda.

For a later runner change, repeat steps 3 to 6. The build role can only push to the one repository and write its own log
group. `ecr:GetAuthorizationToken` is the only action on `*` (AWS does not allow limiting it).

### Alternative: push from this machine with crane

Needs `sam build --config-file "$PWD\samconfig-dev.toml" --config-env dev` and crane at `D:\tools\crane\crane.exe`. Replaces steps 3 and 4:
`powershell -File scripts\push-image.ps1` (saves the image to a temporary tar, pushes it with crane in up to 5 resuming attempts, reads the digest from ECR, checks the image exists, writes the same `.aws-sam/deploy-template.yaml`).

### Comparing with Judge0, and load testing

* `node scripts/compare-judge0.js [--limit n] [--skip n] [--only 1,3] [--dry-run]` runs the 29-program fixture (37 runs) through the Judge0
  provider (the real key, read from Secrets Manager like the backend does) and the deployed runner, one Judge0 batch per program, prints the
  statuses side by side and the mismatches. It prints how many Judge0 requests it will make (free tier: about 50 a day) and asks for "yes" first.
* `node scripts/stress-runner.js [--dry-run]` loads the deployed runner only (never Judge0): ramp of 1, 5, 10, 25, 50, 100 parallel calls, then
  2 calls/s for 3 minutes, with the account limit and reserved concurrency printed first and a confirmation. See the header of the script for its safety rules.

### Diagnosing "sandbox unavailable"

`powershell -File scripts\diagnose.ps1` invokes the deployed function with `{ "diagnose": true }` (no student code). The runner image
contains `sandbox-probe`, which tries every sandbox step (prctl, seccomp with an allow-all filter and with the real filter, Landlock,
every setrlimit, setpgid/setsid, ptrace, `/proc/<pid>/mem`, kernel and `/proc/self/status`) and reports success or errno, as a direct
child of the handler, as a grandchild, and through the real launcher. When the sandbox is unavailable, a normal reply also carries
`diagnostics.sandboxStep` and `diagnostics.errno` (and `diagnostics.subreaperErrno`, `seccompErrno`, `nnp`). Local check: `node test/run-diagnose.js`.
The diagnose reply also says whether PID 1 reaps orphaned zombies (`orphaned zombies are reaped by PID 1`).

### Notes

- Always run the image step right before `sam deploy`: a stale `.aws-sam/deploy-template.yaml` points at an older image.
- If a first deploy ends in `CREATE_FAILED` (rollback is disabled in `samconfig-dev.toml`), delete the stack before deploying again:
  `aws cloudformation delete-stack --stack-name micro-credentialing-runner-dev --region us-east-1`

### Custom runtime, and the function name

The image is a custom runtime: its ENTRYPOINT is `runner-bootstrap`, which Lambda talks to for the whole life of the environment and which
starts a fresh `node once.js` worker per invocation. (Ending the Node runtime process after each response made Lambda fail the next
invocation with `Runtime.ExitError`.) Locally the Runtime Interface Emulator plays Lambda:
`docker run --entrypoint /usr/local/bin/aws-lambda-rie cpp-runner:test /usr/local/bin/runner-bootstrap` (the test scripts do this).

The default deployment has **no tenant isolation** (`TenantIsolation=off` in `samconfig-dev.toml`; our account cannot use it in us-east-1),
so the function is `micro-credentialing-runner-<env>-recycle` (logical id `RunnerFunctionV2`) and the backend must have
`CODE_RUNNER_FUNCTION=micro-credentialing-runner-dev-recycle` and `CODE_RUNNER_TENANT_ISOLATION=off`; `diagnose.ps1` and `run-deployed.js`
default to that name. Tenant isolation is a property of a function that cannot be changed later: if AWS enables it, deploy with
`sam deploy ... --parameter-overrides Environment=dev TenantIsolation=on`. That creates the new function `micro-credentialing-runner-<env>-tenant` and
deletes the `-recycle` one; use `CODE_RUNNER_FUNCTION=...-tenant`, remove `CODE_RUNNER_TENANT_ISOLATION=off`, and pass `-Tenant` to `diagnose.ps1`.
Unverified: the Runtime API header that carries the tenant id to `once.js` (`Lambda-Runtime-Aws-Tenant-Id`).
- The scripts call `aws`, `docker`, `crane` and `git` through `scripts/native.ps1`, so stderr output never stops a script by itself; only exit codes do.
