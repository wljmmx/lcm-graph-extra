<script setup lang="ts">
import { NCard, NDescriptions, NDescriptionsItem, NEmpty } from 'naive-ui';
import { formatTokens } from '../../utils/format';

defineProps<{
  usage: any | null;
}>();
</script>

<template>
  <NCard title="LLM Token 用量" size="small">
    <template v-if="usage">
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="总调用次数"><span class="mono">{{ usage.total?.calls ?? '—' }}</span></NDescriptionsItem>
        <NDescriptionsItem label="总 Token"><span class="mono">{{ formatTokens(usage.total?.totalTokens ?? 0) }}</span></NDescriptionsItem>
        <NDescriptionsItem label="Prompt"><span class="mono">{{ formatTokens(usage.total?.promptTokens ?? 0) }}</span></NDescriptionsItem>
        <NDescriptionsItem label="Completion"><span class="mono">{{ formatTokens(usage.total?.completionTokens ?? 0) }}</span></NDescriptionsItem>
        <NDescriptionsItem v-if="usage.byModel" label="模型分布">
          <div class="model-dist">
            <div v-for="(v, k) in usage.byModel" :key="k" class="model-row">
              <span class="mono">{{ k }}:</span> {{ formatTokens(v.totalTokens ?? 0) }}
            </div>
          </div>
        </NDescriptionsItem>
      </NDescriptions>
    </template>
    <NEmpty v-else description="暂无用量数据" style="padding: 12px 0" />
  </NCard>
</template>

<style scoped>
.model-dist { max-height: 100px; overflow-y: auto; }
.model-row { font-size: var(--fs-caption); padding: 2px 0; }
</style>