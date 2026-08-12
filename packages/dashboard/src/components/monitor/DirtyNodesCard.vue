<script setup lang="ts">
/**
 * 增量维护（脏节点）。
 *
 * 数据契约：GET /api/maintain/dirty-nodes → { count, nodeIds }。
 * v2.4.0 新增动作：
 *   - 清空脏节点标记（DELETE /api/maintain/dirty-nodes）
 *   - 触发增量维护（POST /api/maintain/incremental），仅处理脏节点。
 */
import { ref, computed } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { NCard, NTag, NButton, NPopconfirm, useMessage } from 'naive-ui';
import CardState from './CardState.vue';
import { deleteGmProDirtyNodes, postGmProMaintainIncremental, type GmProDirtyNodesResult } from '../../api/gm-pro';

const props = defineProps<{
  dirty: GmProDirtyNodesResult | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

const message = useMessage();
const queryClient = useQueryClient();
const clearing = ref(false);
const maintaining = ref(false);

const dirtyCount = computed(() => Number(props.dirty?.count ?? 0));
const hasDirty = computed(() => dirtyCount.value > 0);
const nodeIds = computed<string[]>(() => props.dirty?.nodeIds ?? []);
const previewIds = computed(() => nodeIds.value.slice(0, 3));

async function handleClear(): Promise<void> {
  if (clearing.value) return;
  clearing.value = true;
  try {
    const res = await deleteGmProDirtyNodes();
    if (res.ok) {
      message.success(`已清空脏节点标记（${res.data?.cleared ?? 'all'}）`);
      queryClient.invalidateQueries({ queryKey: ['gm-pro-dirty-nodes'] });
    } else {
      message.error(`清空失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    message.error(`清空失败: ${err?.message || String(err)}`);
  } finally {
    clearing.value = false;
  }
}

async function handleIncremental(): Promise<void> {
  if (maintaining.value) return;
  maintaining.value = true;
  try {
    const res = await postGmProMaintainIncremental();
    if (res.ok) {
      message.success('增量维护已触发（仅处理脏节点）');
      // 维护后会消化脏节点，刷新 dirty-nodes 与图谱健康
      queryClient.invalidateQueries({ queryKey: ['gm-pro-dirty-nodes'] });
      queryClient.invalidateQueries({ queryKey: ['gm-pro-health'] });
    } else {
      message.error(`增量维护失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    message.error(`增量维护失败: ${err?.message || String(err)}`);
  } finally {
    maintaining.value = false;
  }
}
</script>

<template>
  <NCard title="增量维护（脏节点）" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!dirty"
      empty-text="暂无脏节点数据"
      error-text="脏节点请求失败"
      empty-hint="请确认 graph-memory-pro 服务已启动。"
      @retry="emit('retry')"
    >
      <div style="display:flex;align-items:center;gap:8px">
        <NTag :type="hasDirty ? 'warning' : 'success'" size="small">
          脏节点: {{ dirtyCount }} 个
        </NTag>
        <span
          v-if="nodeIds.length"
          class="muted"
          style="font-size:var(--fs-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        >
          {{ previewIds.join(', ') }}{{ nodeIds.length > 3 ? '…' : '' }}
        </span>
      </div>

      <!-- v2.4.0 动作：清空标记 + 触发增量维护 -->
      <div style="display:flex;gap:8px;margin-top:10px">
        <NPopconfirm @positive-click="handleClear">
          <template #trigger>
            <NButton
              size="tiny"
              type="warning"
              secondary
              :disabled="!hasDirty || clearing || maintaining"
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
              :disabled="!hasDirty || clearing || maintaining"
              :loading="maintaining"
            >
              触发增量维护
            </NButton>
          </template>
          确定触发增量维护？仅处理当前 {{ dirtyCount }} 个脏节点（节点级阶段）。
        </NPopconfirm>
      </div>
    </CardState>
  </NCard>
</template>
