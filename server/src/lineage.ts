// 资产版本谱系：不可变历史 + 内存查询模型。
//
// 设计权衡：
//  - 版本一旦登记即不可变（checksum、授权范围、changeNote 均不可原地改写）；
//    “变更”通过登记新版本实现，旧版本永远保留，可被交付包继续引用。
//  - 查询侧全部在内存里做（父子链、授权 diff、冲突、交付引用反查），
//    用 Map 索引换取 O(1) 命中；历史本身是 append-only 的数组。
//  - 写操作按 lineageId 串行化（mutex），并要求 expectedHeadVersion 做乐观并发：
//    两个基于同一父版本的并发登记只有一个能成功。
//  - 登记支持 Idempotency-Key：同一键重放直接返回首次结果，绝不产生第二个版本。
import {
  approvals,
  auditsFor,
  createApproval,
  decideApproval,
  getRevision,
  LedgerError,
  nextId,
  recordAudit,
  type Approval,
} from './approval.js';

export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type VersionStatus = 'draft' | 'review' | 'approved' | 'locked' | 'withdrawn';

export interface AuthScope {
  territories: string[];
  platforms: string[];
  availableFrom: string;
  availableTo: string;
  rightsTags: string[];
}

export interface AssetVersion extends AuthScope {
  id: string; // AST-001-V7：版本是一等实体，所有引用都指向它
  lineageId: string;
  projectId: string;
  name: string;
  type: AssetType;
  version: number;
  status: VersionStatus;
  owner: string;
  checksum: string;
  parentVersionId: string | null;
  changeNote: string;
  createdAt: string;
  createdBy: string;
}

export interface AssetLineage {
  id: string;
  projectId: string;
  name: string;
  type: AssetType;
  owner: string;
  createdAt: string;
}

export interface ScopeDiff {
  addedTerritories: string[];
  removedTerritories: string[];
  addedPlatforms: string[];
  removedPlatforms: string[];
  addedTags: string[];
  removedTags: string[];
  windowChanged: boolean;
  parentWindow: { availableFrom: string; availableTo: string };
  window: { availableFrom: string; availableTo: string };
}

export interface VersionComparison {
  version: AssetVersion;
  parent: AssetVersion | null;
  checksumChanged: boolean;
  scopeChanged: boolean;
  sameAs: { versionId: string; label: string }[];
  scopeDiff: ScopeDiff | null;
}

export type DeliveryStatus = 'draft' | 'prechecked' | 'released' | 'cancelled';

export interface DeliveryPackage {
  id: string;
  projectId: string;
  title: string;
  status: DeliveryStatus;
  /** 只能引用具体版本。 */
  refs: { lineageId: string; versionId: string; label: string }[];
  createdAt: string;
  precheck?: { at: string; actor: string; findings: string[] };
}

export interface RightsConflict {
  severity: 'critical' | 'warning';
  assetA: string;
  assetB: string;
  versionAId: string;
  versionBId: string;
  reason: string;
}

// ---------- 内存仓储（仅追加 + 派生索引） ----------

const lineages: AssetLineage[] = [];
const versions: AssetVersion[] = [];
const packages: DeliveryPackage[] = [];
const idempotency = new Map<string, { lineageId: string; versionId: string }>();
const lineageLocks = new Map<string, Promise<unknown>>();
const checksumIndex = new Map<string, string[]>(); // checksum -> version ids

const VERSION_ID = /^[A-Z]+-\d+-V(\d+)$/;

/** 确定性 checksum：演示数据与测试可以稳定复现，仍带 sha256: 前缀且为 64 位 hex。 */
export function hashOf(seed: string): string {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  for (let i = 0; i < seed.length; i += 1) {
    h0 = (h0 ^ seed.charCodeAt(i)) * 0x01000193 >>> 0;
    h1 = (h1 + (i + 1) * seed.charCodeAt(i)) * 0x85ebca6b >>> 0;
  }
  const part = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `sha256:${part(h0)}${part(h1 ^ h0)}`.padEnd(71, 'a').slice(0, 71);
}

// ---------- 谱系内部工具 ----------

export function createLineage(input: { projectId: string; name: string; type: AssetType; owner: string }): AssetLineage {
  const lineage: AssetLineage = {
    id: nextId('AST'),
    createdAt: new Date().toISOString(),
    ...input,
  };
  lineages.push(lineage);
  return lineage;
}

function lineageVersions(lineageId: string): AssetVersion[] {
  return versions.filter(v => v.lineageId === lineageId).sort((a, b) => a.version - b.version);
}

