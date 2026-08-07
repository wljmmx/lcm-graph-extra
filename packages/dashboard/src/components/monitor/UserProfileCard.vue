<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NTag, NEmpty, NSpace } from 'naive-ui';
import type { DashboardSnapshot } from '../../api/health';

const props = defineProps<{
  memory: DashboardSnapshot | null;
}>();

const topTechStack = computed(() => {
  const ts = props.memory?.userProfile?.techStack ?? [];
  return [...ts].sort((a, b) => b.weight - a.weight).slice(0, 5);
});

const topScenario = computed(() => {
  const sc = props.memory?.userProfile?.scenario ?? [];
  return [...sc].sort((a, b) => b.weight - a.weight).slice(0, 5);
});

const userLanguage = computed(() => props.memory?.userProfile?.language ?? '—');
</script>

<template>
  <NCard title="用户画像" size="small">
    <template v-if="memory">
      <div class="section">
        <div class="label">技术栈 Top5</div>
        <NSpace :size="4" v-if="topTechStack.length">
          <NTag v-for="t in topTechStack" :key="t.name" size="small" type="info">{{ t.name }} ({{ t.weight }})</NTag>
        </NSpace>
        <span v-else class="muted">—</span>
      </div>
      <div class="section">
        <div class="label">场景 Top5</div>
        <NSpace :size="4" v-if="topScenario.length">
          <NTag v-for="s in topScenario" :key="s.name" size="small" type="success">{{ s.name }} ({{ s.weight }})</NTag>
        </NSpace>
        <span v-else class="muted">—</span>
      </div>
      <div class="section">
        <span class="label">语言：</span>
        <NTag size="small">{{ userLanguage }}</NTag>
      </div>
    </template>
    <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
  </NCard>
</template>

<style scoped>
.section { margin-bottom: var(--space-sm); }
.label {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-xs);
}
</style>