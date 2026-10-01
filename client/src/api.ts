// 与服务端共享的只读类型定义（保持结构一致；服务端是唯一事实源）。
export type VersionStatus = 'draft' | 'review' | 'approved' | 'locked' | 'withdrawn';

export interface Project { id: string; title: string; status: string; deliveryDate: string }
export interface AssetVersion {
  id: string; lineageId: string; name: string; type: string; version: number;
  status: VersionStatus; owner: string; checksum: string; parentVersionId: string | null;
  changeNote: string; createdAt: string; createdBy: string;
  territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[];
}
export interface LineageHead {
  lineage: { id: string; projectId: string; name: string; type: string; owner: string };
  head: AssetVersion | null;
  depth: number;
  versions: AssetVersion[];
}
export interface ScopeDiff {
  addedTerritories: string[]; removedTerritories: string[];
  addedPlatforms: string[]; removedPlatforms: string[];
  addedTags: string[]; removedTags: string[];
  windowChanged: boolean;
  parentWindow: { availableFrom: string; availableTo: string };
  window: { availableFrom: string; availableTo: string };
}
export interface Comparison {
  version: AssetVersion; parent: AssetVersion | null;
  checksumChanged: boolean; scopeChanged: boolean;
  sameAs: { versionId: string; label: string }[]; scopeDiff: ScopeDiff | null;
}
export interface VersionDetail {
  lineage: LineageHead['lineage'];
  version: AssetVersion;
  comparison: Comparison;
  children: AssetVersion[];
  referencedBy: { id: string; title: string; status: string }[];
  approvals: { id: string; title: string; status: string; approver: string; action?: string; comment?: string }[];
  audit: { id: string; action: string; actor: string; at: string; details: string; revision: number; denied?: boolean }[];
}
export interface Delivery {
  id: string; projectId: string; title: string; status: string;
  refs: { lineageId: string; versionId: string; label: string }[];
  precheck?: { at: string; actor: string; findings: string[] };
}
export interface Conflict {
  severity: 'critical' | 'warning'; assetA: string; assetB: string;
  versionAId: string; versionBId: string; reason: string;
}
export interface Approval { id: string; title: string; status: string; approver: string; entityType: string; entityId: string; action?: string }
export interface Summary {
  planned: number; forecast: number; actual: number; variance: number; utilization: number;
  committed: number; contractExposure: number; assetCount: number; pendingApprovals: number;
  highRiskLines: { subcategory: string; forecast: number; planned: number }[];
  lines: { id: string; category: string; subcategory: string; planned: number; forecast: number; actual: number; risk: string }[];
  contracts: { vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; status: string }[] }[];
  assets: AssetVersion[]; approvals: Approval[]; project: Project;
  ledger: { revision: number; lineageCount: number; versionCount: number; deliveryCount: number; pendingApprovals: number };
}

const api = '/api';

export class ApiError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

export async function request<T>(path: string, init?: RequestInit): Promise<{ data: T; revision: number }> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.code ?? 'HTTP_ERROR', response.status, body.message || `请求失败 (${response.status})`);
  return { data: body as T, revision: Number(response.headers.get('X-Ledger-Revision') ?? 0) };
}

export const shortChecksum = (checksum: string) => `${checksum.slice(0, 19)}…${checksum.slice(-4)}`;
export const today = () => new Date().toISOString().slice(0, 10);