function findVersion(versionId: string): AssetVersion {
  const found = versions.find(v => v.id === versionId);
  if (!found) throw new LedgerError('VERSION_NOT_FOUND', 404, '版本不存在', { versionId });
  return found;
}

function addToChecksumIndex(checksum: string, versionId: string) {
  const list = checksumIndex.get(checksum) ?? [];
  list.push(versionId);
  checksumIndex.set(checksum, list);
}

function validateScope(scope: Partial<AuthScope>): AuthScope {
  const fields: (keyof AuthScope)[] = ['territories', 'platforms', 'rightsTags'];
  for (const field of fields) {
    if (!Array.isArray(scope[field])) {
      throw new LedgerError('INVALID_SCOPE', 400, `授权范围 ${field} 必须是数组`, { field });
    }
  }
  if (!scope.availableFrom || !scope.availableTo || scope.availableTo < scope.availableFrom) {
    throw new LedgerError('INVALID_SCOPE', 400, '授权窗口无效：availableTo 不能早于 availableFrom', {
      availableFrom: scope.availableFrom,
      availableTo: scope.availableTo,
    });
  }
  return {
    territories: [...(scope.territories as string[])],
    platforms: [...(scope.platforms as string[])],
    availableFrom: scope.availableFrom as string,
    availableTo: scope.availableTo as string,
    rightsTags: [...(scope.rightsTags as string[])],
  };
}

// ---------- 登记新版本（核心写路径） ----------

export interface RegisterVersionInput extends AuthScope {
  projectId: string;
  lineageId: string;
  name: string;
  type: AssetType;
  owner: string;
  checksum: string;
  parentVersionId?: string | null;
  changeNote: string;
  createdBy: string;
  /** 调用方认为当前链头版本号；并发登记冲突时返回 409。 */
  expectedHeadVersion?: number;
  idempotencyKey?: string;
}

export interface RegisterVersionResult {
  version: AssetVersion;
  lineage: AssetLineage;
  checksumDuplicate: boolean;
  idempotentReplay: boolean;
}

async function registerVersionInternal(input: RegisterVersionInput): Promise<RegisterVersionResult> {
  const lineage = lineages.find(item => item.id === input.lineageId);
  if (!lineage) throw new LedgerError('LINEAGE_NOT_FOUND', 404, '资产谱系不存在', { lineageId: input.lineageId });
  if (lineage.projectId !== input.projectId) {
    throw new LedgerError('PROJECT_MISMATCH', 400, '谱系不属于该项目', { lineageId: lineage.id, projectId: input.projectId });
  }

  const checksum = input.checksum?.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
    throw new LedgerError('INVALID_CHECKSUM', 400, 'checksum 必须是 sha256: 加 64 位十六进制', { checksum });
  }

  const scope = validateScope(input);
  if (!input.changeNote?.trim()) {
    throw new LedgerError('CHANGE_NOTE_REQUIRED', 400, '登记新版本必须填写变更说明（changeNote）');
  }

  const chain = lineageVersions(lineage.id);
  const head = chain[chain.length - 1] ?? null;

  if (input.parentVersionId) {
    const parent = versions.find(v => v.id === input.parentVersionId && v.lineageId === lineage.id);
    if (!parent) throw new LedgerError('PARENT_NOT_FOUND', 400, '父版本不在该谱系内', { parentVersionId: input.parentVersionId });
    // 乐观并发先于链头校验：两边都以为链头还是 V7 时，先提交者赢。
    if (input.expectedHeadVersion !== undefined && head && input.expectedHeadVersion !== head.version) {
      throw new LedgerError('HEAD_CONFLICT', 409, '并发登记冲突：链头版本已变化，请刷新后基于最新版本重试', {
        currentHead: head.version,
        expectedHead: input.expectedHeadVersion,
      });
    }
    if (head && parent.id !== head.id) {
      // 谱系是线性的：必须从当前链头生长，防止分叉与静默覆盖。
      throw new LedgerError('PARENT_NOT_HEAD', 409, '父版本不是当前链头，请基于最新版本登记', {
        headVersionId: head.id,
      });
    }
  } else if (chain.length > 0) {
    throw new LedgerError('PARENT_REQUIRED', 400, '该谱系已有版本，登记新版本必须声明父版本', { headVersionId: head?.id });
  }

  // 跳号保护：版本号由服务端按链头 +1 分配，调用方无法指定。
  const versionNumber = head ? head.version + 1 : 1;

  // 重复 checksum：同谱系内一律拒绝（文件没有真的变）；跨谱系只告警，允许登记。
  const sameChecksumHolders = checksumIndex.get(checksum) ?? [];
  const sameLineageDuplicate = sameChecksumHolders.some(id => findVersion(id).lineageId === lineage.id);
  if (sameLineageDuplicate) {
    throw new LedgerError('CHECKSUM_DUPLICATE', 422, 'checksum 与该谱系已有版本完全相同，文件未发生变化，拒绝登记新版本', {
      existingVersionIds: sameChecksumHolders,
    });
  }

  const version: AssetVersion = {
    ...scope,
    id: `${lineage.id}-V${versionNumber}`,
    lineageId: lineage.id,
    projectId: input.projectId,
    name: input.name,
    type: input.type,
    version: versionNumber,
    status: 'draft',
    owner: input.owner,
    checksum,
    parentVersionId: input.parentVersionId ?? null,
    changeNote: input.changeNote.trim(),
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  };
  versions.push(version);
  addToChecksumIndex(checksum, version.id);
  recordAudit({
    action: 'VERSION_REGISTERED',
    entity: 'assetVersion',
    entityId: version.id,
    actor: input.createdBy,
    details: `登记 ${version.name} v${versionNumber}（父版本 ${version.parentVersionId ?? '无'}）：${version.changeNote}`,
  });
  return {
    version,
    lineage,
    checksumDuplicate: sameChecksumHolders.length > 0,
    idempotentReplay: false,
  };
}

