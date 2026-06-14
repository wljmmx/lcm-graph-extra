# OpenClaw CE × lcm-graph-extra 性能测试报告

**测试日期:** 2026-06-14T15:13:40.608146+00:00
**总会话数:** 78

## 一、延迟性能 — 框架级 + lcm-graph-extra 模块级拆解

| 指标 | 值 | 单位 |
|------|-----|------|
| avg-total-runtime | 212183.73 | ms |
| avg-total-runtime_p50 | 59749.00 | ms |
| avg-total-runtime_p95 | 899942.00 | ms |
| avg-total-runtime_max | 7553807.00 | ms |
| avg-context-build | 936.86 | ms |
| avg-context-build_p50 | 75.00 | ms |
| avg-context-build_p95 | 8002.00 | ms |
| avg-context-build_max | 32734.00 | ms |
| avg-prompt-assembly | 7.94 | ms |
| avg-prompt-assembly_p50 | 8.00 | ms |
| avg-prompt-assembly_p95 | 15.00 | ms |
| avg-prompt-assembly_max | 38.00 | ms |
| avg-model-inference | 210414.14 | ms |
| avg-model-inference_p50 | 59179.00 | ms |
| avg-model-inference_p95 | 899887.00 | ms |
| avg-model-inference_max | 7553727.00 | ms |
| avg-post-processing | 3.59 | ms |
| avg-post-processing_p50 | 2.00 | ms |
| avg-post-processing_p95 | 13.00 | ms |
| avg-post-processing_max | 61.00 | ms |

## 二、吞吐量与处理能力

| 指标 | 值 | 单位 |
|------|-----|------|
| total-sessions | 78 | sessions |
| done-sessions | 50 | sessions |
| avg-input-tokens | 219127 | tokens |
| avg-output-tokens | 5853 | tokens |

## 六、稳定性与可靠性

| 指标 | 值 | 单位 |
|------|-----|------|
| success-rate | 64.10 | % |

## 关键发现

- 上下文构建 P50: **75.0ms** (0.1s)
