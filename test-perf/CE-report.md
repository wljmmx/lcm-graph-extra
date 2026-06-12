# OpenClaw CE × lcm-graph-extra 性能测试报告

**测试日期:** 2026-06-12T07:57:31.984721+00:00
**总会话数:** 62

## 一、延迟性能 — 框架级 + lcm-graph-extra 模块级拆解

| 指标 | 值 | 单位 |
|------|-----|------|
| avg-total-runtime | 215008.73 | ms |
| avg-total-runtime_p50 | 59224.00 | ms |
| avg-total-runtime_p95 | 900003.00 | ms |
| avg-total-runtime_max | 7553807.00 | ms |
| avg-context-build | 985.60 | ms |
| avg-context-build_p50 | 75.00 | ms |
| avg-context-build_p95 | 8402.00 | ms |
| avg-context-build_max | 32734.00 | ms |
| avg-prompt-assembly | 7.40 | ms |
| avg-prompt-assembly_p50 | 8.00 | ms |
| avg-prompt-assembly_p95 | 12.00 | ms |
| avg-prompt-assembly_max | 29.00 | ms |
| avg-model-inference | 213294.32 | ms |
| avg-model-inference_p50 | 58958.00 | ms |
| avg-model-inference_p95 | 899965.00 | ms |
| avg-model-inference_max | 7553727.00 | ms |
| avg-post-processing | 3.36 | ms |
| avg-post-processing_p50 | 2.00 | ms |
| avg-post-processing_p95 | 12.00 | ms |
| avg-post-processing_max | 61.00 | ms |

## 二、吞吐量与处理能力

| 指标 | 值 | 单位 |
|------|-----|------|
| total-sessions | 62 | sessions |
| done-sessions | 42 | sessions |
| avg-input-tokens | 267718 | tokens |
| avg-output-tokens | 6166 | tokens |

## 六、稳定性与可靠性

| 指标 | 值 | 单位 |
|------|-----|------|
| success-rate | 67.70 | % |

## 关键发现

- 上下文构建 P50: **75.0ms** (0.1s)
