<script setup lang="ts">
/**
 * 经验管理页（模块 2）。
 *
 * 布局（设计文档 4.2 节）：
 *   左侧过滤侧栏（NScrollbar） + 主区列表表格 + 右侧详情抽屉（点击行打开）
 *
 * 数据获取（TanStack Query）：
 *   - experience-list     按 params 查询列表
 *   - experience-detail   选中行后查询详情
 *   - experience-relations 关联子图
 *   - quality-history     质量分历史（MVP 单点）
 *
 * 写操作用 useMutation（lcmg_forget / lcmg_pin 通过 POST /api/mcp/invoke），
 * 成功后 invalidate experience-list。
 */
import { computed, ref } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import { NLayout, NLayoutSider, NLayoutContent, NScrollbar, NCard, NSpace, NEmpty, NAlert } from 'naive-ui';
import ExperienceFilter from '../components/ExperienceFilter.vue';
import ExperienceTable from '../components/ExperienceTable.vue';
import ExperienceDetailDrawer from '../components/ExperienceDetailDrawer.vue';
import {
  fetchExperienceList,
  fetchExperienceDetail,
  fetchExperienceRelations,
  fetchQualityHistory,
  invokeMcpTool,
  type ExperienceListParams,
  type McpInvokeResponse,
} from '../api/experience';

// ===== 过滤参数（v-model 双向） =====
const filterParams = ref<ExperienceListParams>({
  status: 'all',
  limit: 20,
  offset: 0,
});

// ===== 选中行 ID（控制详情抽屉） =====
const selectedId = ref<string | null>(null);
const drawerShow = ref(false);

// ===== 写操作结果提示 =====
const opResult = ref<{ ok: boolean; message: string } | null>(null);

// ===== 列表查询（params 变化即重新拉取） =====
const queryClient = useQueryClient();
const listQueryKey = computed(() => ['experience-list', filterParams.value]);

const { data: listData, isLoading: listLoading, isError: listError } = useQuery({
  queryKey: listQueryKey,
  queryFn: () => fetchExperienceList(filterParams.value),
  // 默认 10s staleTime，避免频繁重复请求（main.ts 已配全局）
});

const items = computed(() => listData.value?.items ?? []);
const total = computed(() => listData.value?.total ?? 0);

// ===== 详情查询（selectedId 存在时启用） =====
const { data: detailData, isLoading: detailLoading } = useQuery({
  queryKey: computed(() => ['experience-detail', selectedId.value]),
  queryFn: () => fetchExperienceDetail(selectedId.value as string),
  enabled: () => !!selectedId.value,
});

// ===== 关联子图查询 =====
const { data: graphData, isLoading: graphLoading } = useQuery({
  queryKey: computed(() => ['experience-relations', selectedId.value]),
  queryFn: () => fetchExperienceRelations(selectedId.value as string),
  enabled: () => !!selectedId.value,
});

// ===== 质量分历史查询 =====
const { data: historyData, isLoading: historyLoading } = useQuery({
  queryKey: computed(() => ['quality-history', selectedId.value]),
  queryFn: () => fetchQualityHistory(selectedId.value as string),
  enabled: () => !!selectedId.value,
});

const historyPoints = computed(() => historyData.value?.points ?? []);

// ===== 写操作 mutation =====
const invokeMutation = useMutation<McpInvokeResponse, Error, { tool: string; params: Record<string, unknown> }>({
  mutationFn: ({ tool, params }) => invokeMcpTool(tool, params),
  onSuccess: (data, vars) => {
    if (data.ok) {
      opResult.value = {
        ok: true,
        message: `${vars.tool} 执行成功${data.result ? ': ' + JSON.stringify(data.result) : ''}`,
      };
      // 写操作成功后刷新列表
      void queryClient.invalidateQueries({ queryKey: ['experience-list'] });
      // 若涉及当前选中详情，也刷新详情
      if (selectedId.value) {
        void queryClient.invalidateQueries({ queryKey: ['experience-detail', selectedId.value] });
        void queryClient.invalidateQueries({ queryKey: ['experience-relations', selectedId.value] });
        void queryClient.invalidateQueries({ queryKey: ['quality-history', selectedId.value] });
      }
    } else {
      opResult.value = { ok: false, message: `${vars.tool} 失败: ${data.error ?? '未知错误'}` };
    }
  },
  onError: (err, vars) => {
    opResult.value = { ok: false, message: `${vars.tool} 异常: ${err.message}` };
  },
});

// ===== 行点击 → 打开抽屉 =====
function handleRowClick(id: string): void {
  selectedId.value = id;
  drawerShow.value = true;
  // 清空之前的操作提示
  opResult.value = null;
}

// ===== 抽屉内 invoke 事件转发给 mutation =====
function handleInvoke(tool: string, params: Record<string, unknown>): void {
  invokeMutation.mutate({ tool, params });
}
</script>

<template>
  <div class="experience-view">
    <div class="experience-header">
      <h2 style="margin: 0">经验管理</h2>
      <span class="muted">共 {{ total }} 条</span>
    </div>

    <NLayout has-sider style="height: calc(100vh - 160px); margin-top: 12px;">
      <!-- 左侧过滤侧栏 -->
      <NLayoutSider
        bordered
        :width="240"
        :collapsed-width="0"
        content-style="padding: 16px;"
      >
        <NScrollbar>
          <ExperienceFilter v-model="filterParams" />
        </NScrollbar>
      </NLayoutSider>

      <!-- 主区列表 -->
      <NLayoutContent content-style="padding: 16px;">
        <NCard size="small">
          <NSpace vertical :size="8">
            <NAlert v-if="listError" type="error" :show-icon="true">
              经验列表加载失败（Neo4j 不可达？）
            </NAlert>
            <NEmpty
              v-if="!listLoading && items.length === 0"
              description="无符合过滤条件的经验"
            />
            <ExperienceTable
              :items="items"
              :loading="listLoading"
              @row-click="handleRowClick"
            />
          </NSpace>
        </NCard>
      </NLayoutContent>
    </NLayout>

    <!-- 详情抽屉 -->
    <ExperienceDetailDrawer
      v-model:show="drawerShow"
      :detail="detailData ?? null"
      :detail-loading="detailLoading"
      :graph="graphData ?? null"
      :graph-loading="graphLoading"
      :history-points="historyPoints"
      :history-loading="historyLoading"
      :op-result="opResult"
      @invoke="handleInvoke"
    />
  </div>
</template>

<style scoped>
.experience-view {
  width: 100%;
}
.experience-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.muted {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
</style>
