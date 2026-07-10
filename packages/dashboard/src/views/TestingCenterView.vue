<script setup lang="ts">
/**
 * 测试中心（v2.3.2）—— 整合"CE 引擎压测"和"QMD MCP 测试工具"的容器页面。
 *
 * 设计动机：
 *   压测（BenchmarkView）与 QMD 测试工具（QmdTestView）原本是两个并列的独立页面，
 *   导航上也分两项。用户反馈希望"相关测试都放在一个大页面里，分不同子页面"。
 *
 * 实现：
 *   - NTab 容器，两个 tab 分别懒加载 BenchmarkView / QmdTestView
 *   - 默认 tab 由 URL query 参数 ?tab=<benchmark|qmd-test> 决定（默认 benchmark）
 *   - 切换 tab 时同步更新 URL query（不触发页面刷新，用 router.replace）
 *   - 旧路由 /benchmark 和 /qmd-test 在 router.ts 中重定向到本页并带上对应 ?tab
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NTabs, NTabPane, NBreadcrumb, NBreadcrumbItem } from 'naive-ui';
import BenchmarkView from './BenchmarkView.vue';
import QmdTestView from './QmdTestView.vue';

type TestingTab = 'benchmark' | 'qmd-test';

const route = useRoute();
const router = useRouter();

// 当前激活 tab：从 URL query 读取，默认 benchmark
const activeTab = ref<TestingTab>('benchmark');

function readTabFromQuery(): TestingTab {
  const q = route.query.tab;
  return q === 'qmd-test' ? 'qmd-test' : 'benchmark';
}

onMounted(() => {
  activeTab.value = readTabFromQuery();
});

// 路由 query 变化（如浏览器前进/后退）时同步 tab
watch(
  () => route.query.tab,
  () => {
    const t = readTabFromQuery();
    if (t !== activeTab.value) activeTab.value = t;
  },
);

// 切换 tab 时同步 URL（replace 不入历史栈，避免污染浏览历史）
function onTabChange(name: string | number): void {
  const tab = String(name) as TestingTab;
  activeTab.value = tab;
  void router.replace({ path: '/testing', query: { tab } });
}

const tabLabel = computed(() =>
  activeTab.value === 'benchmark' ? 'CE 引擎压测' : 'QMD MCP 测试',
);
</script>

<template>
  <div class="testing-center">
    <div class="testing-center-header">
      <NBreadcrumb>
        <NBreadcrumbItem>测试中心</NBreadcrumbItem>
        <NBreadcrumbItem>{{ tabLabel }}</NBreadcrumbItem>
      </NBreadcrumb>
    </div>

    <NTabs
      :value="activeTab"
      type="line"
      animated
      size="medium"
      @update:value="onTabChange"
      style="margin-top: 4px"
    >
      <NTabPane name="benchmark" tab="CE 引擎压测">
        <!-- 直接嵌入子组件，复用原 BenchmarkView 全部能力（含实时日志） -->
        <BenchmarkView />
      </NTabPane>
      <NTabPane name="qmd-test" tab="QMD MCP 测试">
        <QmdTestView />
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
.testing-center {
  display: flex;
  flex-direction: column;
}
.testing-center-header {
  display: flex;
  align-items: baseline;
  margin-bottom: 4px;
}
</style>
