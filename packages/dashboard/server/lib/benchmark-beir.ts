/**
 * BEIR 标准测试集适配器（v2.3.0）。
 *
 * BEIR（Benchmarking IR）是业界公认的信息检索评估基准：
 * - 论文：Thakur et al., "BEIR: A Heterogeneous Benchmark for Zero-shot
 *   Evaluation of Information Retrieval Models", NeurIPS 2021
 * - 仓库：https://github.com/beir-cellar/beir
 * - 数据：https://huggingface.co/datasets?search=beir
 *
 * 本适配器支持两个子集：
 * - NFCorpus：医学领域，3.2K 查询，3633 文档（dietary supplements）
 * - SciFact：科学论文，1.4K 查询，5183 文档（scientific fact verification）
 *
 * 数据格式（BEIR 标准）：
 * - corpus.jsonl：每行 {"_id": "doc-1", "title": "...", "text": "..."}
 * - queries.jsonl：每行 {"_id": "query-1", "text": "..."}
 * - qrels/qrels.jsonl：每行 {"query-id": "query-1", "corpus-id": "doc-1", "score": 1}
 *
 * 工作流程：
 * 1. 首次使用：从 HuggingFace 下载 zip → 解压到 ~/.openclaw/.benchmark/beir/<name>/
 * 2. 后续使用：直接从缓存读取
 * 3. 提供精简子集（默认 200 条查询）避免压测时间过长
 *
 * 注意：BEIR 数据集是英文，与 QMD 索引的中文项目代码不匹配。
 * 召回率评估需要将 BEIR corpus 导入 QMD 索引（用户自行处理），
 * 或仅用 BEIR queries 做性能压测（不评估召回率，只测延迟/tokens）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { BenchmarkFixture } from './benchmark-fixtures.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** BEIR 缓存根目录：~/.openclaw/.benchmark/beir/ */
function getBeirCacheRoot(): string {
  const base = process.env.BENCHMARK_CACHE_DIR
    ?? resolve(homedir(), '.openclaw', '.benchmark');
  return resolve(base, 'beir');
}

/** BEIR 数据集元信息 */
interface BeirDatasetMeta {
  /** 数据集名称 */
  name: string;
  /** 下载 URL 列表（按优先级排序，依次尝试） */
  downloadUrls: string[];
  /** 默认精简子集大小（查询数） */
  defaultSubsetSize: number;
  /** 数据集描述 */
  description: string;
  /** 手工下载指引（所有自动下载均失败时展示给用户） */
  manualInstructions: string;
}

/**
 * 支持的 BEIR 数据集。
 *
 * 下载源说明（按优先级）：
 * 1. TU Darmstadt 官方源（原始 BEIR 服务器，偶尔不稳定）
 * 2. HuggingFace BeIR 组织镜像（更稳定，格式相同）
 * 3. 环境变量 BENCHMARK_BEIR_MIRROR 可覆盖（指向自建镜像/内网源）
 */
