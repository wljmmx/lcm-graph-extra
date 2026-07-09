/**
 * Benchmark 报告生成器。
 *
 * 支持：
 * - JSON 导出：完整 BenchmarkResult 结构，便于离线分析和版本对比
 * - Markdown 导出：含表格和 ASCII 柱状图，便于贴到 PR/Issue
 */
import type { BenchmarkResult, BenchmarkSummary, MultiTurnSessionStats } from './benchmark.js';

// ---------------------------------------------------------------------------
// JSON 导出
// ---------------------------------------------------------------------------

/** 生成 JSON 报告（返回字符串） */
export function exportJsonReport(result: BenchmarkResult): string {
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Markdown 导出
// ---------------------------------------------------------------------------

/** 生成 Markdown 报告 */
export function exportMarkdownReport(result: BenchmarkResult): string {
  const lines: string[] = [];
  const s = result.summary;

  // 标题
  lines.push(`# Benchmark 报告`);
  lines.push('');
  lines.push(`**运行 ID:** \`${result.runId}\``);
  lines.push(`**开始时间:** ${result.startedAt}`);
  lines.push(`**结束时间:** ${result.endedAt}`);
  lines.push(`**总耗时:** ${s.totalDurationMs}ms (${(s.totalDurationMs / 1000).toFixed(2)}s)`);
  lines.push('');

  // 配置
  lines.push(`## 配置`);
  lines.push('');
  lines.push(`| 参数 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| QMD Base URL | \`${result.options.qmdBaseUrl}\` |`);
  lines.push(`| 查询引擎 | ${result.options.engine} |`);
  lines.push(`| 查询模式 | ${result.options.mode} |`);
  lines.push(`| 测试集来源 | ${result.options.fixtureSetId} |`);
  lines.push(`| limit | ${result.options.limit} |`);
  lines.push(`| 超时 | ${result.options.timeoutMs}ms |`);
  lines.push(`| rerank | ${result.options.rerank} |`);
  lines.push(`| 并发数 | ${result.options.concurrency} |`);
  lines.push(`| 测试集数量 | ${result.options.fixturesCount} |`);
  lines.push('');

  // 测试集说明（CE 能力维度）
  const ceCapability = describeCeCapability(result);
  if (ceCapability) {
    lines.push(`## CE 能力维度`);
    lines.push('');
    lines.push(ceCapability);
    lines.push('');
  }

  // 概览
  lines.push(`## 概览`);
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 总用例数 | ${s.totalFixtures} |`);
  lines.push(`| 成功数 | ${s.successCount} |`);
  lines.push(`| 成功率 | ${(s.successRate * 100).toFixed(1)}% |`);
  lines.push(`| 平均结果数 | ${s.avgResultCount.toFixed(2)} |`);
  lines.push('');

  // 延迟分布
  lines.push(`## 延迟分布`);
  lines.push('');
  lines.push(`| 百分位 | 延迟 (ms) |`);
  lines.push(`|---------|----------|`);
  lines.push(`| min | ${s.latency.min} |`);
  lines.push(`| P50 | ${s.latency.p50} |`);
  lines.push(`| P90 | ${s.latency.p90} |`);
  lines.push(`| P95 | ${s.latency.p95} |`);
  lines.push(`| P99 | ${s.latency.p99} |`);
  lines.push(`| max | ${s.latency.max} |`);
  lines.push(`| avg | ${s.latency.avg.toFixed(1)} |`);
  lines.push(`| std | ${s.latency.std.toFixed(1)} |`);
  lines.push('');

  // ASCII 柱状图（P50/P90/P95/P99 相对长度）
  const maxLatency = Math.max(s.latency.p99, s.latency.max, 1);
  const barLen = (ms: number) => Math.round((ms / maxLatency) * 40);
  lines.push('```');
  lines.push('延迟分布柱状图（相对长度，max=P99 或 max）：');
  lines.push(`P50  [${'█'.repeat(barLen(s.latency.p50))}${'░'.repeat(40 - barLen(s.latency.p50))}] ${s.latency.p50}ms`);
  lines.push(`P90  [${'█'.repeat(barLen(s.latency.p90))}${'░'.repeat(40 - barLen(s.latency.p90))}] ${s.latency.p90}ms`);
  lines.push(`P95  [${'█'.repeat(barLen(s.latency.p95))}${'░'.repeat(40 - barLen(s.latency.p95))}] ${s.latency.p95}ms`);
  lines.push(`P99  [${'█'.repeat(barLen(s.latency.p99))}${'░'.repeat(40 - barLen(s.latency.p99))}] ${s.latency.p99}ms`);
  lines.push('```');
  lines.push('');

  // Tokens 消耗
  lines.push(`## Tokens 消耗`);
  lines.push('');
  lines.push(`| 类型 | Tokens |`);
  lines.push(`|------|--------|`);
  lines.push(`| 输入 | ${s.estimatedTokens.input} |`);
  lines.push(`| 输出 | ${s.estimatedTokens.output} |`);
  lines.push(`| 总计 | ${s.estimatedTokens.total} |`);
  lines.push(`| 平均每条 | ${(s.estimatedTokens.total / Math.max(1, s.successCount)).toFixed(1)} |`);
  lines.push('');

  // 压缩率
  lines.push(`## 压缩率`);
  lines.push('');
  lines.push(`- 返回 snippets 总字符数: ${Math.round(s.compressionRatio * 4000 * s.successCount * result.options.limit)}`);
  lines.push(`- 假设全文档总字符数: ${s.successCount * result.options.limit * 4000}`);
  lines.push(`- **压缩率: ${(s.compressionRatio * 100).toFixed(1)}%**（越低表示裁剪越多，节省的 tokens 越多）`);
  lines.push('');

  // 召回率
  if (s.recall) {
    lines.push(`## 召回率评估`);
    lines.push('');
    lines.push(`> 仅有 \`expectedDocIds\` 标注的 ${s.recall.evaluated} 条用例参与评估。`);
    lines.push('');
    lines.push(`| 指标 | 值 |`);
    lines.push(`|------|-----|`);
    lines.push(`| 平均召回率 (Recall) | ${(s.recall.avgRecall * 100).toFixed(1)}% |`);
    lines.push(`| 平均精确率 (Precision) | ${(s.recall.avgPrecision * 100).toFixed(1)}% |`);
    lines.push(`| 平均 F1 | ${(s.recall.avgF1 * 100).toFixed(1)}% |`);
    lines.push('');
  } else {
    lines.push(`## 召回率评估`);
    lines.push('');
    lines.push('> 无 `expectedDocIds` 标注的用例，跳过召回率评估。');
    lines.push('');
  }

  // CE 多轮会话分析（仅 ce-multi-turn 测试集或多轮会话结果有值）
  if (s.multiTurnSessions && s.multiTurnSessions.length > 0) {
    lines.push(...renderMultiTurnSection(s.multiTurnSessions));
  }

  // 按分类统计
  lines.push(`## 按分类统计`);
  lines.push('');
  lines.push(`| 分类 | 总数 | 成功 | 成功率 | 平均延迟 (ms) | 平均结果数 | 平均召回率 |`);
  lines.push(`|------|------|------|--------|-------------|----------|----------|`);
  for (const cat of s.byCategory) {
    lines.push(
      `| ${cat.category} | ${cat.total} | ${cat.success} | ${(cat.successRate * 100).toFixed(0)}% | ${cat.avgLatencyMs.toFixed(0)} | ${cat.avgResultCount.toFixed(1)} | ${cat.avgRecall !== null ? (cat.avgRecall * 100).toFixed(0) + '%' : 'N/A'} |`,
    );
  }
  lines.push('');

  // 逐条详情
  lines.push(`## 逐条详情`);
  lines.push('');
  // 多轮会话用例额外显示 session/turn 信息
  const hasMultiTurnMeta = result.items.some((i) => i.sessionId);
  if (hasMultiTurnMeta) {
    lines.push(`| ID | 分类 | 会话 | 轮次 | 角色 | 查询 | 成功 | 延迟 (ms) | 结果数 | 召回率 |`);
    lines.push(`|----|------|------|------|------|------|------|----------|--------|--------|`);
    for (const item of result.items) {
      const queryShort = item.query.length > 40 ? item.query.slice(0, 40) + '...' : item.query;
      const recall = item.recall !== null ? (item.recall * 100).toFixed(0) + '%' : 'N/A';
      const success = item.success ? '✓' : '✗';
      const session = item.sessionId ?? '-';
      const turn = item.turnIndex !== undefined ? `${item.turnIndex + 1}/${item.turnTotal ?? '?'}` : '-';
      const role = item.turnRole ?? '-';
      lines.push(
        `| ${item.fixtureId} | ${item.category} | ${session} | ${turn} | ${role} | ${queryShort} | ${success} | ${item.latencyMs} | ${item.resultCount} | ${recall} |`,
      );
    }
  } else {
    lines.push(`| ID | 分类 | 查询 | 成功 | 延迟 (ms) | 结果数 | 召回率 |`);
    lines.push(`|----|------|------|------|----------|--------|--------|`);
    for (const item of result.items) {
      const queryShort = item.query.length > 40 ? item.query.slice(0, 40) + '...' : item.query;
      const recall = item.recall !== null ? (item.recall * 100).toFixed(0) + '%' : 'N/A';
      const success = item.success ? '✓' : '✗';
      lines.push(
        `| ${item.fixtureId} | ${item.category} | ${queryShort} | ${success} | ${item.latencyMs} | ${item.resultCount} | ${recall} |`,
      );
    }
  }
  lines.push('');

  // 失败用例
  const failed = result.items.filter((i) => !i.success);
  if (failed.length > 0) {
    lines.push(`## 失败用例`);
    lines.push('');
    for (const f of failed) {
      lines.push(`### ${f.fixtureId} (${f.category})`);
      lines.push(`- **查询:** ${f.query}`);
      lines.push(`- **错误:** ${f.error ?? 'unknown'}`);
      // CE 诊断信息
      if (f.ceDiagnostics) {
        const d = f.ceDiagnostics;
        lines.push(`- **CE 诊断:** ${d.conclusion}`);
        lines.push(`  - L1 lcm: ${d.lcmCount} 条结果${d.lcmError ? `（错误: ${d.lcmError}）` : ''}`);
        lines.push(`  - L2 qmd: ${d.qmdCount} 条结果${d.qmdError ? `（错误: ${d.qmdError}）` : ''}`);
        lines.push(`  - L3 neo4j: ${d.neo4jCount} 条结果${d.neo4jError ? `（错误: ${d.neo4jError}）` : ''}`);
        if (d.hint) lines.push(`  - **建议:** ${d.hint}`);
      }
      lines.push('');
    }
  }

  // CE 引擎诊断汇总（engine='ce' 时）
  const ceDiagItems = result.items.filter((i) => i.ceDiagnostics);
  if (ceDiagItems.length > 0) {
    lines.push(`## CE 引擎诊断`);
    lines.push('');
    lines.push(`> 区分"服务不可达"vs"无数据"，帮助定位三引擎（L1 lcm + L2 qmd + L3 neo4j）问题。`);
    lines.push('');
    lines.push(`| ID | 结论 | L1 lcm | L2 qmd | L3 neo4j | 建议 |`);
    lines.push(`|----|------|--------|--------|----------|------|`);
    for (const item of ceDiagItems) {
      const d = item.ceDiagnostics!;
      const hint = d.hint ? d.hint.slice(0, 60) + (d.hint.length > 60 ? '...' : '') : '-';
      lines.push(
        `| ${item.fixtureId} | ${d.conclusion} | ${d.lcmCount}${d.lcmError ? ' ⚠' : ''} | ${d.qmdCount}${d.qmdError ? ' ⚠' : ''} | ${d.neo4jCount}${d.neo4jError ? ' ⚠' : ''} | ${hint} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CE 能力维度辅助函数
// ---------------------------------------------------------------------------

/**
 * 根据测试集来源和引擎类型，生成 CE 能力维度的说明文字。
 * 参考能力维度：
 * - L1 lossless-claw：会话消息 DAG + 层次化摘要（ingest/compact/assemble）
 * - L2 QMD：BM25 + vector hybrid 检索
 * - L3 Neo4j：知识图谱
 * - L4 EXPERIENCE：经验蒸馏
 */
function describeCeCapability(result: BenchmarkResult): string | null {
  const fixtureSetId = result.options.fixtureSetId;
  const engine = result.options.engine;
  const lines: string[] = [];

  if (fixtureSetId === 'beir-nfcorpus' || fixtureSetId === 'beir-scifact') {
    lines.push(`> 测试集：**BEIR ${fixtureSetId.replace('beir-', '')}**（业界公认信息检索基准，NeurIPS 2021）`);
    lines.push('>');
    lines.push('> 评估维度：零样本检索召回率（NDCG@10 / Recall@k），衡量 L2 QMD hybrid 检索能力。');
    if (engine === 'ce') {
      lines.push('>');
      lines.push('> 引擎：**CE 多引擎并行**（L1 lcm + L2 qmd + L3 neo4j），测试三引擎联合检索的端到端能力。');
    }
    return lines.join('\n');
  }

  if (fixtureSetId === 'ce-multi-turn') {
    lines.push(`> 测试集：**CE 多轮会话集**（基于 lossless-claw 能力维度设计）`);
    lines.push('>');
    lines.push('> 评估维度：');
    lines.push('> - 上下文累积召回：随轮次增加，相关文档应在检索结果中保持可访问');
    lines.push('> - 压缩触发检测：长会话应触发 DAG 压缩（lossless-claw compact）');
    lines.push('> - 召回衰减：时间衰减（halfLife 30d）影响旧轮次相关性');
    lines.push('> - 上下文连贯性：followup 轮应召回 opening 轮的文档（coherence score）');
    if (engine === 'ce') {
      lines.push('>');
      lines.push('> 引擎：**CE 多引擎并行**（L1 lcm + L2 qmd + L3 neo4j）。');
    }
    return lines.join('\n');
  }

  if (fixtureSetId === 'project-scenarios') {
    lines.push(`> 测试集：**项目场景集**（基于本项目实际场景设计）`);
    lines.push('>');
    lines.push('> 评估维度：L2 QMD hybrid 检索（BM25 + vector + rerank）在项目语料上的召回质量。');
    if (engine === 'ce') {
      lines.push('>');
      lines.push('> 引擎：**CE 多引擎并行**（L1 lcm + L2 qmd + L3 neo4j）。');
    }
    return lines.join('\n');
  }

  return null;
}

/**
 * 渲染 CE 多轮会话分析章节。
 * 包含：
 * - 会话汇总表（turnCount / success / coherence）
 * - Recall by turn 趋势图（ASCII 折线）
 * - Latency by turn 柱状图（ASCII）
 */
function renderMultiTurnSection(sessions: MultiTurnSessionStats[]): string[] {
  const lines: string[] = [];
  lines.push(`## CE 多轮会话分析`);
  lines.push('');
  lines.push(`> 基于 lossless-claw 能力维度：上下文累积召回、压缩触发、连贯性评分。`);
  lines.push('');

  // 会话汇总表
  lines.push(`### 会话汇总`);
  lines.push('');
  lines.push(`| 会话 ID | 分类 | 轮次 | 成功 | 成功率 | 平均延迟 (ms) | 连贯性评分 |`);
  lines.push(`|---------|------|------|------|--------|-------------|-----------|`);
  for (const s of sessions) {
    const successRate = s.turnCount > 0 ? (s.successCount / s.turnCount) * 100 : 0;
    const coherence = s.coherenceScore !== null
      ? (s.coherenceScore * 100).toFixed(1) + '%'
      : 'N/A';
    lines.push(
      `| ${s.sessionId} | ${s.category} | ${s.turnCount} | ${s.successCount} | ${successRate.toFixed(0)}% | ${s.avgLatencyMs.toFixed(0)} | ${coherence} |`,
    );
  }
  lines.push('');

  // 整体连贯性评分
  const coherenceScores = sessions
    .map((s) => s.coherenceScore)
    .filter((v): v is number => v !== null);
  if (coherenceScores.length > 0) {
    const avgCoherence = coherenceScores.reduce((a, b) => a + b, 0) / coherenceScores.length;
    lines.push(`**平均上下文连贯性评分:** ${(avgCoherence * 100).toFixed(1)}%（followup 轮召回 opening 轮文档的比例）`);
    lines.push('');
  }

  // Recall by turn 趋势图（每条会话一条折线）
  const sessionsWithRecall = sessions.filter((s) => s.recallByTurn.some((r) => r !== null));
  if (sessionsWithRecall.length > 0) {
    lines.push(`### Recall 随轮次变化趋势`);
    lines.push('');
    lines.push('```');
    lines.push('Recall by turn（每条会话一条折线，% = recall * 100，N/A = 无 expectedDocIds）:');
    for (const s of sessionsWithRecall) {
      const points = s.recallByTurn.map((r, i) => {
        if (r === null) return `T${i + 1}:N/A`;
        return `T${i + 1}:${(r * 100).toFixed(0)}%`;
      });
      lines.push(`${s.sessionId.padEnd(12)} ${points.join(' → ')}`);
    }
    lines.push('```');
    lines.push('');
  }

  // Latency by turn 柱状图（取第一条会话作为示例，或全部叠加）
  lines.push(`### 延迟随轮次变化`);
  lines.push('');
  lines.push('```');
  lines.push('Latency by turn（每条会话一条，ms）:');
  for (const s of sessions) {
    const maxLat = Math.max(...s.latencyByTurn, 1);
    const points = s.latencyByTurn.map((l, i) => {
      const bar = '█'.repeat(Math.max(1, Math.round((l / maxLat) * 20)));
      return `T${i + 1}:${bar} ${l}ms`;
    });
    lines.push(`${s.sessionId.padEnd(12)}`);
    for (const p of points) {
      lines.push(`  ${p}`);
    }
  }
  lines.push('```');
  lines.push('');

  // 结果数随轮次变化（检测召回衰减）
  const sessionsWithDecay = sessions.filter((s) => s.resultCountByTurn.length >= 3);
  if (sessionsWithDecay.length > 0) {
    lines.push(`### 召回衰减检测`);
    lines.push('');
    lines.push('> 结果数随轮次变化，若后期轮次结果数显著下降，可能存在召回衰减。');
    lines.push('');
    lines.push(`| 会话 ID | 首轮结果数 | 末轮结果数 | 变化 |`);
    lines.push(`|---------|----------|----------|------|`);
    for (const s of sessionsWithDecay) {
      const first = s.resultCountByTurn[0] ?? 0;
      const last = s.resultCountByTurn[s.resultCountByTurn.length - 1] ?? 0;
      const delta = last - first;
      const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
      lines.push(`| ${s.sessionId} | ${first} | ${last} | ${arrow} ${Math.abs(delta)} |`);
    }
    lines.push('');
  }

  return lines;
}

// ---------------------------------------------------------------------------
// 持久化（内存存储，进程重启后清空；后续可扩展为 SQLite）
// ---------------------------------------------------------------------------

const MAX_HISTORY = 20;
const history: BenchmarkResult[] = [];

/** 保存 benchmark 结果到内存历史 */
export function saveBenchmarkResult(result: BenchmarkResult): void {
  history.unshift(result);
  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
  }
}

/** 获取历史列表（不含 items 详情，只含 summary） */
export function getBenchmarkHistory(): Array<{ runId: string; startedAt: string; endedAt: string; summary: BenchmarkSummary; options: BenchmarkResult['options'] }> {
  return history.map((r) => ({
    runId: r.runId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    summary: r.summary,
    options: r.options,
  }));
}

/** 根据 runId 获取完整结果 */
export function getBenchmarkResult(runId: string): BenchmarkResult | null {
  return history.find((r) => r.runId === runId) ?? null;
}
