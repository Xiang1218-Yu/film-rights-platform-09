// 审批队列与仅追加审计账本。
// 审计事件只允许 unshift（最新在前），不提供更新/删除接口；
// ledger revision 直接等于审计事件数，任何被接受或被拒绝的状态变更都会留下痕迹，
// 因此“锁定历史被静默覆盖”在结构上不可能发生。
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ApprovalEntityType = 'budget' | 'assetVersion' | 'delivery';

export interface Approval {
  id: string;
  projectId: string;
  entityType: ApprovalEntityType;
  /** 指向具体版本 id（如 AST-001-V7），绝不只指向资产族。 */
  entityId: string;
  title: string;
  requestedBy: string;
  approver: string;
  status: ApprovalStatus;
  createdAt: string;
  comment?: string;
  /** assetVersion 审批的动作语义：送审通过 / 锁定。 */
  action?: 'submit' | 'lock';
}

export interface AuditEvent {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  actor: string;
  at: string;
  details: string;
  /** 该事件落账后账本的修订号，单调递增。 */
  revision: number;
  denied?: boolean;
}

export class LedgerError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export const approvals: Approval[] = [];
export const auditEvents: AuditEvent[] = [];

let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`.toUpperCase();
}

/** 当前账本修订号。审计只追加，所以它单调不减。 */
export function getRevision(): number {
  return auditEvents.length;
}

export function recordAudit(input: {
  action: string;
  entity: string;
  entityId: string;
  actor: string;
  details: string;
  denied?: boolean;
}): AuditEvent {
  const event: AuditEvent = {
    id: nextId('AUD'),
    at: new Date().toISOString(),
    revision: auditEvents.length + 1,
    ...input,
  };
  auditEvents.unshift(event);
  return event;
}

export function createApproval(input: {
  projectId: string;
  entityType: ApprovalEntityType;
  entityId: string;
  title: string;
  requestedBy: string;
  approver: string;
  action?: 'submit' | 'lock';
}): Approval {
  const item: Approval = {
    ...input,
    id: nextId('APR'),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  approvals.unshift(item);
  recordAudit({
    action: 'APPROVAL_REQUESTED',
    entity: input.entityType,
    entityId: input.entityId,
    actor: input.requestedBy,
    details: `${input.title}，待 ${input.approver} 审批`,
  });
  return item;
}

export function decideApproval(id: string, status: ApprovalStatus, comment = '', actor = '当前审批人'): Approval {
  const item = approvals.find(approval => approval.id === id);
  if (!item) throw new LedgerError('APPROVAL_NOT_FOUND', 404, '审批不存在', { id });
  if (item.status !== 'pending') {
    throw new LedgerError('APPROVAL_ALREADY_DECIDED', 409, '该审批已决议，不能重复决定', {
      current: item.status,
    });
  }
  item.status = status;
  item.comment = comment;
  recordAudit({
    action: status === 'approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
    entity: item.entityType,
    entityId: item.entityId,
    actor,
    details: comment || `${item.title} 已${status === 'approved' ? '通过' : '驳回'}`,
  });
  return item;
}

export function auditsFor(entity: string, entityId: string): AuditEvent[] {
  return auditEvents.filter(event => event.entity === entity && event.entityId === entityId);
}
