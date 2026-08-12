<script setup lang="ts">
/**
 * 图谱 Schema 自省卡片（P2：结构透明化）。
 *
 * 解决能力断链：/api/schema 原本有 API 但无 UI，用户无法直观
 * 感知当前图谱实际的节点/边类型构成、向量维度、索引模型等关键信息。
 *
 * 设计要点：
 *   - 左右双栏：左侧节点类型分布（带条形比例），右侧边类型分布
 *   - 头部元信息：向量维度（非空时高亮）、索引模型类型
 *   - 自取数据：/api/schema 对数据体量无影响，可低频（120s）刷新
 */
import { computed, onMounted, ref } from 'vue';
import { useTheme } from '../../composables/useTheme';
import { NCard, NTag, NDescriptions, NDescriptionsItem, NEmpty, NSpin } from 'naive-ui';
import CardState from './CardState.vue';
import { fetchGmProSchema, type GmProSchemaResult } from '../../api/gm-pro';

const { isDark } = useTheme();

const fetching = ref(false);
const isError = ref(false);
const schema = ref<GmProSchemaResult | null>(null);

async function loadSchema(): Promise<void> {
  fetching.value = true;
  isError.value = false;
  try {
    const res = await fetchGmProSchema();
    if (res.ok) schema.value = res.data ?? null;
    else { isError.value = true; schema.value = null; }
  } catch { isError.value = true; schema.value = null; }
  finally { fetching.value = false; }
}
onMounted(loadSchema);

/** 节点类型条形最大值，用于计算每类占比宽度 */
const nodeMax = computed(() => Math.max(1, ...(schema.value?.nodeTypes?.map((t) => t.count) ?? [0])));
const edgeMax = computed(() => Math.max(1, ...(schema.value?.edgeTypes?.map((t) => t.count) ?? [0])));
const nodeTotal = computed(() => schema.value?.nodeTypes?.reduce((s, t) => s + t.count, 0) ?? 0);
const edgeTotal = computed(() => schema.value?.edgeTypes?.reduce((s, t) => s + t.count, 0) ?? 0);

const barColor = computed(() => isDark.value ? 'rgba(64,152,252,0.35)' : 'rgba(32,128,240,0.25)');
const barColorActive = computed(() => isDark.value ? '#4098fc' : '#2080f0');
</script>

<template>
  <NCard size="small">
    <template #header>
      <span>图谱结构自省</span>
      <NTag size="tiny" :bordered="false" type="info" style="margin-left:8px">schema</NTag>
    </template>
    <template #header-extra>
      <span class="muted" style="font-size:var(--fs-caption)">
        节点 {{ nodeTotal }} · 边 {{ edgeTotal }}
      </span>
    </template>

    <CardState
      :loading="fetching && !schema && !isError"
      :is-error="isError"
      :has-data="!!schema"
      empty-text="暂无图谱结构数据"
      error-text="Schema 请求失败"
      empty-hint="请确认 graph-memory-pro v2.3.3+ 服务已启动。"
      @retry="loadSchema"
    >
      <!-- 头部元信息：向量维度 / 索引模型 -->
      <NDescriptions :column="2" size="small" label-placement="left" bordered style="margin-bottom:8px">
        <NDescriptionsItem label="向量维度">
          <span v-if="schema?.vectorDimension != null" class="mono" style="color:var(--color-info)">{{ schema.vectorDimension }}</span>
          <NTag v-else size="small" type="warning" :bordered="false">未配置</NTag>
        </NDescriptionsItem>
        <NDescriptionsItem label="索引模型">
          <span v-if="schema?.indexingModels" class="mono">{{ schema.indexingModels }}</span>
          <span v-else class="muted">—</span>
        </NDescriptionsItem>
      </NDescriptions>

      <div class="two-cols">
        <!-- 左：节点类型分布 -->
        <div class="col">
          <div class="col-title">节点类型（{{ schema?.nodeTypes?.length ?? 0 }} 类）</div>
          <NEmpty v-if="!schema?.nodeTypes?.length" description="暂无节点类型数据" style="padding:4px 0" :style="{ fontSize: 'var(--fs-caption)' }" />
          <div v-else class="bar-list">
            <div v-for="t in schema.nodeTypes" :key="t.label" class="bar-row" :title="`${t.label}: ${t.count}`">
              <span class="bar-label">{{ t.label }}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :style="{
                    width: (t.count / nodeMax * 100).toFixed(1) + '%',
                    background: barColorActive,
                  }"
                />
              </div>
              <span class="bar-count mono">{{ t.count }}</span>
            </div>
          </div>
        </div>
        <!-- 右：边类型分布 -->
        <div class="col">
          <div class="col-title">边类型（{{ schema?.edgeTypes?.length ?? 0 }} 类）</div>
          <NEmpty v-if="!schema?.edgeTypes?.length" description="暂无边类型数据" style="padding:4px 0" :style="{ fontSize: 'var(--fs-caption)' }" />
          <div v-else class="bar-list">
            <div v-for="t in schema.edgeTypes" :key="t.type" class="bar-row" :title="`${t.type}: ${t.count}`">
              <span class="bar-label edge">{{ t.type }}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :style="{
                    width: (t.count / edgeMax * 100).toFixed(1) + '%',
                    background: barColorActive,
                    opacity: 0.85,
                  }"
                />
              </div>
              <span class="bar-count mono">{{ t.count }}</span>
            </div>
          </div>
        </div>
      </div>
    </CardState>
  </NCard>
</template>

<style scoped>
.two-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.col { min-width: 0; }
.col-title {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  margin-bottom: 4px;
}
.bar-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow-y: auto;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bar-label {
  font-size: var(--fs-caption);
  min-width: 64px;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar-label.edge { color: var(--color-info); }
.bar-track {
  flex: 1;
  height: 12px;
  border-radius: 6px;
  background: var(--color-border-subtle);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 6px;
  transition: width 0.3s ease;
  min-width: 2px;
}
.bar-count {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  min-width: 32px;
  text-align: right;
}
@media (max-width: 640px) {
  .two-cols { grid-template-columns: 1fr; }
}
</style>
