/**
 * VersionGenealogyLedger —— 资产版本谱系台账
 *
 * 设计权衡：不可变历史 vs 内存查询模型
 * - 所有状态变化只能通过 append(events) 写入只增事件日志；事件日志是唯一事实来源（single source of truth），
 *   锁定后的版本在物理上无法被静默覆盖（不存在 update-in-place 的代码路径）。
 * - 查询侧维护一个内存物化视图（nodes / series / packages / approvals），每次提交后整体重放重建。
 *   数据量小（后期日更级别），重放成本可忽略；未来可替换为快照 + PostgreSQL 持久化，接口不变。
 * - Idempotency-Key 去重表属于命令层而非领域历史，单独存放（持久化实现中应落到独立表，TTL 过期）。
 */

export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type NodeStatus = 'draft' | 'in_review' | 'approved' | 'rejected' | 'locked' | 'withdrawn';
export type GrantState = 'pending' | 'active' | 'expired' | 'revoked';
export type PackageStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type ApprovalEntityType = 'asset_version' | 'delivery';
export type Severity = 'critical' | 'warning';

export interface Grant {
  territories: string[];
  platforms: string[];
  availableFrom: string; // ISO yyyy-mm-dd
  availableTo: string;
  rightsTags: string[];
}

export interface EventBase { seq: number; at: string; actor: string; }

export type LedgerEvent =
  | (EventBase & { type: 'version_registered'; seriesId: string; projectId: string; name: string; assetType: AssetType; owner: string; version: number; parentId: string | null; nodeId: string; checksum: string; changeNote: string; grant: Grant; registeredBy: string })
  | (EventBase & { type: 'review_submitted'; nodeId: string; approvalId: string; approver: string; title: string })
  | (EventBase & { type: 'approval_decided'; approvalId: string; decision: 'approved' | 'rejected'; comment: string; entityType: ApprovalEntityType; entityId: string })
  | (EventBase & { type: 'version_locked'; nodeId: string })
  | (EventBase & { type: 'version_withdrawn'; nodeId: string; reason: string })
  | (EventBase & { type: 'grant_revoked'; nodeId: string; reason: string })
  | (EventBase & { type: 'package_created'; packageId: string; projectId: string; name: string })
  | (EventBase & { type: 'package_ref_added'; packageId: string; nodeId: string })
  | (EventBase & { type: 'package_ref_removed'; packageId: string; nodeId: string })
  | (EventBase & { type: 'package_prechecked'; packageId: string })
  | (EventBase & { type: 'package_submitted'; packageId: string; approvalId: string; approver: string });

export interface AssetNode {
  nodeId: string;
  seriesId: string;
  projectId: string;
  name: string;
  type: AssetType;
  version: number;
  parentId: string | null;
  owner: string;
  checksum: string;
  changeNote: string;
  registeredBy: string;
  createdAt: string;
  status: NodeStatus;
  grant: Grant;
  grantState: GrantState;
  revokedReason?: string;
  lockedAt?: string;
  withdrawReason?: string;
  currentApprovalId?: string;
  referencedBy?: { packageId: string; packageName: string; status: PackageStatus }[];
}

export interface AssetSeries {
  seriesId: string;
  projectId: string;
  name: string;
  type: AssetType;
  owner: string;
  revision: number; // 谱系内版本/状态事件计数，用于乐观并发登记
  currentVersion: number;
  currentNodeId: string;
  nodes: AssetNode[]; // 按版本升序
}

export interface PackageRef { nodeId: string; addedAt: string; addedBy: string; }

export interface DeliveryPackage {
  id: string;
  projectId: string;
  name: string;
  owner: string;
  status: PackageStatus;
  createdAt: string;
  refs: PackageRef[];
  precheckAt?: string;
  submittedAt?: string;
  approvedAt?: string;
  approvalId?: string;
}

export interface ApprovalRecord {
  id: string;
  projectId: string;
  entityType: ApprovalEntityType;
  entityId: string;
  title: string;
  requestedBy: string;
  approver: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  comment?: string;
}

export interface AssetConflict {
  severity: Severity;
  nodeA: string; labelA: string;
  nodeB: string; labelB: string;
  reason: string;
}

export interface PrecheckFinding {
  level: 'block' | 'warning';
  code: 'VERSION_WITHDRAWN' | 'GRANT_REVOKED' | 'GRANT_LAPSED_AFTER_LOCK' | 'GRANT_EXPIRED'
      | 'GRANT_NOT_STARTED' | 'DUPLICATE_CHECKSUM' | 'NEW_VERSION_AVAILABLE' | 'RIGHTS_CONFLICT';
  nodeId?: string;
  message: string;
}

export interface AuditEvent {
  id: string;
  seq: number;
  action: string;
  entity: string;
  entityId: string;
  actor: string;
  at: string;
  details: string;
}

