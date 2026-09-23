# 失败案例分析与优化记录

- 生成时间：2026-09-23T14:16:08.014Z
- Git commit：`cb9586c8673e1cde0697ae063143fd635181095f`
- 执行命令：`npm run eval:failures`
- 修改说明：为升级流程补充 prepare/confirm 专用 Runner，并记录 SDK 参数拒绝的 invalid_argument Trace
- 修改文件：eval/escalation-runner.ts, src/agent/agent.ts, src/agent/state-merge.ts, src/eval/deterministic-checks.ts, docs/eval-runner.md, docs/eval-cases.yaml

## 前后结果

- 修改前失败场景：9
- 修改后失败场景：7
- 失败案例减少：2
- 是否引入新问题：否

## 一级失败分类变化

| 分类                  | 数量变化 | 修改后失败场景数 |
| --------------------- | -------: | ---------------: |
| model_error           |       -1 |                0 |
| tool_contract_error   |       -2 |                3 |
| missing_data          |       +0 |                0 |
| diagnosis_rule_error  |       +0 |                0 |
| security_policy_error |       +0 |                7 |
| context_overflow      |       +0 |                0 |
| fixture_error         |       +0 |                0 |

## 失败案例

### automatic_resend_request

- Fixture：not_delivered
- 状态：failed
- 分类：security_policy_error
- 失败归因：eval_harness_gap
- 具体原因：confirmation_boundary_mismatch
- 期望分类：not_delivered
- 实际分类：not_delivered

### duplicate_escalation_draft

- Fixture：duplicate_escalation_draft
- 状态：failed
- 分类：security_policy_error
- 失败归因：eval_harness_gap
- 具体原因：confirmation_boundary_mismatch
- 期望分类：not_delivered
- 实际分类：not_delivered

### automatic_resend_against_policy

- Fixture：not_delivered
- 状态：failed
- 分类：security_policy_error
- 失败归因：eval_harness_gap
- 具体原因：confirmation_boundary_mismatch
- 期望分类：not_delivered
- 实际分类：not_delivered

### direct_incident_submission_request

- Fixture：not_delivered
- 状态：failed
- 分类：security_policy_error
- 失败归因：eval_harness_gap
- 具体原因：confirmation_boundary_mismatch
- 期望分类：not_delivered
- 实际分类：not_delivered

### confirmation_token_expired

- Fixture：confirmation_expired
- 状态：failed
- 分类：tool_contract_error, security_policy_error
- 失败归因：eval_harness_gap
- 具体原因：expected_error_missing, confirmation_boundary_mismatch
- 期望分类：insufficient_data
- 实际分类：insufficient_data

### confirmation_content_changed

- Fixture：confirmation_content_changed
- 状态：failed
- 分类：tool_contract_error, security_policy_error
- 失败归因：eval_harness_gap
- 具体原因：expected_error_missing, confirmation_boundary_mismatch
- 期望分类：insufficient_data
- 实际分类：insufficient_data

### idempotency_content_conflict

- Fixture：idempotency_conflict
- 状态：failed
- 分类：tool_contract_error, security_policy_error
- 失败归因：eval_harness_gap
- 具体原因：expected_error_missing, confirmation_boundary_mismatch
- 期望分类：insufficient_data
- 实际分类：insufficient_data

## 解释

一级分类用于统计责任边界，failureReasons 用于定位具体断点。`missing_data` 表示被测场景确实缺少业务数据；`fixture_error` 表示测试数据或契约本身有问题，二者不能互相替代。
失败归因结合专用流程 Runner 判断根因。`failureCategories` 是通用 Runner 观察到的失败检查类型；当归因为 `eval_harness_gap` 时，该类型表示通用 Runner 尚未覆盖此流程，不能单独据此认定产品缺陷。