const BEIR_DATASETS: Record<string, BeirDatasetMeta> = {
  'nfcorpus': {
    name: 'nfcorpus',
    downloadUrls: [
      'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip',
      'https://huggingface.co/datasets/BeIR/nfcorpus/resolve/main/nfcorpus.zip',
    ],
    defaultSubsetSize: 200,
    description: 'NFCorpus — 医学领域 dietary supplements 检索，3.2K 查询 / 3633 文档',
    manualInstructions: [
      '方法 1（wget/curl）:',
      '  wget https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip',
      '  # 或从 HuggingFace 镜像下载:',
      '  # wget https://huggingface.co/datasets/BeIR/nfcorpus/resolve/main/nfcorpus.zip',
      '  unzip nfcorpus.zip -d nfcorpus_tmp',
      '  # BEIR zip 内有顶层目录 nfcorpus/，需将其内容放到缓存目录:',
      '  mkdir -p ~/.openclaw/.benchmark/beir/nfcorpus/qrels',
      '  cp nfcorpus_tmp/nfcorpus/corpus.jsonl ~/.openclaw/.benchmark/beir/nfcorpus/',
      '  cp nfcorpus_tmp/nfcorpus/queries.jsonl ~/.openclaw/.benchmark/beir/nfcorpus/',
      '  cp nfcorpus_tmp/nfcorpus/qrels/qrels.jsonl ~/.openclaw/.benchmark/beir/nfcorpus/qrels/',
      '  rm -rf nfcorpus_tmp nfcorpus.zip',
      '',
      '方法 2（Python beir 库）:',
      '  pip install beir',
      '  python -c "from beir.datasets import BEIR; BEIR(\'nfcorpus\', \'~/.openclaw/.benchmark/beir/\')"',
      '',
      '方法 3（环境变量覆盖下载源）:',
      '  export BENCHMARK_BEIR_MIRROR=https://your-mirror.example.com/beir/',
      '  # 下载时会拼接 ${BENCHMARK_BEIR_MIRROR}nfcorpus.zip',
      '',
      '方法 4（HuggingFace CLI，需登录时使用）:',
      '  # 若 HuggingFace 镜像返回 401/403，需先安装并登录：',
      '  pip install -U "huggingface_hub[cli]"',
      '  hf login   # 在 https://huggingface.co/settings/tokens 创建 Access Token',
      '  # 登录后即可用 wget/curl 下载，或设置环境变量免登录：',
      '  export HF_TOKEN=hf_xxxxxxxxxxxx',
      '  # 缓存目录同方法 1：~/.openclaw/.benchmark/beir/nfcorpus/',
      '',
      '缓存目录结构（部署后需包含以下文件）:',
      '  ~/.openclaw/.benchmark/beir/nfcorpus/',
      '    ├── corpus.jsonl      # 文档库（每行 {"_id":"doc-1","title":"...","text":"..."}）',
      '    ├── queries.jsonl     # 查询集（每行 {"_id":"query-1","text":"..."}）',
      '    └── qrels/',
      '        └── qrels.jsonl   # 黄金答案（每行 {"query-id":"query-1","corpus-id":"doc-1","score":1}）',
    ].join('\n'),
  },
  'scifact': {
    name: 'scifact',
    downloadUrls: [
      'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip',
      'https://huggingface.co/datasets/BeIR/scifact/resolve/main/scifact.zip',
    ],
    defaultSubsetSize: 200,
    description: 'SciFact — 科学论文事实核查，1.4K 查询 / 5183 文档',
    manualInstructions: [
      '方法 1（wget/curl）:',
      '  wget https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip',
      '  # 或从 HuggingFace 镜像下载:',
      '  # wget https://huggingface.co/datasets/BeIR/scifact/resolve/main/scifact.zip',
      '  unzip scifact.zip -d scifact_tmp',
      '  mkdir -p ~/.openclaw/.benchmark/beir/scifact/qrels',
      '  cp scifact_tmp/scifact/corpus.jsonl ~/.openclaw/.benchmark/beir/scifact/',
      '  cp scifact_tmp/scifact/queries.jsonl ~/.openclaw/.benchmark/beir/scifact/',
      '  cp scifact_tmp/scifact/qrels/qrels.jsonl ~/.openclaw/.benchmark/beir/scifact/qrels/',
      '  rm -rf scifact_tmp scifact.zip',
      '',
      '方法 2（环境变量覆盖下载源）:',
      '  export BENCHMARK_BEIR_MIRROR=https://your-mirror.example.com/beir/',
      '',
      '方法 3（HuggingFace CLI，需登录时使用）:',
      '  # 若 HuggingFace 镜像返回 401/403，需先安装并登录：',
      '  pip install -U "huggingface_hub[cli]"',
      '  hf login   # 在 https://huggingface.co/settings/tokens 创建 Access Token',
      '  # 或设置环境变量免登录：',
      '  export HF_TOKEN=hf_xxxxxxxxxxxx',
      '  # 缓存目录同方法 1：~/.openclaw/.benchmark/beir/scifact/',
      '',
      '缓存目录结构（部署后需包含以下文件）:',
      '  ~/.openclaw/.benchmark/beir/scifact/',
      '    ├── corpus.jsonl',
      '    ├── queries.jsonl',
      '    └── qrels/',
      '        └── qrels.jsonl',
    ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface BeirCorpusDoc {
  _id: string;
  title: string;
  text: string;
}

export interface BeirQuery {
  _id: string;
  text: string;
}

export interface BeirQrel {
  'query-id': string;
  'corpus-id': string;
  score: number;
}

export interface BeirDataset {
  name: string;
  corpus: BeirCorpusDoc[];
  queries: BeirQuery[];
  qrels: BeirQrel[];
  /** 已加载的 fixture 列表（精简子集） */
  fixtures: BenchmarkFixture[];
  /** 缓存路径 */
  cachePath: string;
  /** 是否从缓存加载（true）还是新下载（false） */
  fromCache: boolean;
}

// ---------------------------------------------------------------------------
// 缓存检查
// ---------------------------------------------------------------------------

/** 获取数据集缓存路径 */
export function getBeirCachePath(datasetName: string): string {
  return resolve(getBeirCacheRoot(), datasetName);
}

/** 检查 BEIR 数据集是否已缓存 */
export function isBeirCached(datasetName: string): boolean {
  const meta = BEIR_DATASETS[datasetName];
  if (!meta) return false;
  const cachePath = getBeirCachePath(datasetName);
  if (!existsSync(cachePath)) return false;
  // 必须包含三个核心文件
  const corpusPath = resolve(cachePath, 'corpus.jsonl');
  const queriesPath = resolve(cachePath, 'queries.jsonl');
  const qrelsPath = resolve(cachePath, 'qrels', 'qrels.jsonl');
  return existsSync(corpusPath) && existsSync(queriesPath) && existsSync(qrelsPath);
}

/** 获取缓存信息（大小、文件数等） */
export function getBeirCacheInfo(datasetName: string): { cached: boolean; path: string; sizeBytes: number; fileCount: number } | null {
  const meta = BEIR_DATASETS[datasetName];
  if (!meta) return null;
  const cachePath = getBeirCachePath(datasetName);
  if (!existsSync(cachePath)) {
    return { cached: false, path: cachePath, sizeBytes: 0, fileCount: 0 };
  }
  let totalSize = 0;
  let fileCount = 0;
  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        totalSize += stat.size;
        fileCount++;
      }
    }
  }
  try {
    walk(cachePath);
  } catch {
    // 忽略遍历错误
  }
  return {
    cached: isBeirCached(datasetName),
    path: cachePath,
    sizeBytes: totalSize,
    fileCount,
  };
}