/**
 * 登记新版本。并发安全：
 *  - 同一谱系的写操作排队执行（mutex）；
 *  - Idempotency-Key 在加锁前、后各查一次，既拦截快速重放也拦截排队重放。
 */
export async function registerVersion(input: RegisterVersionInput): Promise<RegisterVersionResult> {
  const key = input.idempotencyKey?.trim();
  if (key) {
    const cached = idempotency.get(key);
    if (cached) return replayResult(cached, key);
  }
  const previous = lineageLocks.get(input.lineageId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      if (key) {
        const cached = idempotency.get(key);
        if (cached) return replayResult(cached, key);
      }
      const result = await registerVersionInternal(input);
      if (key) idempotency.set(key, { lineageId: input.lineageId, versionId: result.version.id });
      return result;
    });
  // 让锁链条不因本次失败而中断。
  lineageLocks.set(input.lineageId, run.catch(() => undefined));
  return run;
}

function replayResult(cached: { lineageId: string; versionId: string }, key: string): RegisterVersionResult {
  const version = findVersion(cached.versionId);
  const lineage = lineages.find(item => item.id === cached.lineageId)!;
  recordAudit({
    action: 'REGISTER_REPLAY',
    entity: 'assetVersion',
    entityId: version.id,
    actor: version.createdBy,
    details: `收到重复登记请求（Idempotency-Key=${key}），直接返回首次结果，未产生新版本`,
  });
  return { version, lineage, checksumDuplicate: false, idempotentReplay: true };
}

// ---------- 版本生命周期：送审 / 锁定 / 撤回 ----------

function transition(version: AssetVersion, to: VersionStatus, actor: string, action: string, details: string) {
  version.status = to;
  recordAudit({ action, entity: 'assetVersion', entityId: version.id, actor, details });
}

function pendingVersionApproval(versionId: string, action: 'submit' | 'lock'): Approval | undefined {
  return approvals.find(a => a.entityType === 'assetVersion' && a.entityId === versionId && a.action === action && a.status === 'pending');
}

/** 送审：draft/review/rejected 后重修可再次送审；locked 不允许。 */
export function submitForReview(versionId: string, actor: string, approver: string, comment = ''): Approval {
  const version = findVersion(versionId);
  if (version.status === 'locked') {
    throw new LedgerError('VERSION_LOCKED', 409, '版本已锁定，不能重复送审', { versionId });
  }
  if (version.status === 'withdrawn') {
    throw new LedgerError('VERSION_WITHDRAWN', 409, '版本已撤回，请登记新版本', { versionId });
  }
  if (pendingVersionApproval(versionId, 'submit')) {
    throw new LedgerError('REVIEW_PENDING', 409, '该版本已有待决的送审审批', { versionId });
  }
  transition(version, 'review', actor, 'VERSION_SUBMITTED', comment || `${version.name} v${version.version} 送审`);
  return createApproval({
    projectId: version.projectId,
    entityType: 'assetVersion',
    entityId: version.id,
    title: `${version.name} v${version.version} 送审`,
    requestedBy: actor,
    approver,
    action: 'submit',
  });
}

