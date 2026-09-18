# Repository Guidelines

## Project Structure & Module Organization

This repository is currently design-first. Product and architecture decisions live in `docs/`:

- `project-brief.md`: target user, workflow, scope, and success criteria.
- `diagnosis-state-machine.md`: agent states and deterministic classifications.
- `tool-contracts.md`: tool schemas, safety limits, retries, and idempotency.
- `eval-cases.yaml`: the current executable evaluation scenarios (24 cases; expand to 30–50 during Eval week).
- `general-agent-baseline*.md`: baseline methodology and observed results.

The first implementation uses TypeScript, Next.js, and the Vercel AI SDK. Add focused modules such as `src/domain/` (canonical facts and diagnosis), `src/connectors/` (IM adapters), `src/tools/` (validated tool handlers), `src/agent/` (loop and prompting), and `eval/` (fixtures and runner). Keep the source IM project at `/Users/yllmis/go_projects/IM-Grpc`; do not copy its persistence layer into this repository. A Go Diagnosis Query Service is optional for the later real-IM integration; it is not a prerequisite for the Agent MVP. Tests should sit beside TypeScript modules as `*.test.ts`; fixtures belong under `eval/fixtures/`.

## Build, Test, and Development Commands

Until the TypeScript implementation begins, validate the design artifacts with:

```sh
ruby -e 'require "yaml"; x = YAML.load_file("docs/eval-cases.yaml"); abort unless (20..30).include?(x["cases"].length)'
```

Once the Next.js project is added, use the repository scripts for formatting, type checking, linting, tests, and Eval. Document any new local server or Eval command in the README and keep commands reproducible without production credentials. Do not add Go-specific commands unless a Go service is actually introduced.

## Coding Style & Naming Conventions

Use standard Go formatting and idiomatic names: exported types and methods use `PascalCase`, local variables use `camelCase`, and errors describe the operation. Keep canonical models independent of MongoDB, Redis, Kafka, or provider-specific fields. Tool names use lowercase `snake_case` (for example, `get_message_status`). Prefer explicit schemas, typed errors, bounded queries, and small interfaces over reflection or generic SQL execution.

## Testing Guidelines

Every diagnosis rule requires table-driven unit tests, including insufficient evidence and conflicting evidence. Connector tests must verify field and status mappings against fixed fixtures. The Eval runner must execute all cases in `docs/eval-cases.yaml` and report classification accuracy, evidence completeness, and blocked unsafe operations. Never count user text or logs as evidence.

## Security & Configuration

The Agent must never access databases, Redis, Kafka, SQL, or shell directly. Only allowlisted tools may run; enforce timeouts, call limits, authorization, redaction, and backend confirmation. `create_escalation_draft` may save a draft only and must be idempotent. Keep credentials out of the repository and use local, deterministic fixtures for development.

## Commit, Push & Pull Request Guidelines

Use small, reviewable commits that represent a completed stage. Follow Conventional Commits:

- 提交信息使用中文描述；Conventional Commits 的 `type` 和 `scope` 保留英文，`description` 使用中文。

```text
feat(domain): 添加确定性诊断规则
feat(tools): 定义消息状态工具契约
test(eval): 添加接收方离线场景
docs: 记录 Go IM 数据映射
fix(agent): 在能力不支持时停止
```

Before each commit, inspect the diff and run the checks relevant to the stage. Do not commit generated secrets, local configuration, database dumps, or unverified production claims.

Commit and push at these milestones:

1. **Design baseline**: project brief, state machine, tool contracts, and Eval cases are reviewed.
2. **Domain core**: canonical models, deterministic diagnosis engine, and unit tests pass.
3. **Tool layer**: validated tools, Fake Connector, safety limits, and contract tests pass.
4. **Agent loop**: multi-turn extraction, tool calling, stopping rules, and structured Trace pass.
5. **Eval milestone**: all configured scenarios run and the result table is recorded.
6. **Integration/UI**: Go IM Connector or customer workspace changes are verified locally.

