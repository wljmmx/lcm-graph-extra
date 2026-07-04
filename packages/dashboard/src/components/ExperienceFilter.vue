<script setup lang="ts">
/**
 * ExperienceFilter —— 经验过滤侧栏。
 *
 * - v-model 绑定 ExperienceListParams
 * - status/type 下拉 + 时间范围 + 项目名 + 分页大小
 * - 应用/重置按钮
 *
 * 应用按钮触发 update:modelValue，由父组件发起列表查询；
 * 重置按钮恢复默认空过滤。
 */
import { reactive, watch } from 'vue';
import {
  NForm,
  NFormItem,
  NSelect,
  NDatePicker,
  NInput,
  NInputNumber,
  NButton,
  NSpace,
} from 'naive-ui';
import type { ExperienceListParams } from '../api/experience';

const props = defineProps<{
  modelValue: ExperienceListParams;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: ExperienceListParams): void;
}>();

// 内部表单状态（深拷贝 modelValue，避免直接修改 props）
const form = reactive<ExperienceListParams>({
  status: props.modelValue.status,
  type: props.modelValue.type,
  from: props.modelValue.from,
  to: props.modelValue.to,
  tag: props.modelValue.tag,
  projectName: props.modelValue.projectName,
  limit: props.modelValue.limit,
  offset: props.modelValue.offset,
});

// 父组件外部修改时同步到内部表单
watch(
  () => props.modelValue,
  (v) => {
    form.status = v.status;
    form.type = v.type;
    form.from = v.from;
    form.to = v.to;
    form.tag = v.tag;
    form.projectName = v.projectName;
    form.limit = v.limit;
    form.offset = v.offset;
  },
  { deep: true },
);

// 时间范围：[from, to] 毫秒数组；表单内只暂存，应用时拆分写入 form.from / form.to
const dateRange = reactive<[number | null, number | null]>([
  props.modelValue.from ?? null,
  props.modelValue.to ?? null,
]);

const statusOptions = [
  { label: '全部', value: 'all' },
  { label: 'PENDING（待蒸馏）', value: 'PENDING' },
  { label: 'DISTILLED（已蒸馏）', value: 'DISTILLED' },
];

const typeOptions = [
  { label: '全部', value: '' },
  { label: 'lesson', value: 'lesson' },
  { label: 'failure', value: 'failure' },
  { label: 'correction', value: 'correction' },
  { label: 'fix', value: 'fix' },
  { label: 'best_practice', value: 'best_practice' },
];

function handleDateRangeChange(v: [number, number] | null): void {
  if (v && v.length === 2) {
    dateRange[0] = v[0];
    dateRange[1] = v[1];
  } else {
    dateRange[0] = null;
    dateRange[1] = null;
  }
}

function applyFilter(): void {
  // 把表单内值同步到 modelValue（触发父组件 useQuery 重新拉取）
  const next: ExperienceListParams = {
    status: form.status || 'all',
    type: form.type || undefined,
    from: dateRange[0] ?? undefined,
    to: dateRange[1] ?? undefined,
    tag: form.tag || undefined,
    projectName: form.projectName || undefined,
    limit: form.limit ?? 20,
    offset: 0, // 应用过滤时回到第一页
  };
  emit('update:modelValue', next);
}

function resetFilter(): void {
  form.status = 'all';
  form.type = undefined;
  form.tag = undefined;
  form.projectName = undefined;
  form.limit = 20;
  form.offset = 0;
  dateRange[0] = null;
  dateRange[1] = null;
  emit('update:modelValue', { status: 'all', limit: 20, offset: 0 });
}
</script>

<template>
  <NForm label-placement="top" size="small" :show-feedback="false">
    <NFormItem label="状态">
      <NSelect
        v-model:value="form.status"
        :options="statusOptions"
        placeholder="全部"
        clearable
      />
    </NFormItem>

    <NFormItem label="类型">
      <NSelect
        v-model:value="form.type"
        :options="typeOptions"
        placeholder="全部"
        clearable
      />
    </NFormItem>

    <NFormItem label="时间范围">
      <NDatePicker
        type="datetimerange"
        :value="dateRange[0] && dateRange[1] ? [dateRange[0], dateRange[1]] as [number, number] : null"
        @update:value="handleDateRangeChange"
        clearable
        style="width: 100%"
      />
    </NFormItem>

    <NFormItem label="标签 (communityId)">
      <NInput
        v-model:value="form.tag"
        placeholder="标签 ID"
        clearable
      />
    </NFormItem>

    <NFormItem label="项目名">
      <NInput
        v-model:value="form.projectName"
        placeholder="项目名（精确匹配）"
        clearable
      />
    </NFormItem>

    <NFormItem label="每页条数">
      <NInputNumber
        v-model:value="form.limit"
        :min="1"
        :max="100"
        style="width: 100%"
      />
    </NFormItem>

    <NSpace :size="8" style="margin-top: 12px">
      <NButton type="primary" size="small" @click="applyFilter">应用</NButton>
      <NButton size="small" @click="resetFilter">重置</NButton>
    </NSpace>
  </NForm>
</template>
