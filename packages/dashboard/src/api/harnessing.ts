/**
 * Harnessing API（Harness² 吸收：演进历史视图数据源）。
 * 数据契约：GET /api/harnessing/summary → HarnessingSummaryResponse
 */

import { apiGet } from './client';

export interface HarnessingSignalPool {
  count: number;
  totalOccurrences: number;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
}

export interface HarnessingLastAutoStep {
  ts: number;
  ran: boolean;
  skipped?: string;
  signalCount: number;
  stepId?: string;
  proposals?: number;
  adopted?: number;
  rejected?: number;
  inconclusive?: number;
  lessonsWritten?: number;
}

export interface HarnessingLive {
  enabled?: boolean;
  autoEnabled?: boolean;
  signals?: HarnessingSignalPool;
  lastAutoStep?: HarnessingLastAutoStep | null;
}

export interface HarnessingHistoryItem {
  id: string;
  title: string;
  summary: string;
  scope: 'invariant' | 'domain';
  component: string;
  evidence: {
    probeId?: string;
    baseline?: number;
    candidate?: number;
    contrast?: number;
    trajectoryRef?: string;
    adoptedAt?: string;
  };
  createdAt: number | null;
}

export interface HarnessingSummary {
  live: HarnessingLive | null;
  liveError?: string;
  history: HarnessingHistoryItem[];
  stats: { total: number; byScope: Record<string, number>; byComponent: Record<string, number> };
  historyError?: string;
  fetchedAt: number;
}

export function fetchHarnessingSummary(): Promise<HarnessingSummary> {
  return apiGet<HarnessingSummary>('/api/harnessing/summary');
}
