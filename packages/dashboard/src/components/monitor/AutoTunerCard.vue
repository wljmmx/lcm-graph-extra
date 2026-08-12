<script setup lang="ts">
/**
 * AutoTuner 调优：状态标签 + 调优轮次/快照 + sparkline 进度图。
 * v2.4.0 新增动作：触发调优轮次（POST /api/auto-tuner/tune）。
 */
import { computed, ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { NCard, NTag, NDescriptions, NDescriptionsItem, NButton, NPopconfirm, useMessage } from 'naive-ui';
import EChart from '../EChart.vue';
import CardState from './CardState.vue';
import { useTheme } from '../../composables/useTheme';
import { postGmProAutoTunerTune } from '../../api/gm-pro';

const props = defineProps<{
  tuner: any | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();
const { isDark } = useTheme();

const message = useMessage();
const queryClient = useQueryClient();
const tuning = ref(false);

const tunerEnabled = computed(() => props.tuner?.enabled === true);

/** v2.4.0: 触发一轮 AutoTuner 调优 */
async function handleTune(): Promise<void> {
  if (tuning.value) return;
  tuning.value = true;
  try {
    const res = await postGmProAutoTunerTune(1);
    if (res.ok) {
      const total = (res.data as { totalRounds?: number } | undefined)?.totalRounds;
      message.success(`调优已触发${total != null ? `（累计 ${total} 轮）` : ''}`);
      queryClient.invalidateQueries({ queryKey: ['gm-pro-auto-tuner'] });
    } else {
      message.error(`调优失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    message.error(`调优失败: ${err?.message || String(err)}`);
  } finally {
    tuning.value = false;
  }
}

/** 从快照列表中提取 metric 序列用于 sparkline */
const sparklineOption = computed(() => {
  const snapshots = props.tuner?.state?.snapshots;
  if (!snapshots || !Array.isArray(snapshots) || snapshots.length < 2) return null;

  // 尝试从快照中提取 score / loss / reward 等数值序列
  const extractMetric = (key: string): number[] => {
    return snapshots
      .map((s: any) => typeof s === 'object' ? (s[key] ?? s.metrics?.[key] ?? null) : null)
      .filter((v: any) => typeof v === 'number') as number[];
  };

  // 优先级：score > reward > loss > fitness
  const keys = ['score', 'reward', 'loss', 'fitness', 'value'];
  let metricKey = '';
  let values: number[] = [];
  for (const k of keys) {
    const v = extractMetric(k);
    if (v.length >= 2) { metricKey = k; values = v; break; }
  }

  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return {
    tooltip: {
      trigger: 'axis' as const,
      formatter: (params: any) => `Round ${params[0].dataIndex + 1}<br/>${metricKey}: ${params[0].value.toFixed(4)}`,
    },
    grid: { left: 0, right: 4, top: 4, bottom: 0, containLabel: false },
    xAxis: { type: 'category' as const, show: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value' as const, show: false, min: min - range * 0.1, max: max + range * 0.1 },
    series: [{
      type: 'line',
      data: values,
      smooth: true,
      symbol: 'none',
      lineStyle: { width: 2, color: isDark.value ? '#4098fc' : '#2080f0' },
      areaStyle: {
        color: {
          type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: isDark.value ? 'rgba(64,152,252,0.3)' : 'rgba(32,128,240,0.3)' },
            { offset: 1, color: isDark.value ? 'rgba(64,152,252,0.01)' : 'rgba(32,128,240,0.01)' },
          ],
        },
      },
    }],
  };
});
</script>

<template>
  <NCard title="AutoTuner 调优" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!tuner"
      empty-text="暂无调优数据"
      error-text="AutoTuner 请求失败"
      empty-hint="请确认 openclaw.json 中 autoTuner 已启用，且 gm-pro 服务可达。"
      @retry="emit('retry')"
    >
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="启用状态">
          <NTag size="small" :type="tuner.enabled ? 'success' : 'warning'">
            {{ tuner.enabled ? '已启用' : '未启用' }}
          </NTag>
          <span v-if="!tuner.enabled && tuner.reason" class="muted" style="font-size:var(--fs-caption);margin-left:6px">{{ tuner.reason }}</span>
        </NDescriptionsItem>
        <NDescriptionsItem label="数据可用">
          <NTag size="small" :type="tuner.available ? 'success' : 'warning'">{{ tuner.available ? '是' : '否' }}</NTag>
        </NDescriptionsItem>
        <template v-if="tuner.available">
          <NDescriptionsItem label="调优轮次"><span class="mono">{{ tuner.state?.totalRounds ?? '—' }}</span></NDescriptionsItem>
          <NDescriptionsItem label="快照数"><span class="mono">{{ tuner.state?.snapshots?.length ?? '—' }}</span></NDescriptionsItem>
        </template>
      </NDescriptions>

      <!-- sparkline 调优进度 -->
      <div v-if="sparklineOption" style="margin-top:8px">
        <div class="muted" style="font-size:var(--fs-caption);margin-bottom:2px">调优进度趋势</div>
        <EChart :option="sparklineOption" :height="60" aria-label="AutoTuner 调优进度趋势" />
      </div>

      <!-- v2.4.0 动作：触发调优轮次 -->
      <div style="margin-top:10px">
        <NPopconfirm @positive-click="handleTune">
          <template #trigger>
            <NButton
              size="tiny"
              type="primary"
              secondary
              :disabled="!tunerEnabled || tuning"
              :loading="tuning"
            >
              触发调优
            </NButton>
          </template>
          确定触发一轮 AutoTuner 调优？将运行一次 tune cycle 并持久化状态。
        </NPopconfirm>
        <span v-if="!tunerEnabled" class="muted" style="font-size:var(--fs-caption);margin-left:6px">
          需先在 openclaw.json 中启用 autoTuner。
        </span>
      </div>
    </CardState>
  </NCard>
</template>