export type ErrorCode =
  | 'NOT_FOUND' | 'VALIDATION' | 'CHECKSUM_DUPLICATE' | 'VERSION_GAP' | 'VERSION_CONFLICT'
  | 'STATE_CONFLICT' | 'LOCKED' | 'PACKAGE_REFERENCED' | 'PACKAGE_NOT_EDITABLE'
  | 'GRANT_LAPSED' | 'PRECHECK_FAILED' | 'IDEMPOTENCY_CONFLICT';

export class LedgerError extends Error {
  constructor(public code: ErrorCode, message: string, public details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface RegisterInput {
  seriesId: string;
  projectId?: string;
  name?: string;
  type?: AssetType;
  owner?: string;
  version?: number;          // 默认 last+1；显式跳号会被拒绝
  parentId?: string | null;  // 默认谱系当前版本；新谱系必须为 null
  checksum: string;
  changeNote: string;
  registeredBy?: string;
  grant: Grant;
}

export interface CommandOptions {
  expectedRevision?: number; // 乐观并发：登记时谱系 revision 必须匹配
  idempotencyKey?: string;   // 重复请求返回首次结果
  actor?: string;
}

interface SeriesMeta { seriesId: string; projectId: string; name: string; type: AssetType; owner: string; revision: number; nodeIds: string[]; }
interface IdempotentRecord { fingerprint: string; outcome: { ok: true; value: unknown } | { ok: false; code: ErrorCode; message: string; details: Record<string, unknown> }; }

const today = () => new Date().toISOString().slice(0, 10);

export function grantStateOf(grant: Grant, revoked: boolean, at = today()): GrantState {
  if (revoked) return 'revoked';
  if (at > grant.availableTo) return 'expired';
  if (at < grant.availableFrom) return 'pending';
  return 'active';
}

const overlap = (a: Grant, b: Grant) =>
  a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom;
const sameTerritory = (a: Grant, b: Grant) =>
  a.territories.includes('全球') || b.territories.includes('全球') ||
  a.territories.some(t => b.territories.includes(t));

export class VersionGenealogyLedger {
  private events: LedgerEvent[] = [];
  private nodes = new Map<string, AssetNode>();
  private series = new Map<string, SeriesMeta>();
  private packages = new Map<string, DeliveryPackage>();
  private approvals = new Map<string, ApprovalRecord>();
  private idempotency = new Map<string, IdempotentRecord>();

  get revision() { return this.events.length; }

  /** 从只增事件重建内存物化视图（种子装载 / 每次提交后调用） */
  private replay(incoming: LedgerEvent[]) {
    this.nodes.clear(); this.series.clear(); this.packages.clear(); this.approvals.clear();
    for (const e of incoming) {
      switch (e.type) {
        case 'version_registered': {
          if (!this.series.has(e.seriesId)) {
            this.series.set(e.seriesId, { seriesId: e.seriesId, projectId: e.projectId, name: e.name, type: e.assetType, owner: e.owner, revision: 0, nodeIds: [] });
          }
          const s = this.series.get(e.seriesId)!;
          s.revision += 1;
          s.nodeIds.push(e.nodeId);
          this.nodes.set(e.nodeId, {
            nodeId: e.nodeId, seriesId: e.seriesId, projectId: e.projectId, name: e.name, type: e.assetType,
            version: e.version, parentId: e.parentId, owner: e.owner, checksum: e.checksum,
            changeNote: e.changeNote, registeredBy: e.registeredBy, createdAt: e.at,
            status: 'draft', grant: e.grant, grantState: grantStateOf(e.grant, false, e.at.slice(0, 10)),
          });
          break;
        }
        case 'review_submitted': {
          const n = this.nodes.get(e.nodeId)!;
          n.status = 'in_review'; n.currentApprovalId = e.approvalId;
          this.approvals.set(e.approvalId, { id: e.approvalId, projectId: n.projectId, entityType: 'asset_version', entityId: e.nodeId, title: e.title, requestedBy: e.actor, approver: e.approver, status: 'pending', createdAt: e.at });
          this.series.get(n.seriesId)!.revision += 1;
          break;
        }
        case 'approval_decided': {
          const a = this.approvals.get(e.approvalId)!;
          a.status = e.decision; a.comment = e.comment; a.decidedAt = e.at;
          if (e.entityType === 'asset_version') {
            const n = this.nodes.get(e.entityId)!;
            n.status = e.decision === 'approved' ? 'approved' : 'rejected';
            this.series.get(n.seriesId)!.revision += 1;
          } else {
            const pkg = this.packages.get(e.entityId)!;
            pkg.status = e.decision === 'approved' ? 'approved' : 'rejected';
            if (e.decision === 'approved') pkg.approvedAt = e.at;
          }
          break;
        }
        case 'version_locked': {
          const n = this.nodes.get(e.nodeId)!;
          n.status = 'locked'; n.lockedAt = e.at;
          this.series.get(n.seriesId)!.revision += 1;
          break;
        }
        case 'version_withdrawn': {
          const n = this.nodes.get(e.nodeId)!;
          n.status = 'withdrawn'; n.withdrawReason = e.reason;
          // 撤回时自动关闭进行中的审批（审批历史保留，标记 withdrawn 而非删除）
          if (n.currentApprovalId) {
            const a = this.approvals.get(n.currentApprovalId);
            if (a && a.status === 'pending') { a.status = 'withdrawn'; a.decidedAt = e.at; a.comment = '版本撤回，审批自动关闭'; }
          }
          this.series.get(n.seriesId)!.revision += 1;
          break;
        }
        case 'grant_revoked': {
          const n = this.nodes.get(e.nodeId)!;
          n.grantState = 'revoked'; n.revokedReason = e.reason;
          this.series.get(n.seriesId)!.revision += 1;
          break;
        }
        case 'package_created':
          this.packages.set(e.packageId, { id: e.packageId, projectId: e.projectId, name: e.name, owner: e.actor, status: 'draft', createdAt: e.at, refs: [] });
          break;
        case 'package_ref_added': {
          const pkg = this.packages.get(e.packageId)!;
          if (!pkg.refs.some(r => r.nodeId === e.nodeId)) pkg.refs.push({ nodeId: e.nodeId, addedAt: e.at, addedBy: e.actor });
          break;
        }
        case 'package_ref_removed': {
          const pkg = this.packages.get(e.packageId)!;
          pkg.refs = pkg.refs.filter(r => r.nodeId !== e.nodeId);
          break;
        }
        case 'package_prechecked':
          this.packages.get(e.packageId)!.precheckAt = e.at;
          break;
        case 'package_submitted': {
          const pkg = this.packages.get(e.packageId)!;
          pkg.status = 'submitted'; pkg.submittedAt = e.at; pkg.approvalId = e.approvalId;
          this.approvals.set(e.approvalId, { id: e.approvalId, projectId: pkg.projectId, entityType: 'delivery', entityId: pkg.id, title: `交付包送审：${pkg.name}`, requestedBy: e.actor, approver: e.approver, status: 'pending', createdAt: e.at });
          break;
        }
      }
    }
    // grantState 依赖当前日期：每次重放按今天重新计算（revoked 状态优先）
    for (const n of this.nodes.values()) {
      const revoked = n.grantState === 'revoked';
      n.grantState = grantStateOf(n.grant, revoked);
    }
  }

  /** 仅供种子数据装载：直接写入事件流（跳过业务校验），随后重放 */
  loadSeedEvents(seed: LedgerEvent[]) {
    this.events = [...seed];
    this.replay(this.events);
  }

  private commit(event: LedgerEvent) {
    this.events.push(event);
    this.replay(this.events); // 整体重放；日更规模下足够廉价，且杜绝增量投影与日志漂移
  }

  private nextSeq() { return this.events.length + 1; }

  private nextApprovalId() {
    let max = 1;
    for (const a of this.approvals.values()) {
      const n = Number(a.id.replace('APR-', ''));
      if (Number.isFinite(n) && n >= max) max = n + 1;
    }
    return `APR-${String(max).padStart(2, '0')}`;
  }

  // ---- 命令层：幂等包装 -----------------------------------------------------

  private withIdempotency<T>(opts: CommandOptions, fingerprint: string, fn: () => T): T {
    const key = opts.idempotencyKey;
    if (key) {
      const seen = this.idempotency.get(key);
      if (seen) {
        if (seen.fingerprint !== fingerprint) throw new LedgerError('IDEMPOTENCY_CONFLICT', '同一幂等键携带了不同的请求内容', { idempotencyKey: key });
        if (!seen.outcome.ok) throw new LedgerError(seen.outcome.code, seen.outcome.message, seen.outcome.details);
        return seen.outcome.value as T; // 重复请求：原样返回首次结果，不追加事件
      }
      try {
        const value = fn();
        this.idempotency.set(key, { fingerprint, outcome: { ok: true, value } });
        return value;
      } catch (err) {
        if (err instanceof LedgerError) this.idempotency.set(key, { fingerprint, outcome: { ok: false, code: err.code, message: err.message, details: err.details } });
        throw err;
      }
    }
    return fn();
  }

  // ---- 登记 -----------------------------------------------------------------

  registerVersion(input: RegisterInput, opts: CommandOptions = {}): AssetNode {
    const fingerprint = JSON.stringify({ cmd: 'register', input });
    return this.withIdempotency(opts, fingerprint, () => {
      const actor = opts.actor ?? input.registeredBy ?? '后期值班';
      const existing = this.series.get(input.seriesId);

      if (existing) {
        if (opts.expectedRevision !== undefined && opts.expectedRevision !== existing.revision) {
          throw new LedgerError('VERSION_CONFLICT', `谱系 ${input.seriesId} 已被其他登记更新（revision ${existing.revision}），请基于最新版本重试`, { seriesId: input.seriesId, expected: opts.expectedRevision, current: existing.revision });
        }
        const last = this.nodes.get(existing.nodeIds[existing.nodeIds.length - 1])!;
        const version = input.version ?? last.version + 1;
        if (version !== last.version + 1) {
          throw new LedgerError('VERSION_GAP', `版本号必须连续：${input.seriesId} 当前为 v${last.version}，下一版只能是 v${last.version + 1}`, { seriesId: input.seriesId, expected: last.version + 1, got: version });
        }
        const parentId = input.parentId === undefined ? last.nodeId : input.parentId;
        if (parentId !== null && !this.nodes.has(parentId)) throw new LedgerError('NOT_FOUND', `父版本不存在：${parentId}`, { parentId });
        if (parentId && !parentId.startsWith(`${input.seriesId}@`)) throw new LedgerError('VALIDATION', '父版本必须属于同一谱系', { parentId });
        return this.doRegister(existing, version, parentId, input, actor);
      }

      // 新谱系
      if (!input.projectId || !input.name || !input.type) throw new LedgerError('VALIDATION', '创建新谱系需要 projectId / name / type');
      const version = input.version ?? 1;
      if (version !== 1 || (input.parentId !== undefined && input.parentId !== null)) {
        throw new LedgerError('VERSION_GAP', '新谱系必须从 v1 开始且没有父版本', { seriesId: input.seriesId, got: version });
      }
      this.validateGrant(input.grant);
      const meta: SeriesMeta = { seriesId: input.seriesId, projectId: input.projectId, name: input.name, type: input.type, owner: input.owner ?? actor, revision: 0, nodeIds: [] };
      this.series.set(input.seriesId, meta); // 先占位以便 doRegister 找到谱系
      return this.doRegister(meta, 1, null, input, actor);
    });
  }

  private validateGrant(grant: Grant | undefined): asserts grant is Grant {
    if (!grant) throw new LedgerError('VALIDATION', '缺少授权范围 grant');
    for (const key of ['territories', 'platforms', 'rightsTags'] as const) {
      if (!Array.isArray(grant[key]) || grant[key].length === 0) throw new LedgerError('VALIDATION', `授权范围缺少 ${key}`);
    }
    if (!grant.availableFrom || !grant.availableTo || grant.availableFrom > grant.availableTo) throw new LedgerError('VALIDATION', '授权窗口无效');
  }

  private doRegister(meta: SeriesMeta, version: number, parentId: string | null, input: RegisterInput, actor: string): AssetNode {
    this.validateGrant(input.grant);
    if (!input.checksum?.trim()) throw new LedgerError('VALIDATION', 'checksum 不能为空');
    if (!input.changeNote?.trim()) throw new LedgerError('VALIDATION', '变更说明不能为空');
    // 文件是否真的变了：新版本的 checksum 必须区别于本谱系任一历史版本
    // （含已撤回版本，防止旧文件冒充新版本）。跨谱系的相同文件允许登记，
    // 但同时进入交付包时由预检 DUPLICATE_CHECKSUM 拦截。
    const dup = meta.nodeIds.map(id => this.nodes.get(id)!).find(n => n.checksum === input.checksum);
    if (dup) throw new LedgerError('CHECKSUM_DUPLICATE', `checksum 与本谱系历史版本完全相同（${dup.nodeId}），文件内容没有变化，不能登记为新版本`, { existingNodeId: dup.nodeId, existingVersion: dup.version, checksum: input.checksum });

    const nodeId = `${meta.seriesId}@${version}`;
    this.commit({
      type: 'version_registered', seq: this.nextSeq(), at: new Date().toISOString(), actor,
      seriesId: meta.seriesId, projectId: meta.projectId, name: meta.name, assetType: meta.type,
      owner: meta.owner, version, parentId, nodeId, checksum: input.checksum,
      changeNote: input.changeNote, grant: input.grant, registeredBy: actor,
    });
    return this.getNode(nodeId);
  }

  // ---- 送审 / 审批 / 锁定 / 撤回 / 授权撤销 ----------------------------------

  submitForReview(nodeId: string, approver: string, opts: CommandOptions = {}): ApprovalRecord {
    const fingerprint = JSON.stringify({ cmd: 'submit', nodeId, approver });
    return this.withIdempotency(opts, fingerprint, () => {
      const n = this.requireNode(nodeId);
      if (n.status === 'withdrawn' || n.status === 'locked') throw new LedgerError('STATE_CONFLICT', `${nodeId} 已${n.status === 'locked' ? '锁定' : '撤回'}，不能送审`, { nodeId, status: n.status });
      if (n.status === 'in_review' && n.currentApprovalId) {
        const a = this.approvals.get(n.currentApprovalId);
        if (a?.status === 'pending') return a; // 已有进行中审批，幂等返回
      }
      if (n.grantState !== 'active') throw new LedgerError('GRANT_LAPSED', `授权当前${n.grantState === 'expired' ? '已过期' : n.grantState === 'revoked' ? '已被撤销' : '尚未生效'}，不能送审`, { nodeId, grantState: n.grantState });
      const approvalId = this.nextApprovalId();
      this.commit({ type: 'review_submitted', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? n.owner, nodeId, approvalId, approver, title: `${n.name} v${n.version} 锁定审批` });
      return structuredClone(this.approvals.get(approvalId)!);
    });
  }

  decideApproval(approvalId: string, decision: 'approved' | 'rejected', comment: string, opts: CommandOptions = {}): ApprovalRecord {
    const fingerprint = JSON.stringify({ cmd: 'decide', approvalId, decision, comment });
    return this.withIdempotency(opts, fingerprint, () => {
      const a = this.approvals.get(approvalId);
      if (!a) throw new LedgerError('NOT_FOUND', `审批不存在：${approvalId}`);
      if (a.status !== 'pending') throw new LedgerError('STATE_CONFLICT', `审批 ${approvalId} 已结束（${a.status}），不能重复决定`, { approvalId, status: a.status });
      this.commit({ type: 'approval_decided', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? a.approver, approvalId, decision, comment, entityType: a.entityType, entityId: a.entityId });
      return structuredClone(this.approvals.get(approvalId)!);
    });
  }

  lockVersion(nodeId: string, opts: CommandOptions = {}): AssetNode {
    const fingerprint = JSON.stringify({ cmd: 'lock', nodeId });
    return this.withIdempotency(opts, fingerprint, () => {
      const n = this.requireNode(nodeId);
      if (n.status === 'locked') return n;
      if (n.status !== 'approved') throw new LedgerError('STATE_CONFLICT', `只有审批通过的版本才能锁定，当前状态：${n.status}`, { nodeId, status: n.status });
      // 锁定前授权必须有效；锁定后授权再失效走 grant_revoked / 日期过期检测，锁定记录本身永不改变
      if (n.grantState !== 'active') throw new LedgerError('GRANT_LAPSED', `授权${n.grantState === 'expired' ? '已过期' : n.grantState === 'revoked' ? '已被撤销' : '尚未生效'}，不能锁定；请先续签授权`, { nodeId, grantState: n.grantState });
      this.commit({ type: 'version_locked', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? n.owner, nodeId });
      return this.getNode(nodeId);
    });
  }

  withdrawVersion(nodeId: string, reason: string, opts: CommandOptions = {}): AssetNode {
    const fingerprint = JSON.stringify({ cmd: 'withdraw', nodeId, reason });
    return this.withIdempotency(opts, fingerprint, () => {
      const n = this.requireNode(nodeId);
      if (n.status === 'locked') throw new LedgerError('LOCKED', `${nodeId} 已锁定，不可撤回（锁定历史不可覆盖）；如授权失效请使用“撤销授权”`, { nodeId });
      if (n.status === 'withdrawn') return n;
      if (!reason?.trim()) throw new LedgerError('VALIDATION', '撤回必须填写原因');
      // 旧版是否仍被交付包引用：已送审/已批准的引用直接阻止；草稿引用只告警
      const refs = this.findReferences(nodeId);
      const activeRefs = refs.filter(r => r.status === 'submitted' || r.status === 'approved');
      if (activeRefs.length) throw new LedgerError('PACKAGE_REFERENCED', `${nodeId} 仍被 ${activeRefs.length} 个在途交付包引用，必须先移除引用或改引新版本`, { nodeId, activeRefs, draftRefs: refs.filter(r => r.status === 'draft' || r.status === 'rejected') });
      this.commit({ type: 'version_withdrawn', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? n.owner, nodeId, reason });
      return this.getNode(nodeId);
    });
  }

  /** 授权撤销：即使版本已锁定也允许（只追加事件，锁定的文件/元数据记录保持不变） */
  revokeGrant(nodeId: string, reason: string, opts: CommandOptions = {}): AssetNode {
    const fingerprint = JSON.stringify({ cmd: 'revoke-grant', nodeId, reason });
    return this.withIdempotency(opts, fingerprint, () => {
      const n = this.requireNode(nodeId);
      if (n.grantState === 'revoked') return n;
      if (!reason?.trim()) throw new LedgerError('VALIDATION', '撤销授权必须填写原因');
      this.commit({ type: 'grant_revoked', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? '法务负责人', nodeId, reason });
      return this.getNode(nodeId);
    });
  }

  // ---- 交付包 ---------------------------------------------------------------

  createPackage(projectId: string, name: string, opts: CommandOptions & { owner?: string } = {}): DeliveryPackage {
    const fingerprint = JSON.stringify({ cmd: 'pkg-create', projectId, name });
    return this.withIdempotency(opts, fingerprint, () => {
      if (!name?.trim()) throw new LedgerError('VALIDATION', '交付包名称不能为空');
      const max = [...this.packages.keys()].reduce((m, id) => Math.max(m, Number(id.replace('DEL-', '')) || 0), 6);
      const packageId = `DEL-${String(max + 1).padStart(3, '0')}`;
      this.commit({ type: 'package_created', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? opts.owner ?? '发行部', packageId, projectId, name });
      return this.getPackage(packageId);
    });
  }

  private requireEditablePackage(pkg: DeliveryPackage) {
    if (pkg.status !== 'draft' && pkg.status !== 'rejected') throw new LedgerError('PACKAGE_NOT_EDITABLE', `交付包 ${pkg.id} 已${pkg.status === 'approved' ? '批准' : '送审'}，不能改动引用`, { packageId: pkg.id, status: pkg.status });
  }

  addPackageRef(packageId: string, nodeId: string, opts: CommandOptions = {}): DeliveryPackage {
    const fingerprint = JSON.stringify({ cmd: 'pkg-ref-add', packageId, nodeId });
    return this.withIdempotency(opts, fingerprint, () => {
      const pkg = this.requirePackage(packageId);
      this.requireEditablePackage(pkg);
      const n = this.requireNode(nodeId);
      if (n.projectId !== pkg.projectId) throw new LedgerError('VALIDATION', '不能跨项目引用资产版本', { packageId, nodeId });
      if (n.status === 'withdrawn') throw new LedgerError('STATE_CONFLICT', `${nodeId} 已撤回，不能加入交付包`, { nodeId });
      this.commit({ type: 'package_ref_added', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? pkg.owner, packageId, nodeId });
      return this.getPackage(packageId);
    });
  }

  removePackageRef(packageId: string, nodeId: string, opts: CommandOptions = {}): DeliveryPackage {
    const fingerprint = JSON.stringify({ cmd: 'pkg-ref-remove', packageId, nodeId });
    return this.withIdempotency(opts, fingerprint, () => {
      const pkg = this.requirePackage(packageId);
      this.requireEditablePackage(pkg);
      this.commit({ type: 'package_ref_removed', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? pkg.owner, packageId, nodeId });
      return this.getPackage(packageId);
    });
  }

  /** 预检：回答“旧版是否仍被引用 / 授权是否还有效 / 文件是否重复” */
  precheckPackage(packageId: string, opts: CommandOptions = {}): { findings: PrecheckFinding[]; passed: boolean } {
    const fingerprint = JSON.stringify({ cmd: 'precheck', packageId, at: 'pre' }); // 预检可重复，结果随日期变化故不缓存
    void fingerprint;
    const pkg = this.requirePackage(packageId);
    const findings = this.computePrecheck(pkg);
    this.commit({ type: 'package_prechecked', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? pkg.owner, packageId });
    return { findings, passed: !findings.some(f => f.level === 'block') };
  }

  private computePrecheck(pkg: DeliveryPackage): PrecheckFinding[] {
    const findings: PrecheckFinding[] = [];
    const seenChecksums = new Map<string, string>();
    for (const ref of pkg.refs) {
      const n = this.nodes.get(ref.nodeId);
      if (!n) { findings.push({ level: 'block', code: 'VERSION_WITHDRAWN', nodeId: ref.nodeId, message: `${ref.nodeId} 已不存在` }); continue; }
      if (n.status === 'withdrawn') findings.push({ level: 'block', code: 'VERSION_WITHDRAWN', nodeId: n.nodeId, message: `${n.name} v${n.version} 已撤回：${n.withdrawReason ?? ''}` });
      if (n.grantState === 'revoked') findings.push({ level: 'block', code: n.status === 'locked' ? 'GRANT_LAPSED_AFTER_LOCK' : 'GRANT_REVOKED', nodeId: n.nodeId, message: `${n.name} v${n.version} 授权已被撤销（${n.revokedReason}）${n.status === 'locked' ? '；版本处于锁定状态，锁定记录保留但不得继续交付' : ''}` });
      else if (n.grantState === 'expired') findings.push({ level: 'block', code: 'GRANT_EXPIRED', nodeId: n.nodeId, message: `${n.name} v${n.version} 授权已于 ${n.grant.availableTo} 过期` });
      else if (n.grantState === 'pending') findings.push({ level: 'warning', code: 'GRANT_NOT_STARTED', nodeId: n.nodeId, message: `${n.name} v${n.version} 授权 ${n.grant.availableFrom} 才生效` });
      const prev = seenChecksums.get(n.checksum);
      if (prev) findings.push({ level: 'block', code: 'DUPLICATE_CHECKSUM', nodeId: n.nodeId, message: `${prev} 与 ${n.nodeId} checksum 相同，交付包内存在重复文件` });
      else seenChecksums.set(n.checksum, n.nodeId);
      const s = this.series.get(n.seriesId)!;
      const currentId = s.nodeIds[s.nodeIds.length - 1];
      if (currentId !== n.nodeId) {
        const current = this.nodes.get(currentId)!;
        if (current.status !== 'withdrawn') findings.push({ level: 'warning', code: 'NEW_VERSION_AVAILABLE', nodeId: n.nodeId, message: `交付包引用的是旧版 ${n.nodeId}，谱系当前版本为 ${currentId}（${current.status}）` });
      }
    }
    // 包内版本与项目内其他在效资产的版权冲突
    const projectActive = [...this.nodes.values()].filter(n => n.projectId === pkg.projectId && n.status !== 'withdrawn' && n.grantState === 'active');
    const inside = new Set(pkg.refs.map(r => r.nodeId));
    for (const ref of pkg.refs) {
      const n = this.nodes.get(ref.nodeId);
      if (!n || n.grantState !== 'active') continue;
      for (const other of projectActive) {
        if (other.nodeId === n.nodeId || other.seriesId === n.seriesId || inside.has(other.nodeId)) continue;
        const conflict = this.pairConflict(n, other);
        if (conflict) findings.push({ level: conflict.severity === 'critical' ? 'block' : 'warning', code: 'RIGHTS_CONFLICT', nodeId: n.nodeId, message: `${conflict.labelA} ↔ ${conflict.labelB}：${conflict.reason}` });
      }
    }
    return findings;
  }

  submitPackage(packageId: string, approver: string, opts: CommandOptions = {}): DeliveryPackage {
    const fingerprint = JSON.stringify({ cmd: 'pkg-submit', packageId, approver });
    return this.withIdempotency(opts, fingerprint, () => {
      const pkg = this.requirePackage(packageId);
      if (pkg.status === 'submitted') return pkg;
      const findings = this.computePrecheck(pkg);
      const blocks = findings.filter(f => f.level === 'block');
      if (blocks.length) throw new LedgerError('PRECHECK_FAILED', `预检发现 ${blocks.length} 个阻断项，不能送审`, { packageId, findings });
      const approvalId = this.nextApprovalId();
      this.commit({ type: 'package_prechecked', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? pkg.owner, packageId });
      this.commit({ type: 'package_submitted', seq: this.nextSeq(), at: new Date().toISOString(), actor: opts.actor ?? pkg.owner, packageId, approvalId, approver });
      return this.getPackage(packageId);
    });
  }

  // ---- 查询 -----------------------------------------------------------------

  private requireNode(nodeId: string): AssetNode { const n = this.nodes.get(nodeId); if (!n) throw new LedgerError('NOT_FOUND', `资产版本不存在：${nodeId}`); return n; }
  private requirePackage(packageId: string): DeliveryPackage { const p = this.packages.get(packageId); if (!p) throw new LedgerError('NOT_FOUND', `交付包不存在：${packageId}`); return p; }

  getNode(nodeId: string): AssetNode { return structuredClone(this.requireNode(nodeId)); }
  getPackage(packageId: string): DeliveryPackage { return structuredClone(this.requirePackage(packageId)); }
  getApproval(approvalId: string): ApprovalRecord | undefined { const a = this.approvals.get(approvalId); return a ? structuredClone(a) : undefined; }

  /** v8 从哪一版来：沿 parentId 回溯 */
  ancestors(nodeId: string): AssetNode[] {
    const chain: AssetNode[] = [];
    let current = this.nodes.get(nodeId);
    const guard = new Set<string>();
    while (current && !guard.has(current.nodeId)) {
      guard.add(current.nodeId);
      chain.push(current);
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
    return chain.map(n => structuredClone(n));
  }

  lineage(projectId: string): { revision: number; series: AssetSeries[] } {
    const refsIndex = this.referenceIndex();
    const list = [...this.series.values()].filter(s => s.projectId === projectId).map<AssetSeries>(s => {
      const nodes: AssetNode[] = s.nodeIds.map(id => {
        const n = this.nodes.get(id)!;
        return { ...structuredClone(n), referencedBy: refsIndex.get(n.nodeId) ?? [] };
      });
      return {
        seriesId: s.seriesId, projectId: s.projectId, name: s.name, type: s.type, owner: s.owner,
        revision: s.revision, currentVersion: nodes[nodes.length - 1].version, currentNodeId: nodes[nodes.length - 1].nodeId, nodes,
      };
    });
    return { revision: this.revision, series: list };
  }

  private findReferences(nodeId: string) {
    return [...this.packages.values()].filter(p => p.refs.some(r => r.nodeId === nodeId)).map(p => ({ packageId: p.id, packageName: p.name, status: p.status }));
  }
  private referenceIndex() {
    const index = new Map<string, { packageId: string; packageName: string; status: PackageStatus }[]>();
    for (const p of this.packages.values()) for (const r of p.refs) {
      const arr = index.get(r.nodeId) ?? [];
      arr.push({ packageId: p.id, packageName: p.name, status: p.status });
      index.set(r.nodeId, arr);
    }
    return index;
  }

  packagesForProject(projectId: string): DeliveryPackage[] {
    return [...this.packages.values()].filter(p => p.projectId === projectId).map(p => structuredClone(p));
  }

  approvalsForProject(projectId: string): ApprovalRecord[] {
    return [...this.approvals.values()].filter(a => a.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(a => structuredClone(a));
  }

  /** 版权冲突：比较的是具体版本；撤回/授权失效的版本不参与，同谱系互不比 */
  rightsConflicts(projectId: string): AssetConflict[] {
    const active = [...this.nodes.values()].filter(n => n.projectId === projectId && n.status !== 'withdrawn' && n.grantState === 'active');
    const out: AssetConflict[] = [];
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        if (active[i].seriesId === active[j].seriesId) continue;
        const c = this.pairConflict(active[i], active[j]);
        if (c) out.push(c);
      }
    }
    return out;
  }

  private pairConflict(a: AssetNode, b: AssetNode): AssetConflict | null {
    const sharedTags = a.grant.rightsTags.filter(t => b.grant.rightsTags.includes(t));
    if (sharedTags.length === 0) return null;
    if (!sameTerritory(a.grant, b.grant) || !overlap(a.grant, b.grant)) return null;
    const severity: Severity = a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning';
    return {
      severity,
      nodeA: a.nodeId, labelA: `${a.name} v${a.version}`,
      nodeB: b.nodeId, labelB: `${b.name} v${b.version}`,
      reason: `同一授权标签在重叠窗口内覆盖相同地域：${sharedTags.join('、')}`,
    };
  }

  /** 比较两个版本：checksum 是否真的变化 + 授权范围差异 + 谱系关系 */
  compare(nodeIdA: string, nodeIdB: string) {
    const a = this.requireNode(nodeIdA), b = this.requireNode(nodeIdB);
    const chainA = this.ancestors(nodeIdA).map(n => n.nodeId);
    const chainB = this.ancestors(nodeIdB).map(n => n.nodeId);
    let relationship: 'same' | 'lineal' | 'siblings' | 'unrelated' = 'unrelated';
    if (nodeIdA === nodeIdB) relationship = 'same';
    else if (chainA.includes(nodeIdB) || chainB.includes(nodeIdA)) relationship = 'lineal';
    else if (a.seriesId === b.seriesId) relationship = 'siblings';
    const diffList = (label: string, x: unknown, y: unknown) => ({ label, from: x, to: y, changed: JSON.stringify(x) !== JSON.stringify(y) });
    const fields = {
      checksum: diffList('checksum', a.checksum, b.checksum),
      territories: diffList('地域', a.grant.territories, b.grant.territories),
      platforms: diffList('平台', a.grant.platforms, b.grant.platforms),
      rightsTags: diffList('版权标签', a.grant.rightsTags, b.grant.rightsTags),
      availableFrom: diffList('授权开始', a.grant.availableFrom, b.grant.availableFrom),
      availableTo: diffList('授权截止', a.grant.availableTo, b.grant.availableTo),
    };
    return { a, b, relationship, checksumChanged: a.checksum !== b.checksum, changedFields: Object.values(fields).filter(f => f.changed).map(f => f.label), fields };
  }

  auditTrail(): AuditEvent[] {
    return this.events.map(e => ({ id: `AUD-${String(e.seq).padStart(3, '0')}`, seq: e.seq, action: auditAction(e.type), entity: auditEntity(e), entityId: auditEntityId(e), actor: e.actor, at: e.at, details: auditDetails(e) }));
  }
}

function auditEntity(e: LedgerEvent) {
  if (e.type === 'approval_decided') return e.entityType === 'delivery' ? 'delivery' : 'asset_version';
  if (e.type.startsWith('package')) return 'delivery';
  return 'asset_version';
}
function auditEntityId(e: LedgerEvent) {
  switch (e.type) {
    case 'review_submitted': case 'version_locked': case 'version_withdrawn': case 'grant_revoked': return e.nodeId;
    case 'approval_decided': return e.entityId;
    case 'version_registered': return e.nodeId;
    default: return e.packageId;
  }
}
function auditAction(type: LedgerEvent['type']) {
  return ({ version_registered: 'REGISTER', review_submitted: 'SUBMIT_REVIEW', approval_decided: 'DECIDE', version_locked: 'LOCK', version_withdrawn: 'WITHDRAW', grant_revoked: 'REVOKE_GRANT', package_created: 'PACKAGE_CREATE', package_ref_added: 'PACKAGE_REF_ADD', package_ref_removed: 'PACKAGE_REF_REMOVE', package_prechecked: 'PRECHECK', package_submitted: 'PACKAGE_SUBMIT' } as const)[type];
}
function auditDetails(e: LedgerEvent): string {
  switch (e.type) {
    case 'version_registered': return `登记 ${e.nodeId}（父版本 ${e.parentId ?? '无'}）：${e.changeNote}；checksum=${e.checksum}`;
    case 'review_submitted': return `${e.nodeId} 送审，审批单 ${e.approvalId}，审批人 ${e.approver}`;
    case 'approval_decided': return `${e.approvalId} ${e.decision === 'approved' ? '通过' : '驳回'}：${e.comment || '无批注'}`;
    case 'version_locked': return `${e.nodeId} 已锁定，历史不可变`;
    case 'version_withdrawn': return `${e.nodeId} 撤回：${e.reason}`;
    case 'grant_revoked': return `${e.nodeId} 授权撤销：${e.reason}（锁定记录保持不变）`;
    case 'package_created': return `创建交付包 ${e.packageId}：${e.name}`;
    case 'package_ref_added': return `${e.packageId} 加入引用 ${e.nodeId}`;
    case 'package_ref_removed': return `${e.packageId} 移除引用 ${e.nodeId}`;
    case 'package_prechecked': return `${e.packageId} 完成预检`;
    case 'package_submitted': return `${e.packageId} 送审，审批单 ${e.approvalId}`;
  }
}
