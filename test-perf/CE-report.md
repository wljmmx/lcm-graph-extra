# OpenClaw CE × lcm-graph-extra 性能测试报告

**测试日期:** 2026-06-21T01:39:08.632661+00:00
**总会话数:** 86

## 一、延迟性能 — 框架级 + lcm-graph-extra 模块级拆解

| 指标 | 值 | 单位 |
|------|-----|------|
| avg-total-runtime | 205538.81 | ms |
| avg-total-runtime_p50 | 60359.00 | ms |
| avg-total-runtime_p95 | 843523.00 | ms |
| avg-total-runtime_max | 7553807.00 | ms |
| avg-context-build | 930.07 | ms |
| avg-context-build_p50 | 76.00 | ms |
| avg-context-build_p95 | 6309.00 | ms |
| avg-context-build_max | 32734.00 | ms |
| avg-prompt-assembly | 8.97 | ms |
| avg-prompt-assembly_p50 | 8.00 | ms |
| avg-prompt-assembly_p95 | 18.00 | ms |
| avg-prompt-assembly_max | 40.00 | ms |
| avg-model-inference | 203850.04 | ms |
| avg-model-inference_p50 | 59836.00 | ms |
| avg-model-inference_p95 | 843436.00 | ms |
| avg-model-inference_max | 7553727.00 | ms |
| avg-post-processing | 4.22 | ms |
| avg-post-processing_p50 | 2.00 | ms |
| avg-post-processing_p95 | 16.00 | ms |
| avg-post-processing_max | 61.00 | ms |

## 二、吞吐量与处理能力

| 指标 | 值 | 单位 |
|------|-----|------|
| total-sessions | 86 | sessions |
| done-sessions | 56 | sessions |
| avg-input-tokens | 204168 | tokens |
| avg-output-tokens | 5254 | tokens |

## 六、稳定性与可靠性

| 指标 | 值 | 单位 |
|------|-----|------|
| success-rate | 65.10 | % |

## 关键发现

- 上下文构建 P50: **76.0ms** (0.1s)
