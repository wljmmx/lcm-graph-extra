<script setup lang="ts">
/**
 * ToolResultSummary —— 维护工具执行结果的结构化摘要展示。
 *
 * 从 details.metrics 中解析各工具的结构化指标，
 * 以 metric chip（标签+数值）形式展示处理量、成功/失败计数等。
 *
 * 设计原则：
 *   - 成功指标用 success 色，失败/警告指标用 danger/warning 色
 *   - 数值类指标用 metric chip（圆角浅色底 + 数字 + 标签）
 *   - 布尔类指标用 status dot（圆点 + 文字）
 *   - 无结构化数据时 fallback 到 text 摘要
 */
import { computed } from 'vue';
import { NText } from 'naive-ui';

interface Details {
  ok: boolean;
  error?: string;
  aborted?: boolean;
  metrics?: Record<string, unknown>;
}

const props = defineProps<{
  tool: string;
  status: 'success' | 'error' | 'running';
  details?: Details | null;
  text?: string | null;
}>();

// ===== 指标定义：按工具名映射到展示规则 =====

interface MetricChip {
  label: string;
  value: string | number;
  variant: 'count' | 'bool' | 'text';
  tone: 'default' | 'success' | 'warning' | 'danger';
}

const chips = computed<MetricChip[]>(() => {
  const m = props.details?.metrics;
  if (!m) return [];

  switch (props.tool) {
    case 'lcmg_maintain':
      return [
        { label: '耗时', value: formatMs(m.durationMs as number), variant: 'text', tone: 'default' },
        { label: '去重合并', value: m.dedupMerged as number, variant: 'count', tone: 'success' },
        { label: 'PageRank TopK', value: m.pagerankTopK as number, variant: 'count', tone: 'default' },
        { label: '社区检测', value: m.communitiesDetected as number, variant: 'count', tone: 'default' },
        { label: '社区摘要', value: m.communitySummaries as number, variant: 'count', tone: 'default' },
        { label: '孤儿删除', value: m.orphansDeleted as number, variant: 'count', tone: m.orphansDeleted ? 'warning' : 'default' },
        { label: '墓碑清理', value: m.tombstonesDeleted as number, variant: 'count', tone: m.tombstonesDeleted ? 'warning' : 'default' },
      ];

    case 'lcmg_diagnose': {
      const status = m.status as string;
      return [
        { label: '通过', value: m.pass as number, variant: 'count', tone: 'success' },
        { label: '警告', value: m.warnings as number, variant: 'count', tone: (m.warnings as number) > 0 ? 'warning' : 'default' },
        { label: '失败', value: m.failures as number, variant: 'count', tone: (m.failures as number) > 0 ? 'danger' : 'default' },
        { label: '状态', value: status, variant: 'text', tone: status === 'OK' ? 'success' : 'warning' },
      ];
    }

    case 'lcmg_distill':
      return [
        { label: '处理上限', value: m.limit as number, variant: 'count', tone: 'default' },
        { label: '已触发', value: m.triggered ? '是' : '否', variant: 'bool', tone: m.triggered ? 'success' : 'danger' },
      ];

    case 'lcmg_compact':
      return [
        { label: '目标', value: m.target as string, variant: 'text', tone: 'default' },
        {
          label: '摘要产出',
          value: m.summaryProduced ? '成功' : '未产出',
          variant: 'bool',
          tone: m.summaryProduced ? 'success' : 'warning',
        },
      ];

    case 'lcmg_reset_breaker':
      return [
        { label: '子系统', value: m.name as string, variant: 'text', tone: 'default' },
        { label: '适配器重置', value: m.adapterReset ? '是' : '否', variant: 'bool', tone: m.adapterReset ? 'success' : 'default' },
      ];

    case 'lcmg_backup':
      return [
        { label: 'Neo4j 实体', value: m.neo4jEntities as number, variant: 'count', tone: 'success' },
        { label: 'Neo4j 关系', value: m.neo4jRelationships as number, variant: 'count', tone: 'success' },
        { label: 'LCM 会话', value: m.lcmConversations as number, variant: 'count', tone: 'success' },
        { label: 'LCM 消息', value: m.lcmMessages as number, variant: 'count', tone: 'success' },
        { label: '文件', value: m.files as number, variant: 'count', tone: 'success' },
        { label: '大小', value: `${m.sizeKB} KB`, variant: 'text', tone: 'default' },
      ];

    case 'lcmg_restore': {
      const dryRun = m.dryRun as boolean;
      const tone = dryRun ? 'warning' : 'success';
      return [
        { label: '模式', value: dryRun ? '预览' : '实际写入', variant: 'text', tone },
        { label: 'Neo4j 实体', value: m.neo4jEntities as number, variant: 'count', tone },
        { label: 'Neo4j 关系', value: m.neo4jRelationships as number, variant: 'count', tone },
        { label: 'LCM 消息', value: m.lcmMessages as number, variant: 'count', tone },
        { label: '文件', value: m.files as number, variant: 'count', tone },
        ...((m.skipped as number) > 0
          ? [{ label: '跳过(不安全)', value: m.skipped as number, variant: 'count' as const, tone: 'danger' as const }]
          : []),
      ];
    }

    case 'lcmg_sync': {
      const orphans = m.orphanedNodes as number;
      const drift = m.driftCount as number;
      return [
        { label: '模式', value: `${m.mode}${m.dryRun ? '(预览)' : ''}`, variant: 'text', tone: 'default' },
        { label: '活跃会话', value: m.activeConversations as number, variant: 'count', tone: 'default' },
        { label: 'Neo4j 消息节点', value: m.neo4jMsgNodes as number, variant: 'count', tone: 'default' },
        { label: '孤儿节点', value: orphans, variant: 'count', tone: orphans > 0 ? 'warning' : 'success' },
        { label: '时间漂移', value: drift, variant: 'count', tone: drift > 0 ? 'warning' : 'success' },
        { label: 'Pinned', value: m.pinnedNodes as number, variant: 'count', tone: 'default' },
      ];
    }

    case 'lcmg_import':
      return [
        { label: '来源', value: m.source as string, variant: 'text', tone: 'default' },
        { label: '处理上限', value: m.limit as number, variant: 'count', tone: 'default' },
        ...((m.messagesImported as number) > 0
          ? [{ label: '消息导入', value: m.messagesImported as number, variant: 'count' as const, tone: 'success' as const }]
          : []),
        ...((m.filesImported as number) > 0
          ? [{ label: '文件导入', value: m.filesImported as number, variant: 'count' as const, tone: 'success' as const }]
          : []),
      ];

    default:
      return [];
  }
});

