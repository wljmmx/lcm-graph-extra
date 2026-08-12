<script setup lang="ts">
/**
 * gm-pro 服务状态：各服务组件运行状态 + 运维动作。
 *
 * 数据契约：GET /api/ops/services → GmProServiceStatus。
 * v2.4.0 新增动作（对应 graph-memory-pro ops 端点）：
 *   - 重连 Neo4j（POST /api/ops/reconnect）
 *   - 清空查询缓存（DELETE /api/ops/cache）
 *   - 重置全部熔断器（POST /api/ops/circuit-breakers/reset）
 */
import { computed, h, ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { NCard, NTag, NDataTable, NButton, NPopconfirm, useMessage, type DataTableColumns } from 'naive-ui';
import CardState from './CardState.vue';
import {
  type GmProServiceStatus,
  postGmProOpsReconnect,
  deleteGmProOpsCache,
  postGmProOpsResetBreakers,
} from '../../api/gm-pro';

type SvcRow = { name: string; status: string; detail?: unknown };

const props = defineProps<{
  services: GmProServiceStatus | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

const message = useMessage();
const queryClient = useQueryClient();
const acting = ref<string | null>(null);

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

// ── v2.4.0 运维动作 ──────────────────────────────────────────
async function runAction(
  key: string,
  fn: () => Promise<{ ok: boolean; data?: unknown; error?: string }>,
  okMsg: (data: unknown) => string,
): Promise<void> {
  if (acting.value) return;
  acting.value = key;
  try {
    const res = await fn();
    if (res.ok) {
      message.success(okMsg(res.data));
      // 服务状态 / 健康可能变化，刷新相关查询
      queryClient.invalidateQueries({ queryKey: ['gm-pro-services'] });
      queryClient.invalidateQueries({ queryKey: ['gm-pro-health'] });
    } else {
      message.error(`操作失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    message.error(`操作失败: ${err?.message || String(err)}`);
  } finally {
    acting.value = null;
  }
}

function handleReconnect(): Promise<void> {
  return runAction(
    'reconnect',
    () => postGmProOpsReconnect(),
    (d) => {
      const r = d as { connected?: boolean } | undefined;
      return `Neo4j 重连${r?.connected ? '成功' : '失败（请检查驱动状态）'}`;
    },
  );
}
function handleClearCache(): Promise<void> {
  return runAction(
    'cache',
    () => deleteGmProOpsCache(),
    (d) => {
      const r = d as { entriesRemoved?: number } | undefined;
      return `已清空查询缓存（${r?.entriesRemoved ?? 0} 条）`;
    },
  );
}
function handleResetBreakers(): Promise<void> {
  return runAction(
    'breakers',
    () => postGmProOpsResetBreakers(),
    (d) => {
      const r = d as { resetCount?: number } | undefined;
      return `已重置 ${r?.resetCount ?? 0} 个熔断器`;
    },
  );
}
</script>

<template>
  <NCard title="gm-pro 服务状态" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!services"
      empty-text="暂无 gm-pro 服务数据"
      error-text="gm-pro 服务请求失败"
      empty-hint="请确认 graph-memory-pro HTTP 服务（端口 7850）已启动，且 openclaw.json 中 apiServer.authToken 配置正确。"
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

      <!-- v2.4.0 运维动作 -->
      <div class="svc-actions">
        <NPopconfirm @positive-click="handleReconnect">
          <template #trigger>
            <NButton size="tiny" secondary :loading="acting === 'reconnect'" :disabled="acting !== null">重连 Neo4j</NButton>
          </template>
          确定手动触发 Neo4j 重连与连通性校验？
        </NPopconfirm>
        <NPopconfirm @positive-click="handleClearCache">
          <template #trigger>
            <NButton size="tiny" secondary :loading="acting === 'cache'" :disabled="acting !== null">清空查询缓存</NButton>
          </template>
          确定清空查询缓存（LRU + 召回计时统计）？
        </NPopconfirm>
        <NPopconfirm @positive-click="handleResetBreakers">
          <template #trigger>
            <NButton size="tiny" secondary type="warning" :loading="acting === 'breakers'" :disabled="acting !== null">重置熔断器</NButton>
          </template>
          确定重置 graph-memory-pro 全部熔断器（清零失败计数）？
        </NPopconfirm>
      </div>
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
.svc-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
</style>
