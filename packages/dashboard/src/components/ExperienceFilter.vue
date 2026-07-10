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
import { computed, reactive, ref, watch } from 'vue';
import {
  NForm,
  NFormItem,
  NSelect,
  NDatePicker,
  NInput,
  NInputNumber,
  NButton,
  NSpace,
  NBadge,
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

// L8 修复：dateRange 改 ref，支持 v-model 直绑 NDatePicker
const dateRange = ref<[number, number] | null>(
  props.modelValue.from && props.modelValue.to
    ? [props.modelValue.from, props.modelValue.to]
    : null,
);

// M13 修复：激活条件数 badge（非默认值视为激活）
const activeFilterCount = computed(() => {
  let count = 0;
  if (form.status && form.status !== 'all') count++;
  if (form.type) count++;
  if (dateRange.value) count++;
  if (form.tag) count++;
  if (form.projectName) count++;
  return count;
});

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

function applyFilter(): void {
  // 把表单内值同步到 modelValue（触发父组件 useQuery 重新拉取）
  const next: ExperienceListParams = {
    status: form.status || 'all',
    type: form.type || undefined,
    from: dateRange.value ? dateRange.value[0] : undefined,
    to: dateRange.value ? dateRange.value[1] : undefined,
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
  dateRange.value = null;
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
        v-model:value="dateRange"
        type="datetimerange"
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
      <!-- M13 修复：激活条件数 badge（>0 时显示） -->
      <NBadge :value="activeFilterCount" :show="activeFilterCount > 0" type="info">
        <NButton type="primary" size="small" @click="applyFilter">应用</NButton>
      </NBadge>
      <NButton size="small" @click="resetFilter">重置</NButton>
    </NSpace>
  </NForm>
</template>
