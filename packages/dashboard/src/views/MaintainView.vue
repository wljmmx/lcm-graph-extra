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
import { computed, reactive, ref, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { NGrid, NGi, NSpace, NInput, NInputNumber, NSelect, NSwitch, NFormItem, NAlert, useMessage } from 'naive-ui';
import OperationCard from '../components/OperationCard.vue';
import OperationLog, { type OperationLogEntry } from '../components/OperationLog.vue';
import {
  invokeMaintain,
  invokeDiagnose,
  invokeDistill,
  invokeDistillRetry,
  invokeBackfill,
  invokeCompact,
  invokeResetBreaker,
  invokeBackup,
  invokeRestore,
  invokeSync,
  invokeImport,
} from '../api/maintain';
import type { McpInvokeResponse } from '../api/experience';
import { extractDetails, extractText } from '../api/experience';

const message = useMessage();

// ===== 各卡片表单状态 =====

// 卡片 2：蒸馏
const distillLimit = ref<number>(50);

// 卡片 2.1：重试失败经验
const retryMode = ref<'exhausted' | 'all'>('exhausted');
const retryModeOptions = [
  { label: '仅重试已耗尽 (exhausted)', value: 'exhausted' },
  { label: '重试全部失败 (all)', value: 'all' },
];

// 卡片 2.5：经验回溯
const backfillLimit = ref<number>(20);
const backfillForce = ref<boolean>(false);

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

// H6 修复：路径常驻校验状态（替代一闪而过的 toast）
const backupPathError = computed(() => validateOpenclawPath(backupOutputPath.value));
const restorePathError = computed(() => validateOpenclawPath(restoreBackupPath.value));

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

// ===== 路径安全校验（前端轻量校验，后端 POST /api/mcp/invoke 有硬墙兜底） =====

/**
 * 校验路径必须位于 ~/.openclaw 之下。
 * 浏览器无法获知真实 home 目录，仅做前缀 + 遍历检查；
 * 后端用 path.resolve(os.homedir(), ...) 做权威校验。
 *
 * @returns null 表示通过，否则为错误文案
 */
function validateOpenclawPath(p: string): string | null {
  const trimmed = p.trim();
  if (!trimmed) return '路径不能为空';
  // 统一为正斜杠便于匹配
  const normalized = trimmed.replace(/\\/g, '/');
  const prefix = '~/.openclaw';
  const ok = normalized === prefix || normalized.startsWith(prefix + '/');
  if (!ok) return `路径必须位于 ${prefix} 之下`;
  // 拒绝路径遍历段
  if (/(^|\/)\.\.(\/|$)/.test(normalized)) return '路径不能包含 .. 段';
  return null;
}

// ===== 日志 + loading 状态 =====

const logs = ref<OperationLogEntry[]>([]);
const loadingMap = reactive<Record<string, boolean>>({});
/** 每张卡片最近一次完成的执行结果（用于卡片内摘要展示） */
const lastResultMap = reactive<Record<string, {
  status: 'success' | 'error';
  details: OperationLogEntry['details'];
  text: OperationLogEntry['text'];
}>>({});
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
      const details = extractDetails(data.result);
      const text = extractText(data.result);
      const status = data.ok ? 'success' as const : 'error' as const;
      patchLog(logId, {
        status,
        result: data.result,
        error: data.error,
        details,
        text,
        durationMs: log ? Date.now() - log.ts : 0,
      });
      pendingLogIds.delete(vars.cardKey);
      // 记录卡片级摘要
      lastResultMap[vars.cardKey] = { status, details, text };
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
      lastResultMap[vars.cardKey] = { status: 'error', details: null, text: null };
    }
    loadingMap[vars.cardKey] = false;
  },
});

// M14 修复：顶部错误条可关闭，且新错误出现时自动恢复显示
const topErrorDismissed = ref(false);
watch(
  () => mutation.error.value,
  () => { topErrorDismissed.value = false; },
);

/**
 * 统一执行入口（P1 竞态修复）。
 *
 * onMutate 由 TanStack Query 异步调度，若用户在首次调用的 onMutate
 * 真正执行前再次触发同一卡片，pendingLogIds.set 会覆盖首条 logId，
 * 导致首条 running 日志永不被回填。此处同步置位 loadingMap 作为硬守卫，
 * 在 mutate 调用前就拒绝重入。
 */
function runMutation(vars: MutationVars): void {
  if (loadingMap[vars.cardKey]) return;
  loadingMap[vars.cardKey] = true;
  mutation.mutate(vars);
}

// ===== 各卡片执行入口（封装 runMutation） =====

function executeMaintain(): void {
  runMutation({
    cardKey: 'maintain',
    tool: 'lcmg_maintain',
    params: {},
    invokeFn: () => invokeMaintain(),
  });
}

