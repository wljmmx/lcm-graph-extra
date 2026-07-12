<script setup lang="ts">
/**
 * OperationLog —— 维护操作日志区（模块 4）。
 *
 * - 接收 logs 数组（已按时间倒序，新操作在前）
 * - 每条日志展示：时间 + 工具名 + 状态 tag + 耗时 + 结果/错误（NCollapse 可展开）
 * - 父组件负责裁剪到最近 20 条；本组件只做展示
 *
 * 日志形态（与 MaintainView 的 OperationLogEntry 类型对齐）：
 *   { id, tool, params, status, result?, error?, ts, durationMs }
 */
import { computed } from 'vue';
import {
  NCard,
  NList,
  NListItem,
  NTag,
  NSpace,
  NEmpty,
  NCollapse,
  NCollapseItem,
  NText,
  NButton,
} from 'naive-ui';
import { formatTimeWithSeconds, formatDuration } from '../utils/format';
import ToolResultSummary from './ToolResultSummary.vue';

export interface OperationLogEntry {
  id: number;
  tool: string;
  params: Record<string, unknown>;
  status: 'success' | 'error' | 'running';
  result?: unknown;
  error?: string;
  ts: number;
  durationMs?: number;
  /** 结构化指标（从 result 中提取） */
  details?: {
    ok: boolean;
    error?: string;
    aborted?: boolean;
    metrics?: Record<string, unknown>;
  } | null;
  /** 文本内容（从 result.content[0].text 提取） */
  text?: string | null;
}

const props = defineProps<{
  logs: OperationLogEntry[];
}>();

const emit = defineEmits<{
  (e: 'clear'): void;
}>();

// 反向副本用于"旧的在下"的视觉顺序展示（父组件传入已倒序，这里直接展示）
const displayLogs = computed(() => props.logs);

/** 状态 tag 类型 */
function statusType(s: OperationLogEntry['status']): 'success' | 'error' | 'info' {
  if (s === 'success') return 'success';
  if (s === 'error') return 'error';
  return 'info';
}

function statusLabel(s: OperationLogEntry['status']): string {
  if (s === 'success') return '成功';
  if (s === 'error') return '失败';
  return '执行中';
}

/** 把 params / result 序列化为可读字符串 */
function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
</script>

<template>
  <NCard title="操作日志（最近 20 条）" size="small">
    <template #header-extra>
      <NButton
        v-if="displayLogs.length > 0"
        size="tiny"
        quaternary
        type="error"
        @click="emit('clear')"
      >
        清空
      </NButton>
    </template>
    <NEmpty
      v-if="displayLogs.length === 0"
      size="small"
      description="暂无操作记录"
      style="padding: 12px 0"
    />
    <!-- M9 修复：去除 clickable（列表项无点击交互，避免误导用户） -->
    <NList v-else bordered>
      <NListItem v-for="log in displayLogs" :key="log.id" class="log-item">
        <!-- 第一行：时间 + 工具名 + 状态 tag + 耗时 -->
        <NSpace align="center" :size="8" wrap>
          <NText depth="3" class="log-time">{{ formatTimeWithSeconds(log.ts) }}</NText>
          <NText class="log-tool">{{ log.tool }}</NText>
          <NTag :type="statusType(log.status)" size="small" round>
            {{ statusLabel(log.status) }}
          </NTag>
          <NText v-if="log.durationMs !== undefined" depth="3" class="log-duration">
            {{ formatDuration(log.durationMs) }}
          </NText>
        </NSpace>

        <!-- 第二行：结构化结果摘要（metric chips） -->
        <ToolResultSummary
          v-if="log.status !== 'running'"
          :tool="log.tool"
          :status="log.status"
          :details="log.details"
          :text="log.text"
        />

        <!-- 错误信息：直接展示（红色），无需展开 -->
        <div v-if="log.error" class="log-section">
          <NText type="error" class="log-section-label">错误：</NText>
          <pre class="log-pre log-error">{{ log.error }}</pre>
        </div>

        <!-- 可展开：原始参数 + 原始结果 JSON（默认折叠） -->
        <NCollapse
          v-if="(log.params && Object.keys(log.params).length > 0) || (log.result !== undefined && log.result !== null)"
          class="log-collapse"
          :default-expanded-names="[]"
        >
          <NCollapseItem title="原始数据" name="detail">
            <div v-if="log.params && Object.keys(log.params).length > 0" class="log-section">
              <NText depth="3" class="log-section-label">参数：</NText>
              <pre class="log-pre">{{ prettyJson(log.params) }}</pre>
            </div>
            <div v-if="log.result !== undefined && log.result !== null" class="log-section">
              <NText depth="3" class="log-section-label">结果：</NText>
              <pre class="log-pre">{{ prettyJson(log.result) }}</pre>
            </div>
          </NCollapseItem>
        </NCollapse>
      </NListItem>
    </NList>
  </NCard>
</template>

<style scoped>
.log-item {
  padding: var(--space-sm) var(--space-md) !important;
}
.log-time {
  font-family: var(--font-family-mono);
  font-size: var(--fs-caption);
}
.log-tool {
  font-family: var(--font-family-mono);
  font-size: var(--fs-label);
  font-weight: 600;
}
.log-duration {
  font-size: var(--fs-caption);
}
.log-collapse {
  margin-top: 4px;
}
.log-section {
  margin-bottom: 6px;
}
.log-section-label {
  font-size: var(--fs-caption);
}
.log-pre {
  margin: 2px 0 0 0;
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-surface-2);
  border-radius: var(--radius-sm);
  font-family: var(--font-family-mono);
  font-size: var(--fs-caption);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
}
.log-error {
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 6%, transparent);
}
</style>
