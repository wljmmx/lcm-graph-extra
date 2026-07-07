<script setup lang="ts">
/**
 * NodeDetailDrawer —— 图谱节点详情抽屉。
 *
 * - 展示节点 id / name / type / pagerank
 * - 点击图谱节点时由父组件打开
 * - pagerank 用 format.ts 格式化（4 位小数）
 * - role="dialog" + aria-label 暴露语义给屏幕阅读器
 */
import {
  NDrawer,
  NDrawerContent,
  NDescriptions,
  NDescriptionsItem,
  NTag,
  NEmpty,
  NButton,
} from 'naive-ui';
import type { MemoryGraphNode } from '../api/memory';
import { formatFloat2 } from '../utils/format';

const props = defineProps<{
  show: boolean;
  node: MemoryGraphNode | null;
}>();

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
}>();

function close(): void {
  emit('update:show', false);
}
</script>

<template>
  <NDrawer
    :show="props.show"
    :width="480"
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
      <template v-if="props.node">
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
