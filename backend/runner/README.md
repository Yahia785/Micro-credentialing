# C++ runner

Container-image Lambda that compiles and runs student C++ in a locked-down sandbox. Own stack
(`micro-credentialing-runner-<env>`), separate from `backend/template.yaml`.

- `function/` image: AWS Node 22 Lambda base + g++, `launcher.c` (setrlimit, Landlock, subreaper), handler in `index.js`
- `template.yaml` VPC with private subnets only, no NAT/IGW/endpoints, no egress, role = logs + ENI only
- `test/` Docker tests (hostile corpus, normal-program fixture, timing) and `compare.test.js` (`node --test test/compare.test.js`)

Local tests (Docker, `--network none`): build with `docker build -t cpp-runner:test function`, then
`node test/run-hostile.js`, `node test/run-fixtures.js`, `node test/run-timing.js`.

Backend side: `CODE_RUNNER=own` and `CODE_RUNNER_FUNCTION=<function name>` (see `shared/nodejs/utils/codeRunnerOwn.js`).
