<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NTag, NDescriptions, NDescriptionsItem, NSpace } from 'naive-ui';
import CardState from './CardState.vue';

const props = defineProps<{
  doctor: any | null;
  loading?: boolean;
  isError?: boolean;
  /** 为空时的提示文案（默认提示鉴权；若请求失败可传入真实原因，避免误报） */
  hint?: string;
}>();

const emit = defineEmits<{ retry: [] }>();

/**
 * graph-memory-pro /api/doctor 返回格式：
 *   { status, version, timestamp,
 *     summary: { ok, warn, error, total },
 *     checks: [{ name, status: "ok"|"warn"|"error", latencyMs?, detail?, hint? }] }
 * 前端按 checks 数组渲染，而非旧版 top-level 的 neo4j/llm/embedding 对象。
 */
interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  latencyMs?: number;
  detail?: string;
  hint?: string;
}

const checks = computed<DoctorCheck[]>(() => {
  const d = props.doctor;
  const list = d?.checks;
  return Array.isArray(list) ? (list as DoctorCheck[]) : [];
});

const summary = computed(() => {
  const d = props.doctor;
  return d?.summary ?? {
    ok: checks.value.filter((c) => c.status === 'ok').length,
    warn: checks.value.filter((c) => c.status === 'warn').length,
    error: checks.value.filter((c) => c.status === 'error').length,
    total: checks.value.length,
  };
});

// 异常项数（status === "error"）
const abnormalCount = computed(() => summary.value.error ?? 0);

const checkTagType = (s: string): 'success' | 'warning' | 'error' | 'default' => {
  if (s === 'ok') return 'success';
  if (s === 'warn') return 'warning';
  if (s === 'error') return 'error';
  return 'default';
};

const checkLabel = (s: string): string => {
  if (s === 'ok') return '正常';
  if (s === 'warn') return '警告';
  if (s === 'error') return '异常';
  return s;
};
</script>

<template>
  <NCard title="系统诊断 (Doctor)" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!doctor"
      empty-text="暂无诊断报告"
      error-text="系统诊断请求失败"
      :empty-hint="props.hint || '请确认 openclaw.json 中 graph-memory-pro 的 apiServer.authToken 已配置（/api/doctor 为敏感路径需鉴权）。'"
      @retry="emit('retry')"
    >
      <div style="margin-bottom: 8px">
        <NTag :type="abnormalCount === 0 ? 'success' : 'error'" size="small">
          {{ abnormalCount === 0 ? '全部正常' : `${abnormalCount} 项异常` }}
        </NTag>
        <span v-if="summary.total" class="muted" style="margin-left:6px;font-size:var(--fs-caption)">
          正常 {{ summary.ok }} · 警告 {{ summary.warn }} · 异常 {{ summary.error }}
        </span>
      </div>
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem v-for="c in checks" :key="c.name" :label="c.name">
          <NTag :type="checkTagType(c.status)" size="small">{{ checkLabel(c.status) }}</NTag>
          <span v-if="c.latencyMs != null" class="muted mono" style="margin-left:6px;font-size:var(--fs-caption)">
            {{ c.latencyMs }}ms
          </span>
          <div v-if="c.detail" class="muted" style="font-size:var(--fs-caption);word-break:break-all">{{ c.detail }}</div>
          <div v-if="c.hint" class="muted" style="font-size:var(--fs-caption);color:var(--color-warning);word-break:break-all">{{ c.hint }}</div>
        </NDescriptionsItem>
      </NDescriptions>
    </CardState>
  </NCard>
</template>
