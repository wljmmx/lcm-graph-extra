<script setup lang="ts">
/**
 * OperationCard —— 维护操作卡片通用组件（模块 4）。
 *
 * - NCard + 标题 + 描述 + form slot + 执行按钮
 * - danger=true 时按钮用 error type，边框/标题红色
 * - confirmLevel=0：点击即执行
 * - confirmLevel=1：NPopconfirm 二次确认
 * - confirmLevel=2：NPopconfirm 链式两次确认（三次确认）
 *
 * 不持有业务状态：表单数据由父组件通过 v-model 维护，
 * 本组件仅负责 UI 框架 + 确认流程；点击执行 emit('execute')，
 * 父组件在回调中读取自身表单状态后调用对应 invoke 函数。
 *
 * danger / confirmLevel 均为响应式：父组件可动态切换（如 sync 卡片
 * 在 mode=repair 时升级为 danger + 二次确认）。
 */
import { computed, ref, watch, onUnmounted } from 'vue';
import { NCard, NButton, NPopconfirm, NTag, NSpace } from 'naive-ui';
import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{
    title: string;
    description: string;
    /** 图标名（Icon 组件 name，如 'refresh'/'trash'/'save'） */
    icon?: string;
    /** 危险操作：按钮 type=error，标题红色 */
    danger?: boolean;
    /** 0=直接执行，1=二次确认，2=三次确认 */
    confirmLevel?: 0 | 1 | 2;
    /** 是否加载中（执行按钮禁用 + loading） */
    loading?: boolean;
  }>(),
  {
    icon: '',
    danger: false,
    confirmLevel: 0,
    loading: false,
  },
);

const emit = defineEmits<{
  (e: 'execute'): void;
}>();

// confirmLevel=2 时的二次确认状态：第一次确认后切换到第二次确认按钮
const secondConfirmPending = ref(false);

/** 第一次确认通过：confirmLevel=1 直接执行；confirmLevel=2 进入第二次确认 */
function onFirstConfirm(): void {
  if (props.confirmLevel >= 2) {
    secondConfirmPending.value = true;
  } else {
    emit('execute');
  }
}

/** 第二次确认通过：实际执行 */
function onFinalConfirm(): void {
  secondConfirmPending.value = false;
  emit('execute');
}

/** 取消第二次确认：回到初始状态 */
function onCancelSecondConfirm(): void {
  secondConfirmPending.value = false;
}

/** 按钮直接点击（confirmLevel=0） */
function onDirectClick(): void {
  if (props.confirmLevel === 0) {
    emit('execute');
  }
}

// 按钮类型 / 标题颜色响应式跟随 danger（sync 卡片会动态切换）
const buttonType = computed<'error' | 'primary'>(() =>
  props.danger ? 'error' : 'primary',
);
const titleColor = computed<string | undefined>(() =>
  props.danger ? 'var(--color-danger)' : undefined,
);

// 屏幕阅读器：执行按钮的语义化标签
const executeAriaLabel = computed(() => {
  const parts = [`执行 ${props.title}`];
  if (props.danger) parts.push('危险操作');
  if (props.confirmLevel === 1) parts.push('需二次确认');
  if (props.confirmLevel === 2) parts.push('需三次确认');
  return parts.join('，');
});

// H7 修复：长操作进度反馈 —— 加载中显示已耗时（无后端进度上报时的诚实反馈）
const elapsedSec = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

watch(
  () => props.loading,
  (loading) => {
    if (loading) {
      elapsedSec.value = 0;
      timer = setInterval(() => { elapsedSec.value += 1; }, 1000);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  },
);

onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const elapsedLabel = computed(() => {
  const s = elapsedSec.value;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
});
</script>

<template>
  <NCard
    size="small"
    :bordered="true"
    :class="['operation-card', { 'operation-card-danger': danger }]"
  >
    <!-- 标题 + 危险标签 -->
    <div class="card-header">
      <NSpace align="center" :size="6">
        <Icon v-if="icon" :name="icon" :size="16" />
        <!-- L1 修复：danger 态无自定义图标时，用 warning 图标补位 -->
        <Icon v-else-if="danger" name="warning" :size="16" />
        <span class="card-title" :style="{ color: titleColor }">{{ title }}</span>
        <NTag v-if="danger" size="small" type="error">危险</NTag>
        <NTag v-if="confirmLevel === 2" size="small" type="warning">三次确认</NTag>
        <NTag v-else-if="confirmLevel === 1" size="small" type="warning">二次确认</NTag>
      </NSpace>
    </div>

    <div class="card-desc">{{ description }}</div>

    <!-- H7 修复：长操作运行时显示已耗时 + 不确定进度条 -->
    <div v-if="loading" class="card-progress" role="status" aria-live="polite">
      <div class="progress-bar-indeterminate"><div class="progress-bar-fill" /></div>
      <span class="progress-elapsed">执行中… 已耗时 {{ elapsedLabel }}</span>
    </div>

    <!-- 参数表单 slot -->
    <div class="card-form">
      <slot name="form" />
    </div>

    <!-- 执行按钮：根据 confirmLevel 切换 UI -->
    <div class="card-footer">
      <!-- confirmLevel=0：直接执行 -->
      <NButton
        v-if="confirmLevel === 0"
        :type="buttonType"
        size="small"
        :loading="loading"
        :disabled="loading"
        :aria-label="executeAriaLabel"
        @click="onDirectClick"
      >
        执行
      </NButton>

      <!-- confirmLevel=1：单次 NPopconfirm -->
      <NPopconfirm
        v-else-if="confirmLevel === 1"
        placement="top"
        @positive-click="onFirstConfirm"
      >
        <template #trigger>
          <NButton
            :type="buttonType"
            size="small"
            :loading="loading"
            :disabled="loading"
            :aria-label="executeAriaLabel"
          >
            执行
          </NButton>
        </template>
        确认执行「{{ title }}」？此操作可能影响数据。
      </NPopconfirm>

      <!-- confirmLevel=2：两次 NPopconfirm 链式 -->
      <template v-else>
        <NPopconfirm
          v-if="!secondConfirmPending"
          placement="top"
          @positive-click="onFirstConfirm"
        >
          <template #trigger>
            <NButton
              :type="buttonType"
              size="small"
              :loading="loading"
              :disabled="loading"
              :aria-label="`${executeAriaLabel}，第一次确认`"
            >
              执行
            </NButton>
          </template>
          <span class="warn-text"><Icon name="warning" :size="12" /> 危险操作：{{ title }}。第一次确认（共 2 次）。</span>
        </NPopconfirm>

        <NPopconfirm
          v-else
          placement="top"
          @positive-click="onFinalConfirm"
          @negative-click="onCancelSecondConfirm"
        >
          <template #trigger>
            <NButton
              :type="buttonType"
              size="small"
              :loading="loading"
              :disabled="loading"
              :aria-label="`${executeAriaLabel}，最终确认`"
            >
              再次确认
            </NButton>
          </template>
          <span class="warn-text-strong"><Icon name="danger" :size="12" /> 最终确认：此操作不可逆！确定继续？</span>
        </NPopconfirm>
      </template>
    </div>
  </NCard>
</template>

<style scoped>
.operation-card {
  height: 100%;
}
.operation-card-danger {
  border-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
}
.card-header {
  margin-bottom: var(--space-xs);
}
.card-icon {
  font-size: var(--fs-subtitle);
}
.card-title {
  font-size: var(--fs-body);
  font-weight: 600;
}
.card-desc {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-sm);
  line-height: 1.5;
}
.card-form {
  margin-bottom: var(--space-sm);
}
/* H7：长操作进度反馈 */
.card-progress {
  margin-bottom: var(--space-sm);
}
.progress-bar-indeterminate {
  position: relative;
  width: 100%;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--color-fill-light);
  overflow: hidden;
}
.progress-bar-fill {
  position: absolute;
  inset: 0;
  width: 40%;
  border-radius: var(--radius-full);
  background: var(--color-primary);
  animation: op-progress-slide 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
@keyframes op-progress-slide {
  0% { left: -40%; }
  100% { left: 100%; }
}
.progress-elapsed {
  display: block;
  margin-top: 4px;
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
}
.card-footer {
  display: flex;
  justify-content: flex-end;
}
.warn-text {
  color: var(--color-danger);
}
.warn-text-strong {
  color: var(--color-danger);
  font-weight: 600;
}
</style>
