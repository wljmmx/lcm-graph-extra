<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NDescriptions, NDescriptionsItem, NProgress } from 'naive-ui';
import CardState from './CardState.vue';
import EChart from '../EChart.vue';
import { formatTokens } from '../../utils/format';

const props = defineProps<{
  usage: any | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

/** Prompt / Completion 占比环形图 */
const tokenSplitOption = computed<Record<string, unknown>>(() => {
  const total = props.usage?.total;
  const prompt = total?.promptTokens ?? 0;
  const completion = total?.completionTokens ?? 0;
  if (prompt + completion <= 0) return {};
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0 },
    series: [{
      type: 'pie',
      radius: ['52%', '72%'],
      center: ['50%', '46%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 4, borderColor: 'transparent', borderWidth: 2 },
      label: { show: false },
      data: [
        { name: 'Prompt', value: prompt },
        { name: 'Completion', value: completion },
      ],
    }],
  };
});

/** 模型级 Token 分布（水平占比条） */
const modelRows = computed<Array<{ model: string; tokens: number; pct: number }>>(() => {
  const byModel = props.usage?.byModel;
  if (!byModel || typeof byModel !== 'object') return [];
  const total = Object.values<any>(byModel).reduce((s, v) => s + (v?.totalTokens ?? 0), 0);
  if (total <= 0) return [];
  return Object.entries<any>(byModel)
    .map(([model, v]) => ({ model, tokens: v?.totalTokens ?? 0, pct: ((v?.totalTokens ?? 0) / total) * 100 }))
    .sort((a, b) => b.tokens - a.tokens);
});
</script>

<template>
  <NCard title="LLM Token 用量" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!usage"
      empty-text="暂无 Token 用量数据"
      error-text="Token 用量请求失败"
      empty-hint="请确认 graph-memory-pro 服务已启动。"
      @retry="emit('retry')"
    >
      <NDescriptions :column="2" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="总调用次数"><span class="mono">{{ usage.total?.calls ?? '—' }}</span></NDescriptionsItem>
        <NDescriptionsItem label="总 Token"><span class="mono">{{ formatTokens(usage.total?.totalTokens ?? 0) }}</span></NDescriptionsItem>
      </NDescriptions>

      <!-- Prompt / Completion 占比 -->
      <div style="margin-top: 10px">
        <div class="ratio-label">
          <span class="muted" style="font-size:var(--fs-caption)">Prompt / Completion 占比</span>
        </div>
        <EChart :option="tokenSplitOption" height="160px" aria-label="LLM Token 用量环形图：Prompt 与 Completion 占比" />
      </div>

      <!-- 模型分布占比条 -->
      <div v-if="modelRows.length" style="margin-top: 8px">
        <div class="ratio-label">
          <span class="muted" style="font-size:var(--fs-caption)">模型分布（按 Token）</span>
        </div>
        <div class="model-dist">
          <div v-for="m in modelRows" :key="m.model" class="model-row">
            <span class="model-name mono">{{ m.model }}</span>
            <NProgress
              type="line"
              :percentage="m.pct"
              :height="6"
              :border-radius="3"
              :show-indicator="false"
              style="flex:1"
            />
            <span class="model-val mono">{{ formatTokens(m.tokens) }} · {{ m.pct.toFixed(0) }}%</span>
          </div>
        </div>
      </div>
    </CardState>
  </NCard>
</template>

<style scoped>
.ratio-label { display: flex; justify-content: space-between; margin-bottom: 4px; }
.model-dist { max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.model-row { display: flex; align-items: center; gap: 8px; }
.model-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-val { font-size: var(--fs-caption); white-space: nowrap; }
</style>