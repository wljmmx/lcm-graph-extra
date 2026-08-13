<script setup lang="ts">
/**
 * OperationRecentHistory —— 运维卡片“最近执行结果”历史区（P1-3）。
 *
 * - 接收已按 tool 过滤、按 ts DESC 排序的持久化日志数组（来自 /api/operation-logs）
 * - 展示最近 N 条（默认 5）：时间 + 操作名 + 成功/失败状态 tag + 耗时
 * - 无记录时渲染 NEmpty
 *
 * 与会话态 OperationLog.vue 的区别：本组件读取后端持久化的全量历史，
 * 跨刷新保留；后者仅展示当前会话内触发的操作。
 */
import { computed } from 'vue';
import { NSpace, NTag, NText, NEmpty } from 'naive-ui';
import { formatDateTime, formatDuration } from '../utils/format';
import type { OperationLogRecord } from '../api/maintain';

const props = withDefaults(
  defineProps<{
    /** 已按 tool 过滤、DESC 排序的日志（本组件负责裁剪到最近 n 条） */
    logs: OperationLogRecord[];
    /** 展示条数，默认 5 */
    n?: number;
    /** 是否显示操作名列（同一卡片内通常单一 tool，默认隐藏） */
    showTool?: boolean;
  }>(),
  {
    n: 5,
    showTool: false,
  },
);

// 工具名 → 友好操作名映射（与 MaintainView 卡片标题对齐）
const TOOL_LABELS: Record<string, string> = {
  lcmg_maintain: '图谱维护',
  lcmg_diagnose: '系统诊断',
  lcmg_distill: '触发蒸馏',
  lcmg_distill_retry: '重试失败经验',
  lcmg_backfill: '经验回溯',
  lcmg_compact: '触发 compact',
  lcmg_reset_breaker: '重置熔断器',
  lcmg_backup: '备份',
  lcmg_restore: '恢复',
  lcmg_sync: '同步修复',
  lcmg_import: '历史导入',
  gm_reembed: '重新向量化',
};

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** 后端 status 为 'success' | 'failure'，统一映射为 NTag type */
function statusType(s: string): 'success' | 'error' | 'default' {
  if (s === 'success') return 'success';
  if (s === 'failure') return 'error';
  return 'default';
}

function statusLabel(s: string): string {
  if (s === 'success') return '成功';
  if (s === 'failure') return '失败';
  return s || '未知';
}

const recent = computed(() => props.logs.slice(0, props.n));
</script>

<template>
  <div class="op-history">
    <div class="op-history-title">
      <NText depth="3" style="font-size: var(--fs-caption)">最近执行结果</NText>
    </div>
    <NEmpty
      v-if="recent.length === 0"
      size="small"
      description="暂无历史记录"
      style="padding: 8px 0"
    />
    <NSpace v-else vertical :size="4">
      <div
        v-for="log in recent"
        :key="log.id"
        class="op-history-row"
      >
        <NSpace align="center" :size="6" :wrap="false">
          <NText depth="3" class="op-history-time">{{ formatDateTime(log.ts) }}</NText>
          <NTag v-if="showTool" size="tiny" :bordered="false">{{ toolLabel(log.tool) }}</NTag>
          <NTag :type="statusType(log.status)" size="tiny" round>{{ statusLabel(log.status) }}</NTag>
          <NText depth="3" class="op-history-dur">{{ formatDuration(log.durationMs) }}</NText>
        </NSpace>
        <NText
          v-if="log.status === 'failure' && log.error"
          depth="2"
          class="op-history-err"
          :title="log.error"
        >
          {{ log.error }}
        </NText>
      </div>
    </NSpace>
  </div>
</template>

<style scoped>
.op-history {
  margin-top: var(--space-sm);
  padding-top: var(--space-xs);
  border-top: 1px dashed var(--color-border-light, var(--color-border));
}
.op-history-title {
  margin-bottom: 4px;
}
.op-history-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.op-history-time {
  font-size: var(--fs-caption);
  white-space: nowrap;
}
.op-history-dur {
  font-size: var(--fs-caption);
  margin-left: auto;
  white-space: nowrap;
}
.op-history-err {
  font-size: var(--fs-caption);
  color: var(--color-danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
</style>
