<script setup lang="ts">
/**
 * 关联矩阵 M：维度 × 时间步热力图 + applied/rejected 比率条。
 */
import { computed } from 'vue';
import { NCard, NDescriptions, NDescriptionsItem, NProgress } from 'naive-ui';
import EChart from '../EChart.vue';
import CardState from './CardState.vue';
import { useTheme } from '../../composables/useTheme';

const props = defineProps<{
  am: any | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();
const { isDark } = useTheme();

/** applied vs rejected 比率 */
const appliedPercentage = computed(() => {
  const a = props.am?.applied ?? 0;
  const r = props.am?.rejected ?? 0;
  const total = a + r;
  return total > 0 ? Math.round((a / total) * 100) : null;
});

/** 热力图 option：维度 × 时间步 */
const heatmapOption = computed(() => {
  const dims = props.am?.dimensions ?? 0;
  const steps = props.am?.timeSteps ?? 0;
  if (!dims || !steps) return null;

  // 构建二维数据 [dim, step, value]
  const matrix = props.am?.matrix as number[][] | undefined;
  const data: [number, number, number][] = [];
  if (matrix && Array.isArray(matrix)) {
    for (let d = 0; d < Math.min(dims, matrix.length); d++) {
      const row = matrix[d];
      if (Array.isArray(row)) {
        for (let s = 0; s < Math.min(steps, row.length); s++) {
          data.push([s, d, row[s] ?? 0]);
        }
      }
    }
  } else {
    // 无矩阵数据时生成空热力图框架
    for (let d = 0; d < dims; d++) {
      for (let s = 0; s < steps; s++) {
        data.push([s, d, 0]);
      }
    }
  }

  const maxVal = data.length ? Math.max(...data.map(d => d[2])) : 1;

  return {
    tooltip: {
      position: 'top' as const,
      formatter: (params: any) => `dim ${params.value[1]}, step ${params.value[0]}<br/>value: ${params.value[2]}`,
    },
    grid: { left: 30, right: 8, top: 8, bottom: 24, containLabel: true },
    xAxis: {
      type: 'category' as const,
      data: Array.from({ length: steps }, (_, i) => `t${i}`),
      splitArea: { show: true },
      axisLabel: { fontSize: 9, color: isDark.value ? '#aaa' : '#666' },
    },
    yAxis: {
      type: 'category' as const,
      data: Array.from({ length: dims }, (_, i) => `d${i}`),
      splitArea: { show: true },
      axisLabel: { fontSize: 9, color: isDark.value ? '#aaa' : '#666' },
    },
    visualMap: {
      min: 0,
      max: maxVal || 1,
      calculable: false,
      orient: 'horizontal' as const,
      left: 'center' as const,
      bottom: 0,
      itemWidth: 10,
      itemHeight: 60,
      textStyle: { fontSize: 9, color: isDark.value ? '#aaa' : '#666' },
      inRange: { color: isDark.value ? ['#1a3a5c', '#36ad6a'] : ['#e8f5e9', '#18a058'] },
    },
    series: [{
      type: 'heatmap',
      data,
      label: { show: false },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.3)' } },
    }],
  };
});
</script>

<template>
  <NCard title="关联矩阵 M" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!am"
      empty-text="暂无关联矩阵数据"
      error-text="关联矩阵请求失败"
      empty-hint="请确认 openclaw.json 中 associationMatrix 已启用。"
      @retry="emit('retry')"
    >
      <NDescriptions :column="2" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="维度"><span class="mono">{{ am.dimensions ?? '—' }}</span></NDescriptionsItem>
        <NDescriptionsItem label="时间步"><span class="mono">{{ am.timeSteps ?? '—' }}</span></NDescriptionsItem>
        <NDescriptionsItem label="已应用"><span class="mono" style="color: var(--color-success)">{{ am.applied ?? '—' }}</span></NDescriptionsItem>
        <NDescriptionsItem label="被拒"><span class="mono" style="color: var(--color-danger)">{{ am.rejected ?? '—' }}</span></NDescriptionsItem>
      </NDescriptions>

      <!-- applied 比率条 -->
      <div v-if="appliedPercentage !== null" style="margin-top:8px">
        <div class="ratio-label">
          <span class="muted" style="font-size:var(--fs-caption)">应用率</span>
          <span class="mono" style="font-size:var(--fs-caption)">{{ appliedPercentage }}%</span>
        </div>
        <NProgress
          type="line"
          :percentage="appliedPercentage"
          :height="6"
          :border-radius="3"
          :color="appliedPercentage > 70 ? '#18a058' : appliedPercentage > 40 ? '#f0a020' : '#d03050'"
          :rail-color="isDark ? '#333' : '#e8e8e8'"
          :show-indicator="false"
        />
      </div>

      <!-- 热力图 -->
      <div v-if="heatmapOption" style="margin-top:8px">
        <EChart :option="heatmapOption" :height="180" aria-label="关联矩阵热力图" />
      </div>
    </CardState>
  </NCard>
</template>

<style scoped>
.ratio-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 2px;
}
</style>
