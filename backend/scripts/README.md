# Scripts

## mock-interview.js

Runs a mock AI interview in your terminal. It uses the same Host engine as the Lambda
(`shared/nodejs/agent/interview-engine.js`) and calls Amazon Bedrock with your local AWS
credentials. You type the student's answers. It does not read or write DynamoDB.

### Requirements

- Node 18+, and `npm install` run once in `backend/shared/nodejs`.
- AWS credentials that can call Bedrock in `us-east-1` (`aws configure`, `AWS_PROFILE`, or env vars),
  with `bedrock:InvokeModel` on the model, and model access enabled for it in your account.

### Run

From the `backend/` folder:

```
node scripts/mock-interview.js --code scripts/sample.cpp --config scripts/sample-interview.json --out transcript.json
```

- `--code` the C++ file the "student" submitted
- `--config` the interview config (same shape as the `interview` field on a coding assessment)
- `--out` where to write the transcript (default `mock-interview-<timestamp>.json`)
- `--model` Bedrock model ID (default: `AGENT_MODEL_ID`, else `qwen.qwen3-coder-30b-a3b-v1:0`)

Type `/quit` to stop early. The clock follows `timeLimitMinutes`; an answer sent after it is not counted.

### Transcript

The JSON file has the model ID, prompt version, config, status and every turn. Host turns include
`reason` (instructor-only), `kind`, `themeId`, `latencyMs`, token counts, and `fallback` when the
model output was unusable (`invalid_output`) or the call failed (`model_unavailable`).

### Privacy

The code and your answers are sent to Bedrock in `us-east-1`. Use made-up data. No identifiers are sent.
