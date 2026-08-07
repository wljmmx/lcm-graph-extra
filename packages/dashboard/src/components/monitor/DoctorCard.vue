<script setup lang="ts">
import { NCard, NTag, NDescriptions, NDescriptionsItem, NEmpty, NSpace } from 'naive-ui';

defineProps<{
  doctor: any | null;
}>();
</script>

<template>
  <NCard title="系统诊断 (Doctor)" size="small">
    <template v-if="doctor">
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
    </template>
    <NEmpty v-else description="暂无诊断报告" style="padding: 12px 0">
      <template #extra>
        <span class="muted" style="font-size:var(--fs-caption)">请确认 GM_PRO_AUTH_TOKEN 已配置（/api/doctor 为敏感路径需鉴权）。</span>
      </template>
    </NEmpty>
  </NCard>
</template>