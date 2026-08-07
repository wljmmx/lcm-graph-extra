<script setup lang="ts">
import { computed, h } from 'vue';
import { NCard, NTag, NDataTable, type DataTableColumns } from 'naive-ui';
import CardState from './CardState.vue';
import type { GmProServiceStatus } from '../../api/gm-pro';

type SvcRow = { name: string; status: string; detail?: unknown };

const props = defineProps<{
  services: GmProServiceStatus | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

function statusTagType(status: string): 'success' | 'error' | 'warning' {
  if (status === 'connected' || status === 'running' || status === 'ok' || status === 'configured' || status === 'initialized') return 'success';
  if (status === 'disconnected' || status === 'not-initialized' || status === 'error') return 'error';
  return 'warning';
}

// 将 detail（对象/数组/原始值）序列化为可展示的单行文本
function detailText(detail: unknown): string {
  if (detail == null || detail === '') return '—';
  if (typeof detail === 'object' && !Array.isArray(detail)) {
    const entries = Object.entries(detail as Record<string, unknown>);
    if (!entries.length) return '—';
    return entries
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80)}`)
      .join('  ');
  }
  return String(detail).slice(0, 120);
}

const columns: DataTableColumns<SvcRow> = [
  {
    title: '服务',
    key: 'name',
    minWidth: 110,
    render: (row) => h('span', { class: 'mono svc-name' }, row.name),
  },
  {
    title: '状态',
    key: 'status',
    width: 130,
    render: (row) =>
      h(
        NTag,
        { size: 'tiny', type: statusTagType(row.status) },
        { default: () => row.status },
      ),
  },
  {
    title: '详情',
    key: 'detail',
    minWidth: 200,
    ellipsis: { tooltip: true },
    render: (row) => h('span', {}, detailText(row.detail)),
  },
];

const svcRows = computed<SvcRow[]>(() => (props.services?.services ?? []) as SvcRow[]);
</script>

<template>
  <NCard title="gm-pro 服务状态" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!services"
      empty-text="暂无 gm-pro 服务数据"
      error-text="gm-pro 服务请求失败"
      empty-hint="请确认 graph-memory-pro HTTP 服务（端口 7850）已启动且 GM_PRO_AUTH_TOKEN 配置正确。"
      @retry="emit('retry')"
    >
      <div class="svc-header-row">
        <NTag type="info" size="small">v{{ services.version }}</NTag>
        <span class="muted" style="font-size:var(--fs-caption)">
          {{ services.timestamp ? String(services.timestamp).slice(0, 19).replace('T', ' ') : '—' }}
        </span>
      </div>
      <NDataTable
        :columns="columns"
        :data="svcRows"
        :bordered="false"
        :striped="true"
        size="small"
      />
    </CardState>
  </NCard>
</template>

<style scoped>
.svc-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
</style>