function executeDiagnose(): void {
  runMutation({
    cardKey: 'diagnose',
    tool: 'lcmg_diagnose',
    params: {},
    invokeFn: () => invokeDiagnose(),
  });
}

function executeDistill(): void {
  runMutation({
    cardKey: 'distill',
    tool: 'lcmg_distill',
    params: { limit: distillLimit.value },
    invokeFn: () => invokeDistill(distillLimit.value),
  });
}

function executeDistillRetry(): void {
  runMutation({
    cardKey: 'distill_retry',
    tool: 'lcmg_distill_retry',
    params: { mode: retryMode.value },
    invokeFn: () => invokeDistillRetry(retryMode.value),
  });
}

function executeBackfill(): void {
  runMutation({
    cardKey: 'backfill',
    tool: 'lcmg_backfill',
    params: { limit: backfillLimit.value, force: backfillForce.value },
    invokeFn: () => invokeBackfill(backfillLimit.value, backfillForce.value),
  });
}

function executeCompact(): void {
  const params: Record<string, unknown> = {};
  if (compactConversationId.value !== null && compactConversationId.value !== undefined) {
    params.conversationId = compactConversationId.value;
  }
  runMutation({
    cardKey: 'compact',
    tool: 'lcmg_compact',
    params,
    invokeFn: () => invokeCompact(compactConversationId.value ?? undefined),
  });
}

function executeResetBreaker(): void {
  runMutation({
    cardKey: 'reset_breaker',
    tool: 'lcmg_reset_breaker',
    params: { name: breakerName.value },
    invokeFn: () => invokeResetBreaker(breakerName.value),
  });
}

function executeTtlCleanup(): void {
  // TTL 清理复用 lcmg_maintain（已内置债务表对账 + 孤儿清理）
  runMutation({
    cardKey: 'ttl_cleanup',
    tool: 'lcmg_maintain',
    params: {},
    invokeFn: () => invokeMaintain(),
  });
}

function executeBackup(): void {
  const err = validateOpenclawPath(backupOutputPath.value);
  if (err) {
    message.error(err);
    return;
  }
  runMutation({
    cardKey: 'backup',
    tool: 'lcmg_backup',
    params: { outputPath: backupOutputPath.value },
    invokeFn: () => invokeBackup(backupOutputPath.value),
  });
}

