<script setup lang="ts">
/**
 * 维护操作页（模块 4）。
 *
 * 布局（设计文档 4.4 节）：
 *   9 张操作卡片网格（NGrid cols=2 响应式） + 底部固定操作日志区
 *
 * 写路径：所有操作通过 POST /api/mcp/invoke 走 MCP（P3 已实现）。
 * 本模块复用 src/api/maintain.ts 中的语义化封装函数。
 *
 * 状态管理：
 *   - logs: reactive 数组，新操作 unshift 到顶部，裁剪到 20 条
 *   - loadingMap: reactive<Record<cardKey, boolean>>，每张卡片独立 loading
 *   - useMutation 包装 invoke 调用，onMutate/onSuccess/onError 维护日志
 *
 * 安全约束（设计文档 6.3 节）：
 *   - restore 强制 dryRun 默认 true（前端表单默认勾选）
 *   - restore 三次确认（confirmLevel=2）
 *   - reset_breaker / sync repair / compact / maintain / ttl_cleanup / import 二次确认
 *   - 危险操作（restore / reset_breaker / sync repair）按钮 type=error
 */
import { computed, reactive, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { NGrid, NGi, NSpace, NInput, NInputNumber, NSelect, NSwitch, NFormItem, NAlert } from 'naive-ui';
import OperationCard from '../components/OperationCard.vue';
import OperationLog, { type OperationLogEntry } from '../components/OperationLog.vue';
import CapabilityProfileSwitch from '../components/CapabilityProfileSwitch.vue';
import {
  invokeMaintain,
  invokeDiagnose,
  invokeDistill,
  invokeCompact,
  invokeResetBreaker,
  invokeBackup,
  invokeRestore,
  invokeSync,
  invokeImport,
} from '../api/maintain';
import type { McpInvokeResponse } from '../api/experience';

// ===== 各卡片表单状态 =====

// 卡片 2：蒸馏
const distillLimit = ref<number>(50);

// 卡片 3：compact
const compactConversationId = ref<number | null>(null);

// 卡片 4：重置熔断器
const breakerName = ref<string>('lcm');
const breakerOptions = [
  { label: 'LCM (lossless-claw)', value: 'lcm' },
  { label: 'QMD (memory file engine)', value: 'qmd' },
  { label: 'Neo4j (graph-memory-pro)', value: 'neo4j' },
];

// 卡片 6：备份
const todayStamp = (() => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
})();
const backupOutputPath = ref<string>(`~/.openclaw/backup-${todayStamp}.json`);

// 卡片 7：恢复（强制 dryRun 默认 true）
const restoreBackupPath = ref<string>('');
const restoreTargets = ref<string>('all');
const restoreDryRun = ref<boolean>(true);
const restoreTargetsOptions = [
  { label: '全部 (all)', value: 'all' },
  { label: '仅 Neo4j (neo4j_only)', value: 'neo4j_only' },
  { label: '仅 LCM (lcm_only)', value: 'lcm_only' },
  { label: '仅文件 (files_only)', value: 'files_only' },
];

// 卡片 8：同步修复
const syncMode = ref<'check' | 'repair'>('check');
const syncDryRun = ref<boolean>(true);
const syncModeOptions = [
  { label: '检查 (check, 只读审计)', value: 'check' },
  { label: '修复 (repair, 实际执行)', value: 'repair' },
];
// repair 模式才视为危险操作 + 二次确认
const syncDanger = computed(() => syncMode.value === 'repair');
const syncConfirmLevel = computed<0 | 1>(() => (syncMode.value === 'repair' ? 1 : 0));

// 卡片 9：历史导入
const importSource = ref<string>('all');
const importLimit = ref<number>(100);
const importSourceOptions = [
  { label: '全部 (all)', value: 'all' },
  { label: 'LCM 消息 (lcm_messages)', value: 'lcm_messages' },
  { label: '记忆文件 (memory_files)', value: 'memory_files' },
];

// ===== 日志 + loading 状态 =====

const logs = ref<OperationLogEntry[]>([]);
const loadingMap = reactive<Record<string, boolean>>({});
let nextLogId = 1;
// cardKey → 当前 running 日志 ID（用于 onSuccess/onError 回填）
const pendingLogIds = new Map<string, number>();
const MAX_LOGS = 20;

interface MutationVars {
  cardKey: string;
  tool: string;
  params: Record<string, unknown>;
  invokeFn: () => Promise<McpInvokeResponse>;
}