/** 请求锁定：只有 approved 的版本能进入锁定审批。 */
export function requestLock(versionId: string, actor: string, approver: string, comment = ''): Approval {
  const version = findVersion(versionId);
  if (version.status === 'locked') {
    throw new LedgerError('VERSION_LOCKED', 409, '版本已锁定，不能重复锁定（锁定历史不可覆盖）', { versionId });
  }
  if (version.status !== 'approved') {
    throw new LedgerError('NOT_APPROVED', 409, '只有审批通过的版本才能请求锁定', { versionId, status: version.status });
  }
  if (pendingVersionApproval(versionId, 'lock')) {
    throw new LedgerError('LOCK_PENDING', 409, '该版本已有待决的锁定审批', { versionId });
  }
  recordAudit({ action: 'LOCK_REQUESTED', entity: 'assetVersion', entityId: version.id, actor, details: comment || `请求锁定 ${version.name} v${version.version}` });
  return createApproval({
    projectId: version.projectId,
    entityType: 'assetVersion',
    entityId: version.id,
    title: `锁定 ${version.name} v${version.version}`,
    requestedBy: actor,
    approver,
    action: 'lock',
  });
}

/** 审批决议对版本状态的副作用。返回更新后的版本（若涉及版本）。 */
export function applyApprovalDecision(approvalId: string, status: 'approved' | 'rejected', comment = '', actor = '当前审批人') {
  const approval = decideApproval(approvalId, status, comment, actor);
  let version: AssetVersion | undefined;
  if (approval.entityType === 'assetVersion') {
    version = versions.find(v => v.id === approval.entityId);
    if (!version) throw new LedgerError('VERSION_NOT_FOUND', 404, '审批指向的版本不存在', { entityId: approval.entityId });
    if (status === 'approved') {
      if (approval.action === 'lock') {
        if (version.status !== 'approved') {
          throw new LedgerError('INVALID_TRANSITION', 409, '版本当前状态无法锁定', { status: version.status });
        }
        transition(version, 'locked', actor, 'VERSION_LOCKED', comment || `锁定 ${version.name} v${version.version}（此后不可变、授权不可改）`);
      } else {
        transition(version, 'approved', actor, 'VERSION_APPROVED', comment || `${version.name} v${version.version} 审批通过`);
      }
    } else if (approval.action === 'submit' && version.status === 'review') {
      transition(version, 'draft', actor, 'VERSION_RETURNED', comment || '送审被驳回，退回草稿');
    }
  }
  return { approval, version };
}

/** 活跃的交付引用：撤回/取消之外的包都算。 */
function activeReferences(versionId: string): DeliveryPackage[] {
  return packages.filter(p => p.status !== 'cancelled' && p.refs.some(ref => ref.versionId === versionId));
}

/**
 * 撤回版本。锁定版本不可撤回；只要还有交付包（含仅做过预检的包）引用，
 * 也不允许撤回——旧版可能已经进入交付预检。
 */
export function withdrawVersion(versionId: string, actor: string, reason: string): AssetVersion {
  const version = findVersion(versionId);
  if (version.status === 'locked') {
    recordAudit({ action: 'VERSION_WITHDRAW_DENIED', entity: 'assetVersion', entityId: version.id, actor, details: '锁定版本不可撤回', denied: true });
    throw new LedgerError('VERSION_LOCKED', 409, '锁定版本不可撤回', { versionId });
  }
  const referenced = activeReferences(versionId);
  if (referenced.length) {
    const labels = referenced.map(p => `${p.id}(${p.status})`).join('、');
    recordAudit({
      action: 'VERSION_WITHDRAW_DENIED',
      entity: 'assetVersion',
      entityId: version.id,
      actor,
      details: `撤回被拒绝：仍被交付包 ${labels} 引用（可能已进预检）`,
      denied: true,
    });
    throw new LedgerError('VERSION_REFERENCED', 409, '版本仍被交付包引用，不能撤回；请先更新交付包或撤回相关包', {
      versionId,
      packages: referenced.map(p => ({ id: p.id, status: p.status })),
    });
  }
  transition(version, 'withdrawn', actor, 'VERSION_WITHDRAWN', `撤回：${reason}`);
  return version;
}

/**
 * 修改授权范围。锁定版本的授权不可改——哪怕合同窗口已经失效，
 * 也只能登记新版本承接新窗口；调用时已过期会在错误中明示。
 */