function executeRestore(): void {
  const err = validateOpenclawPath(restoreBackupPath.value);
  if (err) {
    message.error(err);
    return;
  }
  runMutation({
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
  runMutation({
    cardKey: 'sync',
    tool: 'lcmg_sync',
    params: { mode: syncMode.value, dryRun: syncDryRun.value },
    invokeFn: () => invokeSync(syncMode.value, syncDryRun.value),
  });
}

function executeImport(): void {
  runMutation({
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
      <span class="muted">9 项手动维护入口 · 危险操作需多次确认</span>
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
            tool-name="lcmg_maintain"
            :last-status="lastResultMap.maintain?.status ?? null"
            :last-details="lastResultMap.maintain?.details ?? null"
            :last-text="lastResultMap.maintain?.text ?? null"
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
            tool-name="lcmg_diagnose"
            :last-status="lastResultMap.diagnose?.status ?? null"
            :last-details="lastResultMap.diagnose?.details ?? null"
            :last-text="lastResultMap.diagnose?.text ?? null"
            @execute="executeDiagnose"
          />
        </NGi>

        <!-- 卡片 2: 触发蒸馏 -->
        <NGi>
          <OperationCard
            title="触发蒸馏"
            description="从 PENDING 经验批量蒸馏为 DISTILLED（调用 LLM 提取结构化经验）。失败的经验自动重试（最多 3 次）。"
            icon="flask"
            :confirm-level="0"
            :loading="!!loadingMap.distill"
            tool-name="lcmg_distill"
            :last-status="lastResultMap.distill?.status ?? null"
            :last-details="lastResultMap.distill?.details ?? null"
            :last-text="lastResultMap.distill?.text ?? null"
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

        <!-- 卡片 2.1: 重试失败经验 -->
        <NGi>
          <OperationCard
            title="重试失败经验"
            description="重置蒸馏失败的 FAILED 经验回 PENDING 状态，清零重试次数，使其可被重新蒸馏。已耗尽自动重试次数的经验需在此重置后才会重新进入队列。"
            icon="refresh"
            :confirm-level="0"
            :loading="!!loadingMap.distill_retry"
            tool-name="lcmg_distill_retry"
            :last-status="lastResultMap.distill_retry?.status ?? null"
            :last-details="lastResultMap.distill_retry?.details ?? null"
            :last-text="lastResultMap.distill_retry?.text ?? null"
            @execute="executeDistillRetry"
          >
            <template #form>
              <NFormItem label="重置范围" size="small" :show-feedback="false">
                <NSelect
                  v-model:value="retryMode"
                  :options="retryModeOptions"
                  size="small"
                  style="width: 100%"
                />
              </NFormItem>
            </template>
          </OperationCard>
        </NGi>

        <!-- 卡片 2.5: 经验回溯 -->
        <NGi>
          <OperationCard
            title="经验回溯"
            description="从历史对话记录中重新提取经验写入 PENDING 队列。修复连接问题后使用。默认跳过已处理过的会话。"
            icon="history"
            :confirm-level="0"
            :loading="!!loadingMap.backfill"
            tool-name="lcmg_backfill"
            :last-status="lastResultMap.backfill?.status ?? null"
            :last-details="lastResultMap.backfill?.details ?? null"
            :last-text="lastResultMap.backfill?.text ?? null"
            @execute="executeBackfill"
          >
            <template #form>
              <NFormItem label="处理会话数" size="small" :show-feedback="false">
                <NInputNumber
                  v-model:value="backfillLimit"
                  :min="1"
                  :max="500"
                  size="small"
                  style="width: 100%"
                />
              </NFormItem>
              <NFormItem label="强制重处理" size="small" :show-feedback="false">
                <NSwitch v-model:value="backfillForce" size="small" />
                <span style="margin-left: 8px; font-size: 12px; color: #999">
                  {{ backfillForce ? '重新处理所有会话' : '跳过已处理会话' }}
                </span>
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
            tool-name="lcmg_compact"
            :last-status="lastResultMap.compact?.status ?? null"
            :last-details="lastResultMap.compact?.details ?? null"
            :last-text="lastResultMap.compact?.text ?? null"
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
            tool-name="lcmg_reset_breaker"
            :last-status="lastResultMap.reset_breaker?.status ?? null"
            :last-details="lastResultMap.reset_breaker?.details ?? null"
            :last-text="lastResultMap.reset_breaker?.text ?? null"
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
            tool-name="lcmg_maintain"
            :last-status="lastResultMap.ttl_cleanup?.status ?? null"
            :last-details="lastResultMap.ttl_cleanup?.details ?? null"
            :last-text="lastResultMap.ttl_cleanup?.text ?? null"
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
            tool-name="lcmg_backup"
            :last-status="lastResultMap.backup?.status ?? null"
            :last-details="lastResultMap.backup?.details ?? null"
            :last-text="lastResultMap.backup?.text ?? null"
            @execute="executeBackup"
          >
            <template #form>
              <NFormItem
                label="输出路径（目录）"
                size="small"
                :validation-status="backupPathError ? 'error' : undefined"
                :feedback="backupPathError ?? undefined"
              >
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
            tool-name="lcmg_restore"
            :last-status="lastResultMap.restore?.status ?? null"
            :last-details="lastResultMap.restore?.details ?? null"
            :last-text="lastResultMap.restore?.text ?? null"
            @execute="executeRestore"
          >
            <template #form>
              <NFormItem
                label="备份文件路径"
                size="small"
                :validation-status="restorePathError ? 'error' : undefined"
                :feedback="restorePathError ?? undefined"
              >
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
              <NAlert
                v-if="!restoreDryRun"
                type="warning"
                :show-icon="true"
                style="margin-top: 8px"
              >
                dryRun 已关闭：执行后将实际向 Neo4j / LCM 写入数据，请再次确认备份文件路径正确。
              </NAlert>
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
            tool-name="lcmg_sync"
            :last-status="lastResultMap.sync?.status ?? null"
            :last-details="lastResultMap.sync?.details ?? null"
            :last-text="lastResultMap.sync?.text ?? null"
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
              <NAlert
                v-if="syncMode === 'repair' && !syncDryRun"
                type="warning"
                :show-icon="true"
                style="margin-top: 8px"
              >
                repair 模式且 dryRun 已关闭：执行后将实际删除孤儿节点，操作不可逆。
              </NAlert>
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
            tool-name="lcmg_import"
            :last-status="lastResultMap.import?.status ?? null"
            :last-details="lastResultMap.import?.details ?? null"
            :last-text="lastResultMap.import?.text ?? null"
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

      <!-- M14 修复：顶部错误兜底提示（友好文案 + 可关闭） -->
      <NAlert
        v-if="mutation.isError.value && !topErrorDismissed"
        type="error"
        :show-icon="true"
        title="操作执行失败"
        closable
        @close="topErrorDismissed = true"
      >
        <NSpace vertical :size="4">
          <span>{{ mutation.error.value?.message ?? '未知错误' }}</span>
          <span class="muted">请检查后端 MCP 服务是否正常，或查看下方操作日志了解详情。可稍后重试该操作。</span>
        </NSpace>
      </NAlert>

      <!-- 操作日志区（底部固定） -->
      <OperationLog :logs="logs" @clear="logs = []" />
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
  /* color 由 tokens.css 全局 .muted 提供，此处仅追加 caption 字号 */
  font-size: var(--fs-caption);
}
</style>
