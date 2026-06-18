# OpenClaw CE × lcm-graph-extra 性能测试报告

**测试日期:** 2026-06-18T12:47:30.845671+00:00
**总会话数:** 86

## 一、延迟性能 — 框架级 + lcm-graph-extra 模块级拆解

| 指标 | 值 | 单位 |
|------|-----|------|
| avg-total-runtime | 206555.74 | ms |
| avg-total-runtime_p50 | 60034.00 | ms |
| avg-total-runtime_p95 | 843844.00 | ms |
| avg-total-runtime_max | 7553807.00 | ms |
| avg-context-build | 911.10 | ms |
| avg-context-build_p50 | 75.00 | ms |
| avg-context-build_p95 | 6732.00 | ms |
| avg-context-build_max | 32734.00 | ms |
| avg-prompt-assembly | 8.74 | ms |
| avg-prompt-assembly_p50 | 8.00 | ms |
| avg-prompt-assembly_p95 | 18.00 | ms |
| avg-prompt-assembly_max | 40.00 | ms |
| avg-model-inference | 204870.01 | ms |
| avg-model-inference_p50 | 59584.00 | ms |
| avg-model-inference_p95 | 843797.00 | ms |
| avg-model-inference_max | 7553727.00 | ms |
| avg-post-processing | 4.03 | ms |
| avg-post-processing_p50 | 2.00 | ms |
| avg-post-processing_p95 | 15.00 | ms |
| avg-post-processing_max | 61.00 | ms |

## 二、吞吐量与处理能力

| 指标 | 值 | 单位 |
|------|-----|------|
| total-sessions | 86 | sessions |
| done-sessions | 55 | sessions |
| avg-input-tokens | 225072 | tokens |
| avg-output-tokens | 5366 | tokens |

## 六、稳定性与可靠性

| 指标 | 值 | 单位 |
|------|-----|------|
| success-rate | 64.00 | % |

## 关键发现

- 上下文构建 P50: **75.0ms** (0.1s)