export function updateScope(versionId: string, actor: string, scope: Partial<AuthScope>): AssetVersion {
  const version = findVersion(versionId);
  if (version.status === 'locked') {
    const today = new Date().toISOString().slice(0, 10);
    const expired = version.availableTo < today;
    recordAudit({
      action: 'SCOPE_CHANGE_DENIED',
      entity: 'assetVersion',
      entityId: version.id,
      actor,
      details: `锁定版本授权范围不可修改（当前授权窗口${expired ? `已于 ${version.availableTo} 失效` : '仍有效'}），请登记新版本`,
      denied: true,
    });
    throw new LedgerError('VERSION_LOCKED', 409, '锁定版本授权范围不可修改，请登记新版本承接新授权', {
      versionId,
      expired,
      availableTo: version.availableTo,
    });
  }
  const merged = validateScope({ ...version, ...scope });
  Object.assign(version, merged);
  recordAudit({ action: 'SCOPE_UPDATED', entity: 'assetVersion', entityId: version.id, actor, details: '授权范围已更新（版本内容未变）' });
  return version;
}

// ---------- 查询模型 ----------

export function listLineages(projectId: string) {
  return lineages
    .filter(lineage => lineage.projectId === projectId)
    .map(lineage => {
      const chain = lineageVersions(lineage.id);
      const head = chain[chain.length - 1] ?? null;
      return { lineage, head, depth: chain.length, versions: chain };
    });
}

export function getLineage(lineageId: string) {
  const lineage = lineages.find(item => item.id === lineageId);
  if (!lineage) throw new LedgerError('LINEAGE_NOT_FOUND', 404, '资产谱系不存在', { lineageId });
  const chain = lineageVersions(lineageId);
  return { lineage, head: chain[chain.length - 1] ?? null, versions: chain };
}

function scopeDiff(parent: AuthScope, current: AuthScope): ScopeDiff {
  const pick = (field: keyof AuthScope) => ({
    added: (current[field] as string[]).filter(x => !(parent[field] as string[]).includes(x)),
    removed: (parent[field] as string[]).filter(x => !(current[field] as string[]).includes(x)),
  });
  const territories = pick('territories');
  const platforms = pick('platforms');
  const tags = pick('rightsTags');
  return {
    addedTerritories: territories.added,
    removedTerritories: territories.removed,
    addedPlatforms: platforms.added,
    removedPlatforms: platforms.removed,
    addedTags: tags.added,
    removedTags: tags.removed,
    windowChanged: parent.availableFrom !== current.availableFrom || parent.availableTo !== current.availableTo,
    parentWindow: { availableFrom: parent.availableFrom, availableTo: parent.availableTo },
    window: { availableFrom: current.availableFrom, availableTo: current.availableTo },
  };
}

function isEmptyDiff(diff: ScopeDiff): boolean {
  return !diff.windowChanged &&
    [diff.addedTerritories, diff.removedTerritories, diff.addedPlatforms, diff.removedPlatforms, diff.addedTags, diff.removedTags]
      .every(list => list.length === 0);
}

/** 回答“v8 从哪来、文件是否真的变了、授权是否变了”。 */
export function compareVersion(versionId: string): VersionComparison {
  const version = findVersion(versionId);
  const parent = version.parentVersionId ? versions.find(v => v.id === version.parentVersionId) ?? null : null;
  const checksumChanged = parent ? parent.checksum !== version.checksum : true;
  const diff = parent ? scopeDiff(parent, version) : null;
  const sameAs = (checksumIndex.get(version.checksum) ?? [])
    .filter(id => id !== version.id)
    .map(id => {
      const other = findVersion(id);
      return { versionId: id, label: `${other.name} v${other.version}` };
    });
  return {
    version,
    parent,
    checksumChanged,
    scopeChanged: diff ? !isEmptyDiff(diff) : false,
    sameAs,
    scopeDiff: diff,
  };
}

export function getVersionDetail(versionId: string) {
  const version = findVersion(versionId);
  const lineage = lineages.find(item => item.id === version.lineageId)!;
  const children = versions.filter(v => v.parentVersionId === version.id);
  const referencedBy = packages
    .filter(p => p.refs.some(ref => ref.versionId === version.id))
    .map(p => ({ id: p.id, title: p.title, status: p.status }));
  const approvalsForVersion = approvals.filter(a => a.entityType === 'assetVersion' && a.entityId === version.id);
  return {
    lineage,
    version,
    comparison: compareVersion(versionId),
    children,
    referencedBy,
    approvals: approvalsForVersion,
    audit: auditsFor('assetVersion', versionId),
  };
}

