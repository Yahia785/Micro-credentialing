# C++ runner

Container-image Lambda that compiles and runs student C++ in a locked-down sandbox. Own stack
(`micro-credentialing-runner-<env>`), separate from `backend/template.yaml`.

- `function/` image: AWS Node 22 Lambda base + g++ (multi-stage: the launcher is built in a first stage and only the binary is copied), `launcher.c` (setrlimit, seccomp filter, Landlock when the kernel has it, subreaper), handler in `index.js`
- `template.yaml` VPC with private subnets only, no NAT/IGW/endpoints, no egress; role = own logs + ENI actions only, with an explicit Deny on the ENI actions for requests that carry `lambda:SourceFunctionArn` of the runner
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
node test/run-hostile.js                 # add --no-landlock to see standard Lambda (kernel 5.10: seccomp yes, Landlock no)
node test/run-fixtures.js
node test/run-failclosed.js              # seccomp blocked (fails closed), Landlock missing (still runs), all available
node test/run-timing.js
node --test test/classify.test.js test/failclosed.test.js
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
6. Check the deployed function: `node test\run-deployed.js micro-credentialing-runner-dev [--region us-east-1]`. It prints PASS/FAIL tables for: seccomp on; sockets to 1.1.1.1:443, 169.254.100.1:9001 and 127.0.0.1:9001 fail; no AWS variables in the program's environment; no event contains `expectedOutput`; IAM (uses your own AWS credentials, needs `iam:SimulatePrincipalPolicy`); and the full hostile corpus. Cases that depend on Landlock show SKIP on standard Lambda.

For a later runner change, repeat steps 3 to 6. The build role can only push to the one repository and write its own log
group. `ecr:GetAuthorizationToken` is the only action on `*` (AWS does not allow limiting it).

### Alternative: push from this machine with crane

Needs `sam build --config-file "$PWD\samconfig-dev.toml" --config-env dev` and crane at `D:\tools\crane\crane.exe`. Replaces steps 3 and 4:
`powershell -File scripts\push-image.ps1` (saves the image to a temporary tar, pushes it with crane in up to 5 resuming attempts, reads the digest from ECR, checks the image exists, writes the same `.aws-sam/deploy-template.yaml`).

### Notes

- Always run the image step right before `sam deploy`: a stale `.aws-sam/deploy-template.yaml` points at an older image.
- If a first deploy ends in `CREATE_FAILED` (rollback is disabled in `samconfig-dev.toml`), delete the stack before deploying again:
  `aws cloudformation delete-stack --stack-name micro-credentialing-runner-dev --region us-east-1`
- The scripts call `aws`, `docker`, `crane` and `git` through `scripts/native.ps1`, so stderr output never stops a script by itself; only exit codes do.
