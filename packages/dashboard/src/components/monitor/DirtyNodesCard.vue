<script setup lang="ts">
/**
 * 增量维护（脏节点）+ 扩展运维动作（P2 补齐能力断链）。
 *
 * 数据契约：GET /api/maintain/dirty-nodes → { count, nodeIds }。
 *
 * 动作矩阵（5 项，全部走 gm-pro.ts 统一 API 层）：
 *   节点级（有脏节点时可触发）：
 *     · 清空脏节点标记     DELETE /api/maintain/dirty-nodes
 *     · 触发增量维护       POST   /api/maintain/incremental
 *   全局级（任何时候可触发，高成本分区 + 视觉警告）：
 *     · 触发全量维护       POST   /api/maintain
 *     · 刷新过时标记       POST   /api/staleness/refresh
 *     · 触发重新向量化     POST   /api/reembed
 *
 * UI/UX 设计：
 *   - 分区标题 + 颜色编码区分常规/高风险操作
 *   - 全局动作互斥 loading：任意动作执行时禁用其他按钮
 *   - 每个高成本操作都有 Popconfirm 二次确认 + 预期说明文案
 */
import { ref, computed } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { NCard, NTag, NButton, NPopconfirm, useMessage, NDivider } from 'naive-ui';
import CardState from './CardState.vue';
import {
  deleteGmProDirtyNodes,
  postGmProMaintainIncremental,
  postGmProMaintain,
  postGmProStalenessRefresh,
  startAndPollGmProReembed,
  type GmProDirtyNodesResult,
  type GmProStalenessRefreshResult,
  type GmProReembedTaskSnapshot,
} from '../../api/gm-pro';

