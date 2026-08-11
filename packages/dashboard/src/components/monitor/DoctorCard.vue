<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NTag, NDescriptions, NDescriptionsItem, NSpace } from 'naive-ui';
import CardState from './CardState.vue';

const props = defineProps<{
  doctor: any | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

// 整体健康摘要：统计 neo4j/llm/embedding/auto_feedback 中的异常项数
const abnormalCount = computed(() => {
  const d = props.doctor;
  if (!d) return 0;
  let n = 0;
  if (!d.neo4j?.ok) n++;
  if (!d.llm?.ok) n++;
  if (!d.embedding?.ok) n++;
  if (d.auto_feedback && !d.auto_feedback.ok) n++;
  return n;
});
</script>

<template>
  <NCard title="系统诊断 (Doctor)" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!doctor"
      empty-text="暂无诊断报告"
      error-text="系统诊断请求失败"
      empty-hint="请确认 openclaw.json 中 graph-memory-pro 的 apiServer.authToken 已配置（/api/doctor 为敏感路径需鉴权）。"
      @retry="emit('retry')"
    >
      <div style="margin-bottom: 8px">
        <NTag :type="abnormalCount === 0 ? 'success' : 'error'" size="small">
          {{ abnormalCount === 0 ? '全部正常' : `${abnormalCount} 项异常` }}
        </NTag>
      </div>
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="Neo4j">
          <NTag :type="doctor.neo4j?.ok ? 'success' : 'error'" size="small">{{ doctor.neo4j?.ok ? '连通' : '异常' }}</NTag>
        </NDescriptionsItem>
        <NDescriptionsItem label="LLM">
          <NTag :type="doctor.llm?.ok ? 'success' : 'error'" size="small">{{ doctor.llm?.ok ? '连通' : '异常' }}</NTag>
        </NDescriptionsItem>
        <NDescriptionsItem label="Embedding">
          <NTag :type="doctor.embedding?.ok ? 'success' : 'error'" size="small">{{ doctor.embedding?.ok ? '连通' : '异常' }}</NTag>
        </NDescriptionsItem>
        <NDescriptionsItem v-if="doctor.auto_feedback" label="Auto-Feedback">
          <NTag :type="doctor.auto_feedback?.ok ? 'success' : 'error'" size="small">
            {{ doctor.auto_feedback?.ok ? '正常' : '异常' }}
          </NTag>
          <span v-if="doctor.auto_feedback?.sessionCacheSize != null" class="muted" style="margin-left:8px; font-size:var(--fs-caption)">
            cache: {{ doctor.auto_feedback.sessionCacheSize }}
          </span>
        </NDescriptionsItem>
        <NDescriptionsItem v-if="doctor.issues?.length" label="问题">
          <NSpace :size="4">
            <NTag v-for="(issue, i) in doctor.issues" :key="i" size="small" type="warning">{{ issue }}</NTag>
          </NSpace>
        </NDescriptionsItem>
      </NDescriptions>
    </CardState>
  </NCard>
</template>