/** 推入一条 running 日志并返回其 ID（同时裁剪到最近 MAX_LOGS 条） */
function pushRunningLog(cardKey: string, tool: string, params: Record<string, unknown>): number {
  const id = nextLogId++;
  const entry: OperationLogEntry = {
    id,
    tool,
    params,
    status: 'running',
    ts: Date.now(),
  };
  logs.value.unshift(entry);
  if (logs.value.length > MAX_LOGS) {
    logs.value.length = MAX_LOGS;
  }
  return id;
}

/** 据 ID 回填日志结果 */
function patchLog(id: number, patch: Partial<OperationLogEntry>): void {
  const idx = logs.value.findIndex((l) => l.id === id);
  if (idx === -1) return;
  logs.value[idx] = { ...logs.value[idx], ...patch };
}

const mutation = useMutation<McpInvokeResponse, Error, MutationVars>({
  mutationFn: (vars) => vars.invokeFn(),
  onMutate: (vars) => {
    const logId = pushRunningLog(vars.cardKey, vars.tool, vars.params);
    pendingLogIds.set(vars.cardKey, logId);
    loadingMap[vars.cardKey] = true;
  },
  onSuccess: (data, vars) => {
    const logId = pendingLogIds.get(vars.cardKey);
    if (logId !== undefined) {
      const log = logs.value.find((l) => l.id === logId);
      patchLog(logId, {
        status: data.ok ? 'success' : 'error',
        result: data.result,
        error: data.error,
        durationMs: log ? Date.now() - log.ts : 0,
      });
      pendingLogIds.delete(vars.cardKey);
    }
    loadingMap[vars.cardKey] = false;
  },
  onError: (err, vars) => {
    const logId = pendingLogIds.get(vars.cardKey);
    if (logId !== undefined) {
      const log = logs.value.find((l) => l.id === logId);
      patchLog(logId, {
        status: 'error',
        error: err.message,
        durationMs: log ? Date.now() - log.ts : 0,
      });
      pendingLogIds.delete(vars.cardKey);
    }
    loadingMap[vars.cardKey] = false;
  },
});

// ===== 各卡片执行入口（封装 mutation.mutate） =====

function executeMaintain(): void {
  mutation.mutate({
    cardKey: 'maintain',
    tool: 'lcmg_maintain',
    params: {},
    invokeFn: () => invokeMaintain(),
  });
}

function executeDiagnose(): void {
  mutation.mutate({
    cardKey: 'diagnose',
    tool: 'lcmg_diagnose',
    params: {},
    invokeFn: () => invokeDiagnose(),
  });
}

function executeDistill(): void {
  mutation.mutate({
    cardKey: 'distill',
    tool: 'lcmg_distill',
    params: { limit: distillLimit.value },
    invokeFn: () => invokeDistill(distillLimit.value),
  });
}

function executeCompact(): void {
  const params: Record<string, unknown> = {};
  if (compactConversationId.value !== null && compactConversationId.value !== undefined) {
    params.conversationId = compactConversationId.value;
  }
  mutation.mutate({
    cardKey: 'compact',
    tool: 'lcmg_compact',
    params,
    invokeFn: () => invokeCompact(compactConversationId.value ?? undefined),
  });
}

function executeResetBreaker(): void {
  mutation.mutate({
    cardKey: 'reset_breaker',
    tool: 'lcmg_reset_breaker',
    params: { name: breakerName.value },
    invokeFn: () => invokeResetBreaker(breakerName.value),
  });
}

function executeTtlCleanup(): void {
  // TTL 清理复用 lcmg_maintain（已内置债务表对账 + 孤儿清理）
  mutation.mutate({
    cardKey: 'ttl_cleanup',
    tool: 'lcmg_maintain',
    params: {},
    invokeFn: () => invokeMaintain(),
  });
}

function executeBackup(): void {
  mutation.mutate({
    cardKey: 'backup',
    tool: 'lcmg_backup',
    params: { outputPath: backupOutputPath.value },
    invokeFn: () => invokeBackup(backupOutputPath.value),
  });
}

function executeRestore(): void {
  mutation.mutate({
    cardKey: 'restore',
    tool: 'lcmg_restore',
    params: {
      backupPath: restoreBackupPath.value,
      targets: restoreTargets.value,
      dryRun: restoreDryRun.value,
    },
    invokeFn: () =>
      invokeRestore(restoreBackupPath.value, restoreTargets.value, restoreDryRun.value),
  });
}

