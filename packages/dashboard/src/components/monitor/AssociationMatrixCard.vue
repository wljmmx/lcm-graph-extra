<script setup lang="ts">
import { NCard, NDescriptions, NDescriptionsItem, NEmpty } from 'naive-ui';

defineProps<{
  am: any | null;
}>();
</script>

<template>
  <NCard title="关联矩阵 M" size="small">
    <template v-if="am">
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="维度"><span class="mono">{{ am.dimensions ?? '—' }}</span></NDescriptionsItem>
        <NDescriptionsItem label="时间步"><span class="mono">{{ am.timeSteps ?? '—' }}</span></NDescriptionsItem>
        <NDescriptionsItem label="已应用"><span class="mono">{{ am.applied ?? '—' }}</span></NDescriptionsItem>
        <NDescriptionsItem label="被拒"><span class="mono">{{ am.rejected ?? '—' }}</span></NDescriptionsItem>
      </NDescriptions>
    </template>
    <NEmpty v-else description="暂无关联矩阵数据" style="padding: 12px 0">
      <template #extra>
        <span class="muted" style="font-size:var(--fs-caption)">请确认 openclaw.json 中 associationMatrix 已启用，且 gm-pro 服务可达。</span>
      </template>
    </NEmpty>
  </NCard>
</template>