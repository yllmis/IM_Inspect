# 失败案例记录与回归比较

## 目的

Eval 失败不能只显示一个总分。一个场景可能同时出现多个具体原因，例如确认边界不匹配和响应断言失败；如果直接按原因数量统计，会夸大失败场景数量。本项目因此使用两层记录：

- `failureCategories`：稳定的一级责任边界，用于汇总和回归门禁。
- `failureReasons`：具体断点，用于定位测试或实现问题。
- `failureDisposition`：二次归因，区分产品缺陷、测试工具缺口、契约不一致和 Fixture 错误。

当前一级分类固定为：

| 分类 | 含义 |
| --- | --- |
| `model_error` | 字段提取、模型调用或回复断言失败 |
| `tool_contract_error` | 工具参数、调用契约或预期工具错误不符合 |
| `missing_data` | 业务数据不足、空结果或信息不足处理不正确 |
| `diagnosis_rule_error` | 确定性诊断分类或证据边界错误 |
| `security_policy_error` | 危险工具、权限、确认或 Prompt Injection 边界错误 |
| `context_overflow` | 步数或上下文预算限制失效 |
| `fixture_error` | Fixture 文件、Schema 或测试契约本身错误 |

`missing_data` 和 `fixture_error` 必须区分：前者是被测业务条件，后者是测试数据坏了。`tool_contract_error` 和 `security_policy_error` 也不能混用：前者是调用格式，后者是权限和危险操作边界。

## 运行和产物

运行一次当前版本并生成无基线报告：

```sh
npm run eval:failures -- \
  --description "记录失败分类与前后回归报告" \
  --modified-files src/eval/failure-categories.ts,eval/runner.ts
```

将第一次结果作为基线，再运行修改后的版本：

```sh
npm run eval:failures -- \
  --before eval/reports/failure-analysis-<baseline>.json \
  --description "修复某个失败案例" \
  --modified-files path/to/changed-file.ts
```

每次运行生成：

- `eval/reports/failure-analysis-*.json`：机器可读快照和前后差异；
- `eval/reports/failure-analysis-*.md`：面向复盘的失败列表。

报告记录修改前失败场景数、修改后失败场景数、失败案例减少数、是否引入新问题、一级分类变化，以及每个失败案例的具体原因。完整 Agent 输出不会写入该报告。

升级草稿场景还会同时运行专用 `prepare/confirm` Runner。如果专用 Runner 已通过，而通用诊断 Runner 仍报告 `confirmation_boundary_mismatch`，该案例标记为 `eval_harness_gap`，不能直接当成 Agent 产品缺陷。

## 当前基线

本次只增加失败记录和比较机制，没有修改 Agent 诊断行为，因此基线比较应诚实显示：

- 修改前失败场景：9；
- 修改后失败场景：9；
- 失败案例减少：0；
- 是否引入新问题：否。

这不是“功能优化已经完成”的声明。下一步应针对报告中的具体失败案例逐个决定是否调整场景契约、工具行为或 Agent 边界，再重新生成前后报告。不能通过修改 Gold Label、忽略失败原因或把工具错误转换成事实来提高通过率。