const props = defineProps<{
  dirty: GmProDirtyNodesResult | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

const message = useMessage();
const queryClient = useQueryClient();

// 各动作 loading 状态独立维护，避免互相阻塞 UI
const clearing = ref(false);
const maintaining = ref(false);
const fullMaintaining = ref(false);
const refreshing = ref(false);
const reembedding = ref(false);
const reembedClearing = ref(false);

const dirtyCount = computed(() => Number(props.dirty?.count ?? 0));
const hasDirty = computed(() => dirtyCount.value > 0);
const nodeIds = computed<string[]>(() => props.dirty?.nodeIds ?? []);
const previewIds = computed(() => nodeIds.value.slice(0, 3));

/** 是否有任何动作在进行中（高风险按钮全局互斥） */
const anyActing = computed(() =>
  clearing.value || maintaining.value || fullMaintaining.value || refreshing.value || reembedding.value || reembedClearing.value,
);

// ── 操作通用执行封装 ──
type ProxyResp<T> = Promise<{ ok: boolean; data?: T; error?: string }>;
async function runAction<T>(
  loadingRef: { value: boolean },
  fn: () => ProxyResp<T>,
  okMsg: (d: T) => string,
  refreshKeys: string[][],
): Promise<void> {
  if (loadingRef.value) return;
  loadingRef.value = true;
  try {
    const res = await fn();
    if (res.ok) {
      message.success(okMsg((res.data as T) ?? ({} as T)));
      for (const k of refreshKeys) queryClient.invalidateQueries({ queryKey: k });
    } else {
      message.error(`操作失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    message.error(`操作失败: ${err?.message || String(err)}`);
  } finally {
    loadingRef.value = false;
  }
}

// ── 节点级：增量操作 ────────────────────────────────────────────
function handleClear(): Promise<void> {
  return runAction(
    clearing,
    () => deleteGmProDirtyNodes(),
    (d) => `已清空脏节点标记（${(d as any)?.cleared ?? 'all'}）`,
    [['gm-pro-dirty-nodes']],
  );
}

function handleIncremental(): Promise<void> {
  return runAction(
    maintaining,
    () => postGmProMaintainIncremental(),
    () => '增量维护已触发（仅处理脏节点）',
    [['gm-pro-dirty-nodes'], ['gm-pro-health']],
  );
}

// ── 全局级：高成本操作 ──────────────────────────────────────────
function handleFullMaintain(): Promise<void> {
  return runAction(
    fullMaintaining,
    () => postGmProMaintain(),
    () => '全量维护已触发（重算 PageRank/社区检测/孤立节点等），耗时较长',
    [['gm-pro-dirty-nodes'], ['gm-pro-health'], ['gm-pro-communities'], ['gm-pro-top10']],
  );
}

function handleRefreshStaleness(): Promise<void> {
  return runAction<GmProStalenessRefreshResult>(
    refreshing,
    () => postGmProStalenessRefresh(),
    (d) => {
      const count = d?.refreshed ?? d?.count;
      return typeof count === 'number' ? `过时标记已刷新（扫描 ${count} 个节点）` : '过时标记刷新已完成';
    },
    [['gm-pro-health']],
  );
}

function handleReembed(): Promise<void> {
  return runAction<GmProReembedTaskSnapshot>(
    reembedding,
    () => startAndPollGmProReembed(),
    (d) => {
      // 异步任务：最终快照或超时快照（后台任务仍在跑）
      const pct = d?.progressPercent;
      const re = d?.reEmbedded;
      const failed = d?.failed;
      if (typeof re === 'number' && typeof failed === 'number') {
        return `重新向量化完成：成功 ${re} / 失败 ${failed}（进度 ${Math.round(pct ?? 100)}%）`;
      }
      if (typeof re === 'number') {
        return `重新向量化完成：成功 ${re}（进度 ${Math.round(pct ?? 100)}%）`;
      }
      if (typeof pct === 'number') {
        return `重新向量化进行中：进度 ${Math.round(pct)}%，taskId=${d.taskId ?? '未知'}，后台继续执行`;
      }
      return '重新向量化任务已启动（异步执行，见维护面板进度）';
    },
    [['gm-pro-health']],
  );
}

/** 清库重导：先清库再重导（clear=true），推荐流程：clear → 导入数据 → 埋点 */
function handleReembedClear(): Promise<void> {
  return runAction<GmProReembedTaskSnapshot>(
    reembedClearing,
    () => startAndPollGmProReembed({ clear: true }),
    (d) => {
      const pct = d?.progressPercent;
      const re = d?.reEmbedded;
      const msg = d?.message ?? '';
      if (typeof re === 'number') {
        return `清库重导完成：成功重新向量化 ${re} 个节点`;
      }
      if (msg) return `清库重导: ${msg}`;
      if (typeof pct === 'number') return `清库重导进行中：进度 ${Math.round(pct)}%，后台继续执行`;
      return '清库重导已触发，完成后请导入数据再执行一次重新向量化（埋点）';
    },
    [['gm-pro-health']],
  );
}
</script>

<template>
  <NCard title="维护面板（脏节点 + 全局操作）" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!dirty"
      empty-text="暂无脏节点数据"
      error-text="脏节点请求失败"
      empty-hint="请确认 graph-memory-pro 服务已启动。"
      @retry="emit('retry')"
    >
      <!-- 脏节点状态概览 -->
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <NTag :type="hasDirty ? 'warning' : 'success'" size="small">
          脏节点: {{ dirtyCount }} 个
        </NTag>
        <span
          v-if="nodeIds.length"
          class="muted"
          style="font-size:var(--fs-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%"
        >
          {{ previewIds.join(', ') }}{{ nodeIds.length > 3 ? '…' : '' }}
        </span>
      </div>

      <!-- 第一组：节点级增量操作 -->
      <div class="group-title">节点级 · 增量操作</div>
      <div class="action-row">
        <NPopconfirm @positive-click="handleClear">
          <template #trigger>
            <NButton
              size="tiny"
              type="warning"
              secondary
              :disabled="!hasDirty || anyActing"
              :loading="clearing"
            >
              清空标记
            </NButton>
          </template>
          确定清空全部脏节点标记？下次全量维护将不再处理这些节点。
        </NPopconfirm>
        <NPopconfirm @positive-click="handleIncremental">
          <template #trigger>
            <NButton
              size="tiny"
              type="primary"
              secondary
              :disabled="!hasDirty || anyActing"
              :loading="maintaining"
            >
              触发增量维护
            </NButton>
          </template>
          确定触发增量维护？仅处理当前 {{ dirtyCount }} 个脏节点（重算 PageRank、社区归属、关联矩阵更新等）。
        </NPopconfirm>
      </div>

      <NDivider style="margin: 10px 0" />

      <!-- 第二组：全局高成本操作 -->
      <div class="group-title group-title-warn">全局 · 高成本操作</div>
      <div class="muted" style="font-size:var(--fs-caption);margin-bottom:6px">
        全量维护 / 过时刷新 / 重新向量化 会遍历全图节点，耗时与节点数正相关。
      </div>
      <div class="action-row">
        <NPopconfirm @positive-click="handleFullMaintain">
          <template #trigger>
            <NButton
              size="tiny"
              secondary
              :disabled="anyActing"
              :loading="fullMaintaining"
            >
              全量维护
            </NButton>
          </template>
          确定触发全量维护？将扫描所有节点、重算 PageRank、重跑社区检测、重新识别孤立节点等。
        </NPopconfirm>
        <NPopconfirm @positive-click="handleRefreshStaleness">
          <template #trigger>
            <NButton
              size="tiny"
              secondary
              :disabled="anyActing"
              :loading="refreshing"
            >
              刷新过时标记
            </NButton>
          </template>
          确定扫描过时节点？根据 staleness 规则重标记高过时节点（相对轻量，不做内容更新）。
        </NPopconfirm>
        <NPopconfirm @positive-click="handleReembed">
          <template #trigger>
            <NButton
              size="tiny"
              type="warning"
              secondary
              :disabled="anyActing"
              :loading="reembedding"
            >
              重新向量化
            </NButton>
          </template>
          确定触发重新向量化？将为所有节点重新生成 embedding（消耗大量 embedding 配额，通常无需执行）。
        </NPopconfirm>
          <NPopconfirm @positive-click="handleReembedClear">
          <template #trigger>
            <NButton
              size="tiny"
              type="error"
              secondary
              :disabled="anyActing"
              :loading="reembedClearing"
            >
              清库并重导
            </NButton>
          </template>
          确定清库并重导？将先清空节点库，再重新向量化（clear=true）。推荐流程：清库重导 → 导入数据 → 重新向量化（埋点）。此操作不可恢复。
        </NPopconfirm>
      </div>
    </CardState>
  </NCard>
</template>

<style scoped>
.group-title {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  margin: 8px 0 4px;
}
.group-title-warn { color: var(--color-warning); }
.action-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