/** 版权冲突：只比较参与交付的版本（draft/withdrawn 不对外，不参与）。冲突双方都指向具体版本。 */
export function rightsConflicts(projectId: string, atDate = new Date().toISOString().slice(0, 10)): RightsConflict[] {
  const active = versions.filter(
    v => v.projectId === projectId && ['review', 'approved', 'locked'].includes(v.status) && v.availableFrom <= atDate && v.availableTo >= atDate,
  );
  const conflicts: RightsConflict[] = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      // 同一谱系的新旧版本是承接关系，不算冲突。
      if (a.lineageId === b.lineageId) continue;
      const sharedTags = a.rightsTags.filter(tag => b.rightsTags.includes(tag));
      if (!sharedTags.length) continue;
      const sameTerritory =
        a.territories.includes('全球') || b.territories.includes('全球') || a.territories.some(t => b.territories.includes(t));
      const overlap = sameTerritory && a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom;
      if (!overlap) continue;
      conflicts.push({
        severity: a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning',
        assetA: `${a.name} v${a.version}`,
        assetB: `${b.name} v${b.version}`,
        versionAId: a.id,
        versionBId: b.id,
        reason: `同一授权标签在重叠窗口内覆盖相同地域：${sharedTags.join('、')}`,
      });
    }
  }
  return conflicts;
}

/** 项目下所有参与交付的版本（供旧版资产表/驾驶舱复用）。 */
export function projectAssets(projectId: string): AssetVersion[] {
  return versions
    .filter(v => v.projectId === projectId && v.status !== 'withdrawn')
    .sort((a, b) => b.version - a.version);
}

// ---------- 交付包：只能引用具体版本；预检会钉住旧版引用 ----------

export function createDelivery(input: { projectId: string; title: string; refs: { versionId: string }[]; createdBy: string }): DeliveryPackage {
  const refs = input.refs.map(ref => {
    const version = findVersion(ref.versionId);
    if (version.projectId !== input.projectId) {
      throw new LedgerError('PROJECT_MISMATCH', 400, '交付包引用了其他项目的版本', { versionId: ref.versionId });
    }
    if (version.status === 'withdrawn' || version.status === 'draft') {
      throw new LedgerError('VERSION_NOT_DELIVERABLE', 409, '只有送审中及之后状态的版本才能进入交付包', {
        versionId: ref.versionId,
        status: version.status,
      });
    }
    return { lineageId: version.lineageId, versionId: version.id, label: `${version.name} v${version.version}` };
  });
  if (!refs.length) throw new LedgerError('EMPTY_DELIVERY', 400, '交付包至少引用一个具体版本');
  const pkg: DeliveryPackage = {
    id: nextId('DLV'),
    projectId: input.projectId,
    title: input.title,
    status: 'draft',
    refs,
    createdAt: new Date().toISOString(),
  };
  packages.push(pkg);
  recordAudit({
    action: 'DELIVERY_CREATED',
    entity: 'delivery',
    entityId: pkg.id,
    actor: input.createdBy,
    details: `创建交付包 ${pkg.title}，引用 ${refs.map(r => r.versionId).join('、')}`,
  });
  return pkg;
}

/**
 * 预检：校验每个引用版本的状态/授权窗口/冲突。预检完成后引用被钉住——
 * 之后登记新版本不改变包内引用，旧版也因此不能被静默撤回。
 */
export function precheckDelivery(packageId: string, actor: string): DeliveryPackage {
  const pkg = packages.find(item => item.id === packageId);
  if (!pkg) throw new LedgerError('DELIVERY_NOT_FOUND', 404, '交付包不存在', { packageId });
  if (pkg.status === 'released') throw new LedgerError('DELIVERY_RELEASED', 409, '已发布交付包不能重新预检', { packageId });
  const today = new Date().toISOString().slice(0, 10);
  const findings: string[] = [];
  const conflictPairs = new Set(rightsConflicts(pkg.projectId, today).map(c => [c.versionAId, c.versionBId].sort().join('|')));
  for (const ref of pkg.refs) {
    const version = findVersion(ref.versionId);
    if (version.status === 'withdrawn') findings.push(`[严重] ${version.id} 已撤回，不能交付`);
    if (version.availableTo < today) findings.push(`[严重] ${version.id} 授权窗口已于 ${version.availableTo} 失效`);
    else if (version.availableTo <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)) {
      findings.push(`[警告] ${version.id} 授权将于 ${version.availableTo} 到期（30 天内）`);
    }
    for (const other of pkg.refs) {
      if (other.versionId === ref.versionId) continue;
      const key = [ref.versionId, other.versionId].sort().join('|');
      if (conflictPairs.has(key)) findings.push(`[冲突] ${ref.versionId} 与 ${other.versionId} 存在授权窗口冲突`);
    }
  }
  if (!findings.length) findings.push('全部引用版本状态、授权窗口与标签校验通过；引用版本已钉住');
  pkg.status = 'prechecked';
  pkg.precheck = { at: new Date().toISOString(), actor, findings };
  recordAudit({
    action: 'DELIVERY_PRECHECKED',
    entity: 'delivery',
    entityId: pkg.id,
    actor,
    details: `预检完成，${findings.length} 条结论：${findings.join('；')}`,
  });
  return pkg;
}

