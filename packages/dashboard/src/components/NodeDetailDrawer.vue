<script setup lang="ts">
/**
 * NodeDetailDrawer —— 图谱节点详情抽屉。
 *
 * - 展示节点 id / name / type / pagerank
 * - 点击图谱节点时由父组件打开
 * - pagerank 用 format.ts 格式化（4 位小数）
 * - M4 修复：loading/error 态 + 响应式宽度
 * - role="dialog" + aria-label 暴露语义给屏幕阅读器
 */
import { computed } from 'vue';
import {
  NDrawer,
  NDrawerContent,
  NDescriptions,
  NDescriptionsItem,
  NTag,
  NEmpty,
  NButton,
  NSpin,
  NAlert,
} from 'naive-ui';
import { useBreakpoints } from '../composables/useBreakpoints';
import type { MemoryGraphNode } from '../api/memory';
import { formatFloat2 } from '../utils/format';

const props = withDefaults(
  defineProps<{
    show: boolean;
    node: MemoryGraphNode | null;
    /** M4 修复：加载中态 */
    loading?: boolean;
    /** M4 修复：加载失败态 */
    error?: boolean;
  }>(),
  { loading: false, error: false },
);

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
}>();

// M4 修复：窄屏全宽，宽屏固定 480px
const breakpoints = useBreakpoints({ xs: 0, s: 640, m: 768, l: 1024, xl: 1280 });
const isNarrowScreen = breakpoints.smaller('m');
const drawerWidth = computed<number | string>(() =>
  isNarrowScreen.value ? '100%' : 480,
);

function close(): void {
  emit('update:show', false);
}
</script>

<template>
  <NDrawer
    :show="props.show"
    :width="drawerWidth"
    placement="right"
    :trap-focus="true"
    :auto-focus="true"
    :close-on-esc="true"
    role="dialog"
    aria-modal="true"
    aria-label="节点详情"
    @update:show="emit('update:show', $event)"
  >
    <NDrawerContent title="节点详情" closable>
      <!-- M4 修复：loading / error 态 -->
      <NAlert
        v-if="props.error"
        type="error"
        :show-icon="true"
        title="节点详情加载失败"
      >
        查询失败，请稍后重试。
      </NAlert>
      <NSpin v-else-if="props.loading && !props.node" size="small">
        <template #default>加载中…</template>
      </NSpin>
      <template v-else-if="props.node">
        <NDescriptions
          :column="1"
          bordered
          size="small"
          label-placement="left"
          aria-label="节点详情"
        >
          <NDescriptionsItem label="ID">
            <span class="mono">{{ props.node.id }}</span>
          </NDescriptionsItem>
          <NDescriptionsItem label="名称">{{ props.node.name }}</NDescriptionsItem>
          <NDescriptionsItem label="类型">
            <NTag size="small">{{ props.node.type }}</NTag>
          </NDescriptionsItem>
          <NDescriptionsItem label="PageRank">
            <span class="mono">{{ formatFloat2(props.node.pagerank ?? 0) }}</span>
          </NDescriptionsItem>
        </NDescriptions>
      </template>
      <NEmpty v-else description="未选中节点" />

      <template #footer>
        <NButton size="small" aria-label="关闭节点详情抽屉" @click="close">关闭</NButton>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<!-- .mono 已在 tokens.css 全局定义，此处不再重复声明 -->