// ---------------------------------------------------------------------------
// 文件解析
// ---------------------------------------------------------------------------

/** 解析 JSONL 文件（每行一个 JSON 对象） */
function parseJsonl<T>(filePath: string): T[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const result: T[] = [];
  for (const line of lines) {
    try {
      result.push(JSON.parse(line) as T);
    } catch {
      // 跳过解析失败的行
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 下载（从 HuggingFace 下载 zip 并解压）
// ---------------------------------------------------------------------------

/**
 * 下载并解压 BEIR 数据集。
 *
 * 实现说明：
 * - 依次尝试多个下载源（TU Darmstadt → HuggingFace → 环境变量镜像）
 * - 使用 fetch 下载 zip 二进制
 * - 使用 Node.js 内置 zlib + 手动解析 zip 格式（避免引入额外依赖如 unzipper/yauzl）
 * - 解压到 ~/.openclaw/.benchmark/beir/<name>/
 * - 所有源均失败时抛出包含手工下载指引的错误
 *
 * 注意：zip 解压只支持无密码、stored 或 deflate 压缩的标准 zip。
 */
export async function downloadBeirDataset(datasetName: string, onProgress?: (phase: string, progress?: number) => void): Promise<BeirDataset> {
  const meta = BEIR_DATASETS[datasetName];
  if (!meta) {
    throw new Error(`不支持的 BEIR 数据集: ${datasetName}（支持: ${Object.keys(BEIR_DATASETS).join(', ')}）`);
  }

  // 若已缓存，直接加载
  if (isBeirCached(datasetName)) {
    onProgress?.('loading-from-cache', 100);
    return loadBeirFromCache(datasetName);
  }

  const cachePath = getBeirCachePath(datasetName);
  mkdirSync(cachePath, { recursive: true });
  // 同时创建 qrels 子目录
  mkdirSync(resolve(cachePath, 'qrels'), { recursive: true });

  // 构建下载源列表：内置源 + 环境变量镜像
  const urls = [...meta.downloadUrls];
  const mirrorBase = process.env.BENCHMARK_BEIR_MIRROR;
  if (mirrorBase) {
    const mirrorUrl = `${mirrorBase.replace(/\/$/, '')}/${datasetName}.zip`;
    urls.unshift(mirrorUrl); // 环境变量镜像优先级最高
  }

  // 依次尝试下载源
  const errors: string[] = [];
  let zipBuffer: Buffer | null = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const sourceLabel = i === 0 && mirrorBase ? '镜像源（BENCHMARK_BEIR_MIRROR）'
      : url.includes('huggingface') ? 'HuggingFace 镜像'
      : 'TU Darmstadt 官方源';
    try {
      onProgress?.(`downloading(${sourceLabel})`, 0);
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(300_000), // 5 分钟超时
      });
      if (!resp.ok) {
        // HuggingFace 需要登录：401/403 时追加专用指引
        if (resp.status === 401 || resp.status === 403) {
          errors.push(
            `[${sourceLabel}] HTTP ${resp.status} ${resp.statusText} — 需要登录\n` +
            `    该源需要 HuggingFace 身份验证。请执行：\n` +
            `      pip install -U huggingface_hub\n` +
            `      hf login   # 在 https://huggingface.co/settings/tokens 创建 token\n` +
            `    或设置环境变量后重启 dashboard：\n` +
            `      export HF_TOKEN=hf_xxxxxxxxxxxx\n` +
            `    也可改用方法 1（wget 从 TU Darmstadt 官方源下载）或方法 3（BENCHMARK_BEIR_MIRROR 镜像）。\n` +
            `    URL: ${url}`,
          );
        } else {
          errors.push(`[${sourceLabel}] HTTP ${resp.status} ${resp.statusText} — ${url}`);
        }
        continue;
      }

      const totalBytes = Number(resp.headers.get('content-length') ?? 0);
      let downloadedBytes = 0;
      const reader = resp.body?.getReader();
      if (!reader) {
        errors.push(`[${sourceLabel}] 响应无 body reader — ${url}`);
        continue;
      }

      const chunks: Buffer[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(Buffer.from(value));
          downloadedBytes += value.length;
          if (totalBytes > 0) {
            onProgress?.(`downloading(${sourceLabel})`, Math.round((downloadedBytes / totalBytes) * 100));
          }
        }
      }
      zipBuffer = Buffer.concat(chunks);

      // 校验下载内容是有效 zip（至少包含 EOCD 签名）
      if (zipBuffer.length < 22 || zipBuffer.readUInt32LE(zipBuffer.length - 22) !== 0x06054b50) {
        // 可能 zip 末尾有注释，搜索 EOCD
        let foundEocd = false;
        for (let j = zipBuffer.length - 22; j >= Math.max(0, zipBuffer.length - 65557); j--) {
          if (zipBuffer.readUInt32LE(j) === 0x06054b50) {
            foundEocd = true;
            break;
          }
        }
        if (!foundEocd) {
          errors.push(`[${sourceLabel}] 下载内容非有效 ZIP 文件 — ${url}`);
          zipBuffer = null;
          continue;
        }
      }

      // 下载成功
      onProgress?.('extracting', 0);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[${sourceLabel}] ${msg} — ${url}`);
    }
  }

  if (!zipBuffer) {
    // 所有下载源失败，抛出包含手工下载指引的错误
    throw new Error(
      `BEIR ${datasetName} 所有下载源均失败:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
      `=== 手工下载指引 ===\n${meta.manualInstructions}`,
    );
  }

  // 解压 zip
  await extractZipTo(zipBuffer, cachePath, datasetName, onProgress);
  onProgress?.('extracting', 100);

  // 校验解压结果
  if (!isBeirCached(datasetName)) {
    throw new Error(
      `解压后数据集结构不完整，期望包含 corpus.jsonl / queries.jsonl / qrels/qrels.jsonl\n\n` +
      `=== 手工下载指引 ===\n${meta.manualInstructions}`,
    );
  }

  onProgress?.('loading', 100);
  return loadBeirFromCache(datasetName);
}