function executeSync(): void {
  mutation.mutate({
    cardKey: 'sync',
    tool: 'lcmg_sync',
    params: { mode: syncMode.value, dryRun: syncDryRun.value },
    invokeFn: () => invokeSync(syncMode.value, syncDryRun.value),
  });
}

function executeImport(): void {
  mutation.mutate({
    cardKey: 'import',
    tool: 'lcmg_import',
    params: { source: importSource.value, limit: importLimit.value },
    invokeFn: () => invokeImport(importSource.value, importLimit.value),
  });
}
</script>

<template>
  <div class="maintain-view">
    <div class="maintain-header">
      <h2 style="margin: 0">维护操作</h2>
      <span class="muted">10 项手动维护入口 · 危险操作需多次确认</span>
    </div>

    <NSpace vertical :size="12" style="margin-top: 12px">
      <!-- 9 张操作卡片网格（2 列响应式） -->
      <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen">
        <!-- 卡片 1: 图谱维护 -->
        <NGi>
          <OperationCard
            title="图谱维护"
            description="触发 dedup / PageRank / community detection + 债务表对账。建议低峰期执行。"
            icon="database"
            :confirm-level="1"
            :loading="!!loadingMap.maintain"
            @execute="executeMaintain"
          />
        </NGi>

        <!-- 卡片 1.5: 系统诊断 -->
        <NGi>
          <OperationCard
            title="系统诊断"
            description="全栈自检：lcm.db / qmd MCP / Neo4j / 熔断器 / health metrics，输出多段 markdown 报告。"
            icon="activity"
            :confirm-level="0"
            :loading="!!loadingMap.diagnose"
            @execute="executeDiagnose"
          />
        </NGi>

        <!-- 卡片 2: 触发蒸馏 -->
        <NGi>
          <OperationCard
            title="触发蒸馏"
            description="从 PENDING 经验批量蒸馏为 DISTILLED（调用 LLM 提取结构化经验）。"
            icon="flask"
            :confirm-level="0"
            :loading="!!loadingMap.distill"
            @execute="executeDistill"
          >
            <template #form>
              <NFormItem label="单次上限" size="small" :show-feedback="false">
                <NInputNumber
                  v-model:value="distillLimit"
                  :min="1"
                  :max="200"
                  size="small"
                  style="width: 100%"
                />
              </NFormItem>
            </template>
          </OperationCard>
        </NGi>

        <!-- 卡片 3: 触发 compact -->
        <NGi>
          <OperationCard
            title="触发 compact"
            description="手动触发指定会话的上下文压缩；省略 conversationId 则处理最紧急债务。"
            icon="compress"
            :confirm-level="1"
            :loading="!!loadingMap.compact"
            @execute="executeCompact"
          >
            <template #form>
              <NFormItem label="conversationId（可选）" size="small" :show-feedback="false">
                <NInputNumber
                  v-model:value="compactConversationId"
                  :min="1"
                  size="small"
                  style="width: 100%"
                  placeholder="留空处理最紧急债务"
                />
              </NFormItem>
            </template>
          </OperationCard>
        </NGi>

        <!-- 卡片 4: 重置熔断器（危险） -->
        <NGi>
          <OperationCard
            title="重置熔断器"
            description="重置指定子系统熔断器状态。Neo4j 还会重置 GraphAdapter 连接失败标志。"
            icon="power"
            danger
            :confirm-level="1"
            :loading="!!loadingMap.reset_breaker"
            @execute="executeResetBreaker"
          >
            <template #form>
              <NFormItem label="子系统" size="small" :show-feedback="false">
                <NSelect
                  v-model:value="breakerName"
                  :options="breakerOptions"
                  size="small"
                />
              </NFormItem>
            </template>
          </OperationCard>
        </NGi>

        <!-- 卡片 5: TTL 清理 -->
        <NGi>
          <OperationCard
            title="TTL 清理"
            description="触发债务表对账：删除孤儿债务 + 清理 7 天前墓碑。复用 lcmg_maintain。"
            icon="trash"
            :confirm-level="1"
            :loading="!!loadingMap.ttl_cleanup"
            @execute="executeTtlCleanup"
          />
        </NGi>

        <!-- 卡片 6: 备份 -->
        <NGi>
          <OperationCard
            title="备份"
            description="导出 Neo4j + LCM 对话 + memory/*.md 为单 JSON 文件。路径必须在 ~/.openclaw 之下。"
            icon="save"
            :confirm-level="0"
            :loading="!!loadingMap.backup"
            @execute="executeBackup"
          >
            <template #form>
              <NFormItem label="输出路径（目录）" size="small" :show-feedback="false">
                <NInput
                  v-model:value="backupOutputPath"
                  size="small"
                  placeholder="~/.openclaw/backup-YYYYMMDD"
                />
              </NFormItem>
            </template>
          </OperationCard>
        </NGi>

        <!-- 卡片 7: 恢复（危险 + 三次确认 + dryRun 默认 true） -->
        <NGi>
          <OperationCard
            title="恢复"
            description="从备份 JSON 恢复到 Neo4j / LCM / 文件。Neo4j 用 MERGE 不删现有节点。强制 dryRun 默认 true。"
            icon="upload"
            danger
            :confirm-level="2"
            :loading="!!loadingMap.restore"
            @execute="executeRestore"
          >
            <template #form>
              <NFormItem label="备份文件路径" size="small" :show-feedback="false">
                <NInput
                  v-model:value="restoreBackupPath"
                  size="small"
                  placeholder="~/.openclaw/.../memory-full-backup-*.json"
                />
              </NFormItem>
              <NFormItem label="目标" size="small" :show-feedback="false">
                <NSelect
                  v-model:value="restoreTargets"
                  :options="restoreTargetsOptions"
                  size="small"
                />
              </NFormItem>
              <NFormItem label="dryRun（预览不写入）" size="small" :show-feedback="false">
                <NSwitch v-model:value="restoreDryRun" size="small" />
                <span class="muted" style="margin-left: 8px">
                  默认开启，关闭后将实际写入数据
                </span>
              </NFormItem>
            </template>
          </OperationCard>
        </NGi>

        <!-- 卡片 8: 同步修复（mode=repair 时升级为危险 + 二次确认） -->
        <NGi>
          <OperationCard
            title="同步修复"
            description="跨存储一致性检查/修复：检测孤儿 Neo4j 节点 + TTL/pin 状态。repair 模式实际删除孤儿。"
            icon="refresh"
            :danger="syncDanger"
            :confirm-level="syncConfirmLevel"
            :loading="!!loadingMap.sync"
            @execute="executeSync"
          >
            <template #form>
              <NFormItem label="模式" size="small" :show-feedback="false">
                <NSelect
                  v-model:value="syncMode"
                  :options="syncModeOptions"
                  size="small"
                />
              </NFormItem>
              <NFormItem label="dryRun（预览不写入）" size="small" :show-feedback="false">
                <NSwitch v-model:value="syncDryRun" size="small" />
                <span class="muted" style="margin-left: 8px">
                  默认开启，repair 模式下关闭才会实际删除
                </span>
              </NFormItem>
            </template>
          </OperationCard>
        </NGi>

        <!-- 卡片 9: 历史导入 -->
        <NGi>
          <OperationCard
            title="历史导入"
            description="把 LCM 消息 / 记忆文件 / 全部一次性导入 Neo4j（LLM 实体抽取，未配置时降级直存）。"
            icon="download"
            :confirm-level="1"
            :loading="!!loadingMap.import"
            @execute="executeImport"
          >
            <template #form>
              <NFormItem label="来源" size="small" :show-feedback="false">
                <NSelect
                  v-model:value="importSource"
                  :options="importSourceOptions"
                  size="small"
                />
              </NFormItem>
              <NFormItem label="单次上限" size="small" :show-feedback="false">
                <NInputNumber
                  v-model:value="importLimit"
                  :min="1"
                  :max="500"
                  size="small"
                  style="width: 100%"
                />
              </NFormItem>
            </template>
          </OperationCard>
        </NGi>
      </NGrid>

      <!-- v1.1.0-5: 能力档次切换 -->
      <CapabilityProfileSwitch />

      <!-- 错误兜底提示（mutation 抛错时由日志区展示，此处保留全页提示） -->
      <NAlert
        v-if="mutation.isError.value"
        type="error"
        :show-icon="true"
        title="最近一次操作异常"
      >
        {{ mutation.error.value?.message ?? '未知错误' }}
      </NAlert>

      <!-- 操作日志区（底部固定） -->
      <OperationLog :logs="logs" />
    </NSpace>
  </div>
</template>

<style scoped>
.maintain-view {
  width: 100%;
}
.maintain-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.muted {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
</style>
