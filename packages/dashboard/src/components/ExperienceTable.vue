<script setup lang="ts">
/**
 * ExperienceTable —— 经验列表表格。
 *
 * - NDataTable 渲染列表，列：title / type / status / relevanceScore / qualityScore / matchCount / createdAt
 * - state='superseded' 的行用灰色（rowClassName 控制）
 * - 行点击触发 row-click 事件，传 id
 */
import { computed, h } from 'vue';
import { NDataTable, NTag, NProgress, type DataTableColumns } from 'naive-ui';
import type { ExperienceItem } from '../api/experience';

const props = defineProps<{
  items: ExperienceItem[];
  loading?: boolean;
}>();

const emit = defineEmits<{
  (e: 'row-click', id: string): void;
}>();

function formatTs(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

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
    render: (row) => formatTs(row.createdAt ?? 0),
  },
]);

function rowProps(row: ExperienceItem) {
  return {
    style: 'cursor: pointer',
    onClick: () => emit('row-click', row.id),
  };
}

// 行样式：state='superseded' 用灰色
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
    :pagination="false"
    size="small"
  />
</template>

<style scoped>
:deep(.row-superseded) {
  color: #909399;
  opacity: 0.6;
}
.cell-title {
  font-weight: 500;
}
</style>