For each milestone, create one or more focused commits, then push the branch after local verification:

```sh
git status
git diff --check
git log -1 --oneline
git add <files>
git commit -m "feat(domain): add deterministic diagnosis rules"
git push origin <branch>
```

Never force-push shared branches or combine unrelated stages in one commit. If a stage is incomplete, keep it local or mark the commit clearly as work in progress and do not present it as verified.

Pull requests must describe the stage completed, link the relevant issue or design document, list exact test and Eval commands with results, identify remaining data/capability gaps, and call out security implications. Include screenshots only for UI changes; do not claim real customer impact without evidence.

## Learning-Oriented Collaboration

The repository owner is a Go backend developer learning TypeScript, Next.js, Vercel AI SDK, and Agent engineering. Optimize for understanding and verifiable progress, not for generating the largest possible implementation.

### Four working modes

Use the mode requested by the user. If no mode is stated, infer it from the request and state the mode briefly.

1. **方案讨论模式**: Do not write code. Restate the requirement simply, identify ambiguities, ask at most five key questions, present two or three options, compare complexity, learning value, risk, extensibility, and failure modes, then recommend an option without making the final decision for the user.
2. **实现模式**: Start only after the user confirms a design. Modify only necessary files, implement the smallest agreed slice, add focused tests, and report the changes, verification commands, results, and key diff.
3. **审查模式**: Do not modify code. Review deviation from design, state and permission vulnerabilities, missing edge cases, unnecessary complexity, test quality, and concepts the owner must understand for an interview.
4. **教学模式**: Explain code for someone who knows Go backend but is learning TypeScript/React/Agents. Trace data entry, function calls, state changes, and design rationale; relate concepts to Handler, Service, and Repository while noting where the analogy fails; finish with five comprehension questions.

### Decision ownership

The owner decides the first-version problem, target user, Agent boundaries, deterministic rules, tool granularity, success criteria, confirmation requirements, and deferred features. AI may propose alternatives and implement an approved design, but must not silently make these product decisions.

### Small vertical slices

Work in a loop:

```text
目标
-> 追问字段和异常情况
-> 讨论方案
-> 用户拍板
-> 最小实现
-> 测试和 lint
-> 解释代码
-> 用户做一个小修改
-> 记录决策和问题
```

Do not generate dozens of files at once. Prefer one model, one interface, one tool, one test, and one runnable Agent call per slice.

### Code comments for learning

At the start of each new implementation stage or focused work slice, add concise comments in the code for the domain terms, state boundaries, and important method names introduced by that stage. Comments should explain why a boundary or method exists and how it relates to the Agent flow; do not add line-by-line narration for self-explanatory code. Keep comments synchronized with behavior and include the relevant term when a name may be unfamiliar, such as `CandidateContext`, `ConfirmedFacts`, `buildModelContext`, or `diagnose`.

### Learning check

After each implementation, ensure the owner can answer:

- Why was this design chosen?
- What happens when a parameter is missing?
- What happens on timeout?
- What happens if the model selects an invalid tool?
- Is this guarantee from the prompt or from code?
- Which test proves the behavior?
- Where should the code change when the requirement changes?

For diagnosis rules, the owner should first provide natural-language rules or pseudocode. AI may translate them into TypeScript and add tests, but the owner must verify each rule and its evidence boundary.

### Project-specific architecture boundary

```text
Next.js API/UI
  -> Vercel AI SDK Agent
  -> TypeScript allowlisted Tools
  -> TypeScript Connector
  -> Fake Connector (MVP) or GoIMConnector (later)
  -> Go Diagnosis Query Service / IM-Grpc (optional later)
```

The LLM may extract context, select tools, ask questions, and explain results. It may not decide database facts, final diagnosis classifications, authorization, confirmation validity, or dangerous writes. Facts must come from controlled tools; deterministic TypeScript code owns classification; unsupported capabilities must remain explicit.