export function listDeliveries(projectId: string): DeliveryPackage[] {
  return packages.filter(p => p.projectId === projectId);
}

// ---------- 服务端状态快照：控制台与服务端必须一致 ----------

export function ledgerState() {
  return {
    revision: getRevision(),
    lineageCount: lineages.length,
    versionCount: versions.length,
    deliveryCount: packages.length,
    pendingApprovals: approvals.filter(a => a.status === 'pending').length,
  };
}

// ---------- 种子数据（仅追加方式构建，走与线上一致的写路径语义） ----------

export function seedLineage(): void {
  if (lineages.length) return;
  const now = Date.now();
  const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);

  const bootstrap = (args: {
    lineageId: string;
    projectId: string;
    name: string;
    type: AssetType;
    owner: string;
    versions: { v: number; status: VersionStatus; checksumSeed: string; changeNote: string; createdBy: string; scope: AuthScope; createdAtOffsetDays: number }[];
  }) => {
    const lineage: AssetLineage = { id: args.lineageId, projectId: args.projectId, name: args.name, type: args.type, owner: args.owner, createdAt: new Date(now - 120 * 86400000).toISOString() };
    lineages.push(lineage);
    let parent: AssetVersion | null = null;
    let expected = 1;
    for (const spec of args.versions) {
      // 历史数据中可能只登记了关键版本；谱系模型要求链连续，自动以 withdrawn 占位补齐跳号。
      while (expected < spec.v) {
        const placeholder: AssetVersion = {
          id: `${args.lineageId}-V${expected}`,
          lineageId: args.lineageId,
          projectId: args.projectId,
          name: args.name,
          type: args.type,
          version: expected,
          status: 'withdrawn',
          owner: args.owner,
          checksum: hashOf(`${args.lineageId}-placeholder-v${expected}`),
          parentVersionId: parent ? parent.id : null,
          changeNote: `历史版本 v${expected}（早期迭代，已被后续版本取代）`,
          createdAt: new Date(now + spec.createdAtOffsetDays * 86400000 - (spec.v - expected) * 86400000).toISOString(),
          createdBy: spec.createdBy,
          ...spec.scope,
        };
        versions.push(placeholder);
        addToChecksumIndex(placeholder.checksum, placeholder.id);
        parent = placeholder;
        expected += 1;
      }
      const checksum = hashOf(spec.checksumSeed);
      const version: AssetVersion = {
        id: `${args.lineageId}-V${spec.v}`,
        lineageId: args.lineageId,
        projectId: args.projectId,
        name: args.name,
        type: args.type,
        version: spec.v,
        status: spec.status,
        owner: args.owner,
        checksum,
        parentVersionId: parent ? parent.id : null,
        changeNote: spec.changeNote,
        createdAt: new Date(now + spec.createdAtOffsetDays * 86400000).toISOString(),
        createdBy: spec.createdBy,
        ...spec.scope,
      };
      versions.push(version);
      addToChecksumIndex(checksum, version.id);
      parent = version;
      expected += 1;
    }
  };

  bootstrap({
    lineageId: 'AST-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', type: 'master', owner: '后期制片',
    versions: [
      { v: 1, status: 'withdrawn', checksumSeed: 'northstar-e01-master-v1', changeNote: '初剪母版，调色未完成', createdBy: 'DIT', createdAtOffsetDays: -95, scope: { territories: ['CN'], platforms: ['影院'], availableFrom: iso(-90), availableTo: iso(700), rightsTags: ['演员-全媒介'] } },
      { v: 6, status: 'approved', checksumSeed: 'northstar-e01-master-v6', changeNote: '终剪回归，修复 E01 声道错位', createdBy: '后期制片', createdAtOffsetDays: -12, scope: { territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-10), availableTo: iso(730), rightsTags: ['音乐-同步许可', '演员-全媒介'] } },
      { v: 7, status: 'review', checksumSeed: 'northstar-e01-master-v7', changeNote: 'HDR 元数据重写，峰值亮度按影院规范下调', createdBy: '后期制片', createdAtOffsetDays: -2, scope: { territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-2), availableTo: iso(730), rightsTags: ['音乐-同步许可', '演员-全媒介'] } },
    ],
  });
  bootstrap({
    lineageId: 'AST-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', type: 'trailer', owner: '营销部',
    versions: [
      { v: 3, status: 'withdrawn', checksumSeed: 'trailer-90s-v3', changeNote: '粗剪预告，字幕时间轴错位', createdBy: '营销部', createdAtOffsetDays: -30, scope: { territories: ['CN'], platforms: ['短视频'], availableFrom: iso(-25), availableTo: iso(120), rightsTags: ['演员-宣传许可'] } },
      { v: 4, status: 'approved', checksumSeed: 'trailer-90s-v4', changeNote: '替换第三幕镜头并补齐演员宣传授权', createdBy: '营销部', createdAtOffsetDays: -6, scope: { territories: ['CN'], platforms: ['StreamBox', '短视频'], availableFrom: iso(6), availableTo: iso(180), rightsTags: ['演员-宣传许可'] } },
    ],
  });
  bootstrap({
    lineageId: 'AST-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', type: 'audio', owner: '音乐版权',
    versions: [
      { v: 1, status: 'withdrawn', checksumSeed: 'winter-signal-v1', changeNote: '临时混音', createdBy: '音乐版权', createdAtOffsetDays: -60, scope: { territories: ['CN'], platforms: ['影院'], availableFrom: iso(-55), availableTo: iso(40), rightsTags: ['音乐-同步许可'] } },
      { v: 2, status: 'locked', checksumSeed: 'winter-signal-v2', changeNote: '终混锁定；北美同步许可窗口至 52 天后', createdBy: '音乐版权', createdAtOffsetDays: -40, scope: { territories: ['CN', 'US', 'CA'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-40), availableTo: iso(52), rightsTags: ['音乐-同步许可'] } },
    ],
  });
  bootstrap({
    lineageId: 'AST-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', type: 'master', owner: '视觉总监',
    versions: [
      { v: 2, status: 'withdrawn', checksumSeed: 'orbit-e02-v2', changeNote: '去闪烁前版本', createdBy: '视觉总监', createdAtOffsetDays: -40, scope: { territories: ['全球'], platforms: ['影院'], availableFrom: iso(-35), availableTo: iso(365), rightsTags: ['航拍-编辑许可'] } },
      { v: 3, status: 'review', checksumSeed: 'orbit-e02-v3', changeNote: '卫星素材去闪烁与色彩统一', createdBy: '视觉总监', createdAtOffsetDays: -3, scope: { territories: ['全球'], platforms: ['影院'], availableFrom: iso(18), availableTo: iso(365), rightsTags: ['航拍-编辑许可'] } },
    ],
  });
  bootstrap({
    lineageId: 'AST-005', projectId: 'PRJ-001', name: '北境回声 S01E01 简体中文字幕', type: 'subtitle', owner: '本地化',
    versions: [
      { v: 1, status: 'approved', checksumSeed: 'northstar-e01-zh-subs-v1', changeNote: '每日字幕产出：校对终稿（含唱词）', createdBy: '本地化', createdAtOffsetDays: -1, scope: { territories: ['CN', 'SG'], platforms: ['StreamBox'], availableFrom: iso(-1), availableTo: iso(730), rightsTags: [] } },
    ],
  });

  // 交付包：海外节展包仍引用旧母版 V6，并已完成预检 —— “旧版是否仍被交付包引用”必须可查。
  packages.push({
    id: 'DLV-007',
    projectId: 'PRJ-001',
    title: '海外节展交付包',
    status: 'prechecked',
    refs: [
      { lineageId: 'AST-001', versionId: 'AST-001-V6', label: '北境回声 S01E01 4K HDR Master v6' },
      { lineageId: 'AST-003', versionId: 'AST-003-V2', label: '片尾曲 / Winter Signal v2' },
    ],
    createdAt: new Date(now - 5 * 86400000).toISOString(),
    precheck: { at: new Date(now - 5 * 86400000).toISOString(), actor: '发行部', findings: ['预检时 V6 为最新通过版本；引用已钉住。音乐同步许可在 US/CA 与母版窗口重叠，需法务知悉。'] },
  });
  packages.push({
    id: 'DLV-008',
    projectId: 'PRJ-001',
    title: '平台上线物料包',
    status: 'draft',
    refs: [
      { lineageId: 'AST-002', versionId: 'AST-002-V4', label: '主预告 90s / Cut A v4' },
      { lineageId: 'AST-005', versionId: 'AST-005-V1', label: '北境回声 S01E01 简体中文字幕 v1' },
    ],
    createdAt: new Date(now - 1 * 86400000).toISOString(),
  });
}
