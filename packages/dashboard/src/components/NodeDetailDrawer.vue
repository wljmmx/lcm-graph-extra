<script setup lang="ts">
/**
 * NodeDetailDrawer —— 图谱节点详情抽屉。
 *
 * - 展示节点 id / name / type / pagerank
 * - 点击图谱节点时由父组件打开
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
    @update:show="emit('update:show', $event)"
  >
    <NDrawerContent title="节点详情" closable>
      <template v-if="props.node">
        <NDescriptions :column="1" bordered size="small" label-placement="left">
          <NDescriptionsItem label="ID">
            <span class="mono">{{ props.node.id }}</span>
          </NDescriptionsItem>
          <NDescriptionsItem label="名称">{{ props.node.name }}</NDescriptionsItem>
          <NDescriptionsItem label="类型">
            <NTag size="small">{{ props.node.type }}</NTag>
          </NDescriptionsItem>
          <NDescriptionsItem label="PageRank">
            {{ (props.node.pagerank ?? 0).toFixed(4) }}
          </NDescriptionsItem>
        </NDescriptions>
      </template>
      <NEmpty v-else description="未选中节点" />

      <template #footer>
        <NButton size="small" @click="close">关闭</NButton>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}
</style>
