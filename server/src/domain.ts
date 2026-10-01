// 预算 / 合同 / 项目域。资产版本谱系在 lineage.ts，审批与审计账本在 approval.ts；
// 本模块只保留财务侧聚合，并把资产、冲突等视图委托给谱系模型（始终指向具体版本）。
export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';

import { approvals, createApproval, decideApproval, recordAudit, type ApprovalStatus } from './approval.js';
import { projectAssets, rightsConflicts, ledgerState } from './lineage.js';

export { approvals, createApproval };

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }
export interface Contract { id: string; projectId: string; vendor: string; scope: string; ceiling: number; committed: number; paid: number; milestones: { name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid' }[]; }

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

/** 预算等非版本实体的审批决议；资产版本审批必须走 lineage.applyApprovalDecision。 */
export function approve(id: string, status: ApprovalStatus, comment = '') {
  const approval = approvals.find(item => item.id === id);
  if (!approval) return undefined;
  if (approval.entityType !== 'budget') {
    throw new Error('该审批由版本谱系流程处理');
  }
  return decideApproval(id, status, comment);
}

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const assets = projectAssets(projectId);
  const projectApprovals = approvals.filter(approval => approval.projectId === projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return {
    project: projects.find(project => project.id === projectId),
    planned, forecast, actual,
    variance: forecast - planned,
    utilization: planned ? actual / planned : 0,
    committed: lines.reduce((sum, line) => sum + line.committed, 0),
    contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0),
    assetCount: new Set(assets.map(asset => asset.lineageId)).size,
    pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length,
    highRiskLines: lines.filter(line => line.risk === 'high'),
    lines,
    contracts: projectContracts,
    assets,
    approvals: projectApprovals,
    ledger: ledgerState(),
  };
}

export { rightsConflicts, ledgerState };

export function dashboard() {
  return projects.map(project => projectSummary(project.id)).map(summary => ({
    id: summary.project?.id,
    title: summary.project?.title,
    status: summary.project?.status,
    forecast: summary.forecast,
    variance: summary.variance,
    pendingApprovals: summary.pendingApprovals,
    rightsConflicts: rightsConflicts(summary.project?.id ?? '').length,
    ledgerRevision: summary.ledger.revision,
  }));
}

// 种子审批（在谱系种子之后登记，使审计顺序可读）。
let seeded = false;
export function seedApprovals(): void {
  if (seeded) return;
  seeded = true;
  recordAudit({ action: 'CREATE', entity: 'budget', entityId: 'BUD-001-V3', actor: '制片主任', details: '从 V2 复制并调整后期科目' });
  createApproval({ projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任', approver: '财务负责人' });
  createApproval({ projectId: 'PRJ-001', entityType: 'assetVersion', entityId: 'AST-001-V7', title: '北境回声 E01 最终母版 v7 送审', requestedBy: '后期制片', approver: '总制片人', action: 'submit' });
  createApproval({ projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DLV-007', title: '海外节展交付包', requestedBy: '发行部', approver: '法务负责人' });
  // 海外节展包审批标记为通过（其预检在谱系种子中已完成）。
  const deliveryApproval = approvals.find(a => a.entityId === 'DLV-007');
  if (deliveryApproval) {
    decideApproval(deliveryApproval.id, 'approved', '已补充航拍授权凭证');
  }
}
