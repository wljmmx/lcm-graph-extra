<script setup lang="ts">
/**
 * MemorySearchBar —— 记忆搜索栏。
 *
 * - v-model: { q, engines, limit } 对象
 * - NInput（q，回车触发搜索）+ NSelect（engines）+ NInputNumber（limit）+ NButton（搜索）
 * - 任意字段变化都 emit update:modelValue；点击搜索/回车 emit search
 */
import { computed } from 'vue';
import { NInput, NSelect, NInputNumber, NButton, NSpace, type SelectOption } from 'naive-ui';

/** 搜索参数对象 */
export interface MemorySearchParams {
  q: string;
  engines: string;
  limit: number;
}

const props = defineProps<{ modelValue: MemorySearchParams }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: MemorySearchParams): void;
  (e: 'search'): void;
}>();

// 引擎选项（all/lcm_only/qmd_only/neo4j_only）
const enginesOptions: SelectOption[] = [
  { label: '全部引擎', value: 'all' },
  { label: 'LCM', value: 'lcm_only' },
  { label: 'QMD', value: 'qmd_only' },
  { label: 'Neo4j', value: 'neo4j_only' },
];

// 双向绑定：每个字段变化都更新整个 modelValue 对象
const q = computed({
  get: () => props.modelValue.q,
  set: (v: string) => emit('update:modelValue', { ...props.modelValue, q: v }),
});
const engines = computed({
  get: () => props.modelValue.engines,
  set: (v: string) => emit('update:modelValue', { ...props.modelValue, engines: v }),
});
const limit = computed({
  get: () => props.modelValue.limit,
  set: (v: number | null) =>
    emit('update:modelValue', { ...props.modelValue, limit: v ?? 10 }),
});

function onSearch(): void {
  emit('search');
}
</script>

<template>
  <NSpace
    align="center"
    :size="8"
    wrap
    role="search"
    aria-label="记忆搜索"
  >
    <NInput
      v-model:value="q"
      placeholder="输入搜索词（回车搜索）"
      clearable
      style="width: 320px"
      aria-label="搜索词"
      @keyup.enter="onSearch"
    />
    <NSelect
      v-model:value="engines"
      :options="enginesOptions"
      style="width: 140px"
      aria-label="选择检索引擎"
    />
    <NInputNumber
      v-model:value="limit"
      :min="1"
      :max="50"
      style="width: 110px"
      aria-label="结果数量上限"
    />
    <NButton
      type="primary"
      aria-label="执行搜索"
      @click="onSearch"
    >搜索</NButton>
  </NSpace>
</template>
