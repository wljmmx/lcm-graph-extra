<script setup lang="ts">
import { NCard, NTag, NDescriptions, NDescriptionsItem, NEmpty } from 'naive-ui';

defineProps<{
  tuner: any | null;
}>();
</script>

<template>
  <NCard title="AutoTuner 调优" size="small">
    <template v-if="tuner">
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="启用状态">
          <NTag size="small" :type="tuner.enabled ? 'success' : 'warning'">
            {{ tuner.enabled ? '已启用' : '未启用' }}
          </NTag>
          <span v-if="!tuner.enabled && tuner.reason" class="muted" style="font-size:var(--fs-caption);margin-left:6px">{{ tuner.reason }}</span>
        </NDescriptionsItem>
        <NDescriptionsItem label="数据可用">
          <NTag size="small" :type="tuner.available ? 'success' : 'warning'">{{ tuner.available ? '是' : '否' }}</NTag>
          <span v-if="!tuner.available && tuner.reason" class="muted" style="font-size:var(--fs-caption);margin-left:6px">{{ tuner.reason }}</span>
        </NDescriptionsItem>
        <template v-if="tuner.available">
          <NDescriptionsItem label="调优轮次"><span class="mono">{{ tuner.state?.totalRounds ?? '—' }}</span></NDescriptionsItem>
          <NDescriptionsItem label="快照数"><span class="mono">{{ tuner.state?.snapshots?.length ?? '—' }}</span></NDescriptionsItem>
        </template>
      </NDescriptions>
    </template>
    <NEmpty v-else description="暂无调优数据" style="padding: 12px 0">
      <template #extra>
        <span class="muted" style="font-size:var(--fs-caption)">请确认 openclaw.json 中 autoTuner 已启用，且 gm-pro 服务可达。</span>
      </template>
    </NEmpty>
  </NCard>
</template>