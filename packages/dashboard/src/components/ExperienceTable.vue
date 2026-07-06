<script setup lang="ts">
/**
 * ExperienceTable —— 经验列表表格。
 *
 * - NDataTable 渲染列表，列：title / type / status / relevanceScore / qualityScore / matchCount / createdAt
 * - 启用客户端分页（默认 10/页）+ striped 斑马纹 + hover 高亮
 * - state='superseded' 的行用次要文本色（rowClassName 控制）
 * - 行点击触发 row-click 事件，传 id
 * - 时间列统一使用 format.ts 的 formatDateTime（消除重复实现）
 */
import { computed, h } from 'vue';
import {
  NDataTable,
  NTag,
  NProgress,
  type DataTableColumns,
  type PaginationProps,
} from 'naive-ui';
import type { ExperienceItem } from '../api/experience';
import { formatDateTime } from '../utils/format';

const props = defineProps<{
  items: ExperienceItem[];
  loading?: boolean;
  /** 每页条数，默认 10 */
  pageSize?: number;
}>();

const emit = defineEmits<{
  (e: 'row-click', id: string): void;
}>();

// type → NTag 颜色
function typeColor(t: string): 'info' | 'error' | 'warning' | 'success' | 'default' {
  switch (t) {
    case 'failure':       return 'error';
    case 'correction':    return 'warning';
    case 'fix':           return 'success';
    case 'best_practice': return 'info';
    case 'lesson':        return 'default';
    default:              return 'default';
  }
}

// status → NTag 颜色
function statusColor(s: string): 'warning' | 'success' | 'default' {
  switch (s) {
    case 'PENDING':   return 'warning';
    case 'DISTILLED': return 'success';
    default:          return 'default';
  }
}

const columns = computed<DataTableColumns<ExperienceItem>>(() => [
  {
    title: '标题',
    key: 'title',
    minWidth: 200,
    ellipsis: { tooltip: true },
    render: (row) => h('span', { class: 'cell-title' }, row.title || row.id),
  },
  {
    title: '类型',
    key: 'type',
    width: 120,
    render: (row) =>
      h(NTag, { size: 'small', type: typeColor(row.type) }, { default: () => row.type || 'lesson' }),
  },
  {
    title: '状态',
    key: 'status',
    width: 110,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: statusColor(row.status) },
        { default: () => row.status || '—' },
      ),
  },
  {
    title: '相关性',
    key: 'relevanceScore',
    width: 140,
    render: (row) =>
      h(NProgress, {
        type: 'line',
        percentage: Math.round((row.relevanceScore ?? 0) * 100),
        showIndicator: true,
        height: 14,
      }),
  },
  {
    title: '质量分',
    key: 'qualityScore',
    width: 90,
    render: (row) =>
      row.qualityScore !== null && row.qualityScore !== undefined
        ? row.qualityScore.toFixed(2)
        : '—',
  },
  {
    title: '命中数',
    key: 'matchCount',
    width: 80,
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 150,
    render: (row) => formatDateTime(row.createdAt ?? 0),
  },
]);

// 客户端分页：默认 10/页，可由 pageSize prop 覆盖
const pagination = computed<PaginationProps>(() => ({
  pageSize: props.pageSize ?? 10,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  showQuickJumper: true,
}));

function rowProps(row: ExperienceItem) {
  return {
    style: 'cursor: pointer',
    onClick: () => emit('row-click', row.id),
  };
}

// 行样式：state='superseded' 用次要文本色（去掉过弱的 opacity）
function rowClassName(row: ExperienceItem): string {
  return row.state === 'superseded' ? 'row-superseded' : '';
}
</script>

<template>
  <NDataTable
    :columns="columns"
    :data="props.items"
    :loading="props.loading"
    :row-props="rowProps"
    :row-class-name="rowClassName"
    :bordered="false"
    :striped="true"
    :pagination="pagination"
    :scroll-x="900"
    size="small"
  />
</template>

<style scoped>
/* superseded 行：用次要文本色 + 斜体区分，不再用 opacity（过弱） */
:deep(.row-superseded) {
  color: var(--color-text-tertiary);
  font-style: italic;
}
:deep(.row-superseded .cell-title) {
  font-weight: 400;
}
.cell-title {
  font-weight: 500;
}
</style>