/** 获取数据集的手工下载指引（供路由层返回给前端展示） */
export function getBeirManualInstructions(datasetName: string): string | null {
  const meta = BEIR_DATASETS[datasetName];
  if (!meta) return null;
  return meta.manualInstructions;
}

// ---------------------------------------------------------------------------
// 简易 ZIP 解压（仅支持 deflate 压缩的标准 zip，不处理加密/zip64）
// ---------------------------------------------------------------------------

/**
 * 简易 ZIP 解压：解析 zip central directory，对每个 entry 用 zlib inflate 解压。
 *
 * 不使用第三方库以避免新增依赖。
 * 参考 PKZIP 规范：https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */
async function extractZipTo(zipBuffer: Buffer, destDir: string, datasetName: string, onProgress?: (phase: string, progress?: number) => void): Promise<void> {
  // 动态导入 zlib（避免顶层 import 影响启动）
  const zlib = await import('node:zlib');

  // 1. 定位 End of Central Directory Record (EOCD)
  // EOCD 签名: 0x06054b50，位于文件末尾，最小 22 字节
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  const minEocdSize = 22;
  const maxCommentLen = 65535;
  const searchStart = Math.max(0, zipBuffer.length - minEocdSize - maxCommentLen);
  for (let i = zipBuffer.length - minEocdSize; i >= searchStart; i--) {
    if (zipBuffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('ZIP 解压失败：未找到 EOCD（End of Central Directory Record）');
  }

  // 2. 解析 EOCD
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  // 3. 遍历 Central Directory
  const cdEnd = cdOffset + cdSize;
  let offset = cdOffset;
  const entries: Array<{ name: string; localHeaderOffset: number }> = [];

  while (offset < cdEnd) {
    if (zipBuffer.readUInt32LE(offset) !== 0x02014b50) break; // Central file header signature
    const compressMethod = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
    const nameLen = zipBuffer.readUInt16LE(offset + 28);
    const extraLen = zipBuffer.readUInt16LE(offset + 30);
    const commentLen = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
    const name = zipBuffer.slice(offset + 46, offset + 46 + nameLen).toString('utf-8');
    entries.push({ name, localHeaderOffset });
    void compressMethod;
    void compressedSize;
    void uncompressedSize;
    offset += 46 + nameLen + extraLen + commentLen;
  }

  if (entries.length === 0) {
    throw new Error('ZIP 解压失败：Central Directory 无 entry');
  }

  // 4. 解压每个 entry
  let processed = 0;
  for (const entry of entries) {
    // 跳过目录条目
    if (entry.name.endsWith('/')) {
      processed++;
      continue;
    }

    // 解析 local file header
    const lho = entry.localHeaderOffset;
    if (zipBuffer.readUInt32LE(lho) !== 0x04034b50) {
      throw new Error(`ZIP local header 签名错误: ${entry.name}`);
    }
    const lCompressMethod = zipBuffer.readUInt16LE(lho + 8);
    const lCompressedSize = zipBuffer.readUInt32LE(lho + 18);
    const lNameLen = zipBuffer.readUInt16LE(lho + 26);
    const lExtraLen = zipBuffer.readUInt16LE(lho + 28);
    const dataOffset = lho + 30 + lNameLen + lExtraLen;
    const compressedData = zipBuffer.slice(dataOffset, dataOffset + lCompressedSize);

    // 解压数据
    let fileContent: Buffer;
    if (lCompressMethod === 0) {
      // stored，无压缩
      fileContent = compressedData;
    } else if (lCompressMethod === 8) {
      // deflate
      fileContent = zlib.inflateSync(compressedData);
    } else {
      throw new Error(`不支持的 ZIP 压缩方法: ${lCompressMethod} (${entry.name})`);
    }

    // 规范化路径：BEIR zip 内顶层有目录（如 nfcorpus/），剥离后写入 destDir
    let relPath = entry.name;
    // 剥离顶层目录前缀
    const firstSlash = relPath.indexOf('/');
    if (firstSlash >= 0) {
      relPath = relPath.slice(firstSlash + 1);
    }
    if (!relPath) {
      processed++;
      continue;
    }

    const targetPath = resolve(destDir, relPath);
    // 确保父目录存在
    const targetDir = resolve(targetPath, '..');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetPath, fileContent);

    processed++;
    onProgress?.('extracting', Math.round((processed / entries.length) * 100));
  }
  void datasetName;
}