/** 文本 fallback 摘要（截取前 200 字符） */
const textSummary = computed(() => {
  if (chips.value.length > 0) return null;
  if (!props.text) return null;
  const t = props.text.trim();
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
});

// ===== 工具函数 =====

function formatMs(ms: number): string {
  if (!ms || ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** chip 的 CSS class */
function chipClass(tone: MetricChip['tone']): string {
  return `metric-chip metric-chip--${tone}`;
}
</script>

<template>
  <div v-if="chips.length > 0 || textSummary" class="tool-result-summary">
    <!-- 结构化指标 chips -->
    <div v-if="chips.length > 0" class="metric-chips">
      <span
        v-for="(chip, i) in chips"
        :key="i"
        :class="chipClass(chip.tone)"
      >
        <span class="metric-label">{{ chip.label }}</span>
        <span class="metric-value">{{ chip.value }}</span>
      </span>
    </div>

    <!-- 文本 fallback -->
    <div v-else-if="textSummary" class="metric-text-fallback">
      <NText depth="3" class="metric-text">{{ textSummary }}</NText>
    </div>
  </div>
</template>

<style scoped>
.tool-result-summary {
  margin-top: var(--space-xs);
}

/* ===== Metric Chips ===== */
.metric-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.metric-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-caption);
  line-height: 1.5;
  background: var(--color-fill-light);
  border: 1px solid transparent;
}

.metric-chip--success {
  background: color-mix(in srgb, var(--color-success) 8%, transparent);
  border-color: color-mix(in srgb, var(--color-success) 20%, transparent);
}
.metric-chip--success .metric-value {
  color: var(--color-success);
  font-weight: 600;
}

.metric-chip--warning {
  background: color-mix(in srgb, var(--color-warning) 8%, transparent);
  border-color: color-mix(in srgb, var(--color-warning) 20%, transparent);
}
.metric-chip--warning .metric-value {
  color: var(--color-warning);
  font-weight: 600;
}

.metric-chip--danger {
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
  border-color: color-mix(in srgb, var(--color-danger) 20%, transparent);
}
.metric-chip--danger .metric-value {
  color: var(--color-danger);
  font-weight: 600;
}

.metric-chip--default .metric-value {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.metric-label {
  color: var(--color-text-tertiary);
  font-weight: 400;
}

.metric-value {
  font-family: var(--font-family-mono);
}

/* ===== Text Fallback ===== */
.metric-text-fallback {
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-surface-2);
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--color-border-strong);
}

.metric-text {
  font-family: var(--font-family-mono);
  font-size: var(--fs-caption);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
