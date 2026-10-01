import type { ApprovalStatus as LegacyStatus } from './ledger.js';
import { VersionGenealogyLedger } from './ledger.js';
import { buildSeedEvents } from './seed.js';

export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';
export type {
  AssetType, AssetNode, AssetSeries, AssetConflict, ApprovalRecord, DeliveryPackage,
  Grant, PrecheckFinding, AuditEvent,
} from './ledger.js';

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }
export interface Contract { id: string; projectId: string; vendor: string; scope: string; ceiling: number; committed: number; paid: number; milestones: { name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid' }[]; }
export interface LegacyApproval { id: string; projectId: string; entityType: 'budget'; entityId: string; title: string; requestedBy: string; status: LegacyStatus; approver: string; createdAt: string; comment?: string; }

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);

export const projects: Project[] = [
  { id: 'PRJ-001', code: 'NORTHSTAR-S1', title: 'Northstar / 北境回声', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-001-V3', deliveryDate: iso(44) },
  { id: 'PRJ-002', code: 'ORBIT-DOC', title: 'Orbit / 轨道之外', season: 1, status: 'production', currency: 'CNY', budgetVersionId: 'BUD-002-V2', deliveryDate: iso(126) }
];
export const budgetLines: BudgetLine[] = [
  { id: 'BL-101', projectId: 'PRJ-001', category: '制作', subcategory: '主演与主创', planned: 12800000, committed: 11200000, actual: 10400000, forecast: 13100000, owner: '制片部', risk: 'medium' },
  { id: 'BL-102', projectId: 'PRJ-001', category: '制作', subcategory: '摄影器材与场地', planned: 6800000, committed: 6400000, actual: 5980000, forecast: 7020000, owner: '现场制片', risk: 'low' },
  { id: 'BL-103', projectId: 'PRJ-001', category: '后期', subcategory: '调色、DIT、母版', planned: 5400000, committed: 4300000, actual: 2800000, forecast: 5750000, owner: '后期制片', risk: 'high' },
  { id: 'BL-104', projectId: 'PRJ-001', category: '宣发', subcategory: '预告片与物料', planned: 3600000, committed: 1900000, actual: 1240000, forecast: 3200000, owner: '营销部', risk: 'medium' },
  { id: 'BL-201', projectId: 'PRJ-002', category: '制作', subcategory: '跨国拍摄', planned: 9200000, committed: 5100000, actual: 3300000, forecast: 9000000, owner: '制片部', risk: 'medium' }
];
export const contracts: Contract[] = [
  { id: 'CTR-01', projectId: 'PRJ-001', vendor: '曜石后期制作', scope: '4K HDR 调色、声音、DCP 母版', ceiling: 5200000, committed: 4300000, paid: 2300000, milestones: [{ name: '锁剪交付', due: iso(8), amount: 1200000, status: 'invoiced' }, { name: '母版验收', due: iso(36), amount: 2000000, status: 'open' }] },
  { id: 'CTR-02', projectId: 'PRJ-001', vendor: '远景国际版权', scope: '北美与欧洲音乐同步许可', ceiling: 880000, committed: 880000, paid: 440000, milestones: [{ name: '签署', due: iso(-16), amount: 440000, status: 'paid' }, { name: '交付版权证明', due: iso(4), amount: 440000, status: 'invoiced' }] },
  { id: 'CTR-03', projectId: 'PRJ-002', vendor: '云帧视觉', scope: '纪录片航拍与卫星素材', ceiling: 1600000, committed: 1100000, paid: 600000, milestones: [{ name: '素材包一', due: iso(20), amount: 500000, status: 'open' }] }
];

// ---- 版本谱系台账：只增事件日志 + 内存物化视图 -------------------------------

export const ledger = new VersionGenealogyLedger();
ledger.loadSeedEvents(buildSeedEvents());

/** 预算审批不属于资产谱系，沿用简单可变记录；审批 ID 与谱系 ID 同号段（APR-01） */
const budgetApprovals: LegacyApproval[] = [
  { id: 'APR-01', projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任', status: 'pending', approver: '财务负责人', createdAt: iso(-1) }
];

/** 兼容旧控制台的扁平资产视图：每个谱系取当前版本节点，id 指向具体版本 */
export function currentAssets(projectId: string) {
  return ledger.lineage(projectId).series.map(s => {
    const n = s.nodes[s.nodes.length - 1];
    return {
      id: n.nodeId, seriesId: s.seriesId, projectId, name: n.name, type: n.type,
      version: n.version, status: n.status === 'in_review' ? 'review' : n.status,
      owner: n.owner, checksum: n.checksum, territories: n.grant.territories,
      platforms: n.grant.platforms, availableFrom: n.grant.availableFrom, availableTo: n.grant.availableTo,
      rightsTags: n.grant.rightsTags, grantState: n.grantState,
    };
  });
}

export function approvalsForProject(projectId: string) {
  return [...budgetApprovals.filter(a => a.projectId === projectId), ...ledger.approvalsForProject(projectId)];
}

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const projectApprovals = approvalsForProject(projectId);
  const { series } = ledger.lineage(projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return {
    project: projects.find(project => project.id === projectId),
    planned, forecast, actual, variance: forecast - planned,
    utilization: planned ? actual / planned : 0,
    committed: lines.reduce((sum, line) => sum + line.committed, 0),
    contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0),
    assetCount: series.length,
    nodeCount: series.reduce((sum, s) => sum + s.nodes.length, 0),
    pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length,
    highRiskLines: lines.filter(line => line.risk === 'high'),
    lines, contracts: projectContracts,
    assets: currentAssets(projectId), approvals: projectApprovals,
  };
}

export function rightsConflicts(projectId = projects[0].id) {
  return ledger.rightsConflicts(projectId);
}

/** 审批统一入口：预算审批走本地记录，资产版本/交付包走谱系台账（指向具体版本） */
export function approve(id: string, status: 'approved' | 'rejected', comment = '') {
  const legacy = budgetApprovals.find(a => a.id === id);
  if (legacy) {
    legacy.status = status; legacy.comment = comment;
    return legacy;
  }
  return ledger.decideApproval(id, status, comment, { actor: '当前审批人' });
}

export function createBudgetApproval(input: Pick<LegacyApproval, 'projectId' | 'entityId' | 'title' | 'requestedBy' | 'approver'>) {
  const max = Math.max(...[...budgetApprovals.map(a => Number(a.id.replace('APR-', ''))), ...ledger.approvalsForProject(input.projectId).map(a => Number(a.id.replace('APR-', '')))].filter(Number.isFinite));
  const item: LegacyApproval = { ...input, id: `APR-${String(max + 1).padStart(2, '0')}`, entityType: 'budget', status: 'pending', createdAt: new Date().toISOString() };
  budgetApprovals.unshift(item);
  return item;
}

export function dashboard() {
  return projects.map(project => projectSummary(project.id)).map(summary => ({
    id: summary.project?.id, title: summary.project?.title, status: summary.project?.status,
    forecast: summary.forecast, variance: summary.variance, pendingApprovals: summary.pendingApprovals,
    rightsConflicts: ledger.rightsConflicts(summary.project!.id).length,
  }));
}