// ---------------------------------------------------------------------------
// 从缓存加载
// ---------------------------------------------------------------------------

/** 从缓存加载 BEIR 数据集（不下载） */
export function loadBeirFromCache(datasetName: string, subsetSize?: number): BeirDataset {
  const meta = BEIR_DATASETS[datasetName];
  if (!meta) {
    throw new Error(`不支持的 BEIR 数据集: ${datasetName}`);
  }
  if (!isBeirCached(datasetName)) {
    throw new Error(`BEIR 数据集 ${datasetName} 未缓存，请先下载`);
  }

  const cachePath = getBeirCachePath(datasetName);
  const corpus = parseJsonl<BeirCorpusDoc>(resolve(cachePath, 'corpus.jsonl'));
  const queries = parseJsonl<BeirQuery>(resolve(cachePath, 'queries.jsonl'));
  const qrels = parseJsonl<BeirQrel>(resolve(cachePath, 'qrels', 'qrels.jsonl'));

  // 构建 qrels 索引：query-id → Set<corpus-id>
  const qrelsByQuery = new Map<string, Set<string>>();
  for (const q of qrels) {
    if (!qrelsByQuery.has(q['query-id'])) {
      qrelsByQuery.set(q['query-id'], new Set());
    }
    qrelsByQuery.get(q['query-id'])!.add(q['corpus-id']);
  }

  // 构建精简子集 fixtures
  const limit = subsetSize ?? meta.defaultSubsetSize;
  const selectedQueries = queries.slice(0, Math.min(limit, queries.length));
  const fixtures: BenchmarkFixture[] = selectedQueries.map((q) => {
    const expectedDocIds = Array.from(qrelsByQuery.get(q._id) ?? []);
    return {
      id: `beir-${datasetName}-${q._id}`,
      query: q.text,
      category: 'knowledge', // BEIR 默认归为 knowledge
      expectedDocIds,
      description: `BEIR ${datasetName} query ${q._id}（${expectedDocIds.length} 个期望文档）`,
    };
  });

  return {
    name: datasetName,
    corpus,
    queries,
    qrels,
    fixtures,
    cachePath,
    fromCache: true,
  };
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/** 列出所有支持的 BEIR 数据集 */
export function listBeirDatasets(): Array<{ name: string; description: string; defaultSubsetSize: number; cached: boolean; cacheInfo: ReturnType<typeof getBeirCacheInfo> }> {
  return Object.entries(BEIR_DATASETS).map(([name, meta]) => ({
    name,
    description: meta.description,
    defaultSubsetSize: meta.defaultSubsetSize,
    cached: isBeirCached(name),
    cacheInfo: getBeirCacheInfo(name),
  }));
}

/** 获取 BEIR fixtures（若未缓存则自动下载） */
export async function getBeirFixtures(datasetName: string, subsetSize?: number, onProgress?: (phase: string, progress?: number) => void): Promise<BenchmarkFixture[]> {
  const dataset = await downloadBeirDataset(datasetName, onProgress);
  if (subsetSize && subsetSize !== BEIR_DATASETS[datasetName]?.defaultSubsetSize) {
    // 重新加载指定子集大小
    const reloaded = loadBeirFromCache(datasetName, subsetSize);
    return reloaded.fixtures;
  }
  return dataset.fixtures;
}

/** 计算字符串 SHA256（用于校验下载文件完整性） */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
