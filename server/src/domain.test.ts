import test from 'node:test';
import assert from 'node:assert/strict';
import { approvals, auditEvents, getRevision } from './approval.js';
import {
  compareVersion, createLineage, getLineage, getVersionDetail, hashOf, precheckDelivery,
  registerVersion, seedLineage, submitForReview, withdrawVersion, updateScope,
  applyApprovalDecision, createDelivery, requestLock, rightsConflicts,
} from './lineage.js';
import { seedApprovals } from './domain.js';

seedLineage();
seedApprovals();

const scope = (overrides = {}) => ({
  territories: ['CN', 'HK', 'SG'],
  platforms: ['影院', 'StreamBox'],
  availableFrom: '2026-10-01',
  availableTo: '2028-10-01',
  rightsTags: ['音乐-同步许可', '演员-全媒介'],
  ...overrides,
});

async function registerNext(lineageId: string, seed: string, note: string, overrides = {}) {
  const head = getLineage(lineageId).head!;
  return registerVersion({
    projectId: 'PRJ-001',
    lineageId,
    name: head.name,
    type: head.type,
    owner: head.owner,
    checksum: hashOf(`${seed}-${head.version}`),
    parentVersionId: head.id,
    expectedHeadVersion: head.version,
    changeNote: note,
    createdBy: '后期制片',
    ...scope(),
    ...overrides,
  });
}

test('登记新版本：父子链、自动连号、变更说明与 checksum 比对', async () => {
  const before = getLineage('AST-001');
  const result = await registerNext('AST-001', 'scenario-v8-content', '场景验证：重新压制并修正字幕时间轴');
  assert.equal(result.version.version, before.head!.version + 1, '版本号必须链头 +1');
  assert.equal(result.version.parentVersionId, before.head!.id, 'v8 必须能回答从哪一版来');

  const comparison = compareVersion(result.version.id);
  assert.equal(comparison.checksumChanged, true, '不同 checksum 表示文件真的变了');
  assert.equal(comparison.parent?.id, before.head!.id);
});

test('重复 checksum：同谱系拒绝登记，文件未变不能产生新版本', async () => {
  const head = getLineage('AST-001').head!;
  await assert.rejects(
    registerVersion({
      projectId: 'PRJ-001', lineageId: 'AST-001', name: head.name, type: 'master', owner: '后期制片',
      checksum: head.checksum, parentVersionId: head.id, expectedHeadVersion: head.version,
      changeNote: '内容其实没变', createdBy: '后期制片', ...scope(),
    }),
    error => (error as { code?: string }).code === 'CHECKSUM_DUPLICATE',
  );
});

test('跳号：版本号由服务端连号分配，输入无法指定版本号产生空缺', async () => {
  // 全新谱系：连续登记两次，版本只能是 1、2，无空号。
  const lineage = createLineage({ projectId: 'PRJ-001', name: '跳号验证资产', type: 'subtitle', owner: 'QA' });
  const first = await registerVersion({
    projectId: 'PRJ-001', lineageId: lineage.id, name: lineage.name, type: 'subtitle', owner: 'QA',
    checksum: hashOf('gap-lineage-v1'), parentVersionId: null, changeNote: '首版', createdBy: 'QA',
    ...scope({ rightsTags: [] }),
  });
  const second = await registerVersion({
    projectId: 'PRJ-001', lineageId: lineage.id, name: lineage.name, type: 'subtitle', owner: 'QA',
    checksum: hashOf('gap-lineage-v2'), parentVersionId: first.version.id, expectedHeadVersion: 1,
    changeNote: '第二版', createdBy: 'QA', ...scope({ rightsTags: [] }),
  });
  assert.equal(first.version.version, 1);
  assert.equal(second.version.version, 2);
  // 种子谱系同样无跳号（历史空缺已由占位版本补齐）。
  const chain = getLineage('AST-001').versions.map(v => v.version);
  for (let i = 0; i < chain.length; i += 1) assert.equal(chain[i], i + 1);
});

test('并发登记：同父版本的两个并发请求只有一个成功，另一个收到 409', async () => {
  const head = getLineage('AST-001').head!;
  const base = {
    projectId: 'PRJ-001' as const, lineageId: 'AST-001', name: head.name, type: 'master' as const, owner: '后期制片',
    parentVersionId: head.id, expectedHeadVersion: head.version, changeNote: '并发登记', createdBy: '后期制片',
    ...scope(),
  };
  const results = await Promise.allSettled([
    registerVersion({ ...base, checksum: hashOf('concurrent-a') }),
    registerVersion({ ...base, checksum: hashOf('concurrent-b') }),
  ]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'HEAD_CONFLICT');
});

test('重复请求：相同 Idempotency-Key 重放返回首个版本，不产生新版本', async () => {
  const head = getLineage('AST-001').head!;
  const key = `idem-${head.version}-${Date.now()}`;
  const payload = {
    projectId: 'PRJ-001' as const, lineageId: 'AST-001', name: head.name, type: 'master' as const, owner: '后期制片',
    checksum: hashOf(`idempotent-${key}`), parentVersionId: head.id, expectedHeadVersion: head.version,
    changeNote: '幂等登记', createdBy: '后期制片', idempotencyKey: key, ...scope(),
  };
  const first = await registerVersion(payload);
  const second = await registerVersion(payload);
  assert.equal(first.version.id, second.version.id);
  assert.equal(second.idempotentReplay, true);
  assert.equal(getLineage('AST-001').versions.filter(v => v.id === first.version.id).length, 1);
});

test('旧版已进预检：交付包钉住具体版本，撤回旧版必须被拒绝', () => {
  const detail = getVersionDetail('AST-001-V6');
  assert.ok(detail.referencedBy.some(p => p.id === 'DLV-007' && p.status === 'prechecked'), 'v6 仍被已预检交付包引用');

  const pkg = createDelivery({
    projectId: 'PRJ-001',
    title: '预检引用钉住测试包',
    refs: [{ versionId: 'AST-002-V4' }],
    createdBy: '发行部',
  });
  precheckDelivery(pkg.id, '发行部');
  assert.throws(
    () => withdrawVersion('AST-002-V4', '营销部', '想撤回旧预告'),
    error => (error as { code?: string }).code === 'VERSION_REFERENCED',
  );
  // 已预检的 DLV-007 引用 v6：撤回同样被拒绝。
  assert.throws(
    () => withdrawVersion('AST-001-V6', '后期制片', 'v8 已登记，想撤下 v6'),
    error => (error as { code?: string }).code === 'VERSION_REFERENCED',
  );
  // 被拒绝的撤回必须留痕。
  assert.ok(auditEvents.some(e => e.entityId === 'AST-001-V6' && e.action === 'VERSION_WITHDRAW_DENIED'));
});

test('锁定后授权失效：锁定版本改授权范围被拒，即使窗口将到期也只能登记新版本', () => {
  const locked = 'AST-003-V2'; // availableTo 在未来 52 天
  assert.equal(getVersionDetail(locked).version.status, 'locked');
  const before = getRevision();
  assert.throws(
    () => updateScope(locked, '音乐版权', { availableTo: '2030-01-01' }),
    error => (error as { code?: string }).code === 'VERSION_LOCKED',
  );
  assert.ok(getRevision() > before, '被拒绝的操作也要留痕（SCOPE_CHANGE_DENIED）');
  assert.ok(auditEvents.some(e => e.entityId === locked && e.denied === true));
  assert.throws(
    () => requestLock(locked, '音乐版权', '总制片人'),
    error => (error as { code?: string }).code === 'VERSION_LOCKED',
  );
});

test('送审 -> 审批通过 -> 请求锁定 -> 锁定通过；锁定历史只追加不可覆盖', async () => {
  const registered = await registerNext('AST-001', `lock-flow-${Date.now()}`, '锁定流程验证');
  const versionId = registered.version.id;
  submitForReview(versionId, '后期制片', '总制片人');
  const submitApproval = approvals.find(a => a.entityId === versionId && a.action === 'submit' && a.status === 'pending')!;
  applyApprovalDecision(submitApproval.id, 'approved', '同意进入批准');
  assert.equal(getVersionDetail(versionId).version.status, 'approved');

  requestLock(versionId, '后期制片', '总制片人');
  const lockApproval = approvals.find(a => a.entityId === versionId && a.action === 'lock' && a.status === 'pending')!;
  applyApprovalDecision(lockApproval.id, 'approved', '锁定母版');
  assert.equal(getVersionDetail(versionId).version.status, 'locked');

  // 审批不可重复决定，历史不能静默改写。
  assert.throws(
    () => applyApprovalDecision(lockApproval.id, 'rejected', '试图改判'),
    error => (error as { code?: string }).code === 'APPROVAL_ALREADY_DECIDED',
  );
  const lockAudits = auditEvents.filter(e => e.entityId === versionId && e.action === 'VERSION_LOCKED');
  assert.equal(lockAudits.length, 1, '锁定事件只能出现一次，不能被覆盖');

  // 授权范围比较：diff 精确到地域/平台/标签/窗口。
  const widened = await registerNext('AST-001', `scope-widen-${Date.now()}`, '扩窗：加入 TW 与 OTT 平台并延长窗口', {
    territories: ['CN', 'HK', 'SG', 'TW'],
    platforms: ['影院', 'StreamBox', 'OTT'],
    availableTo: '2030-10-01',
  });
  const diff = compareVersion(widened.version.id).scopeDiff!;
  assert.deepEqual(diff.addedTerritories, ['TW']);
  assert.deepEqual(diff.addedPlatforms, ['OTT']);
  assert.equal(diff.windowChanged, true);
});

test('冲突、资产与审批详情全部指向具体版本', () => {
  const conflicts = rightsConflicts('PRJ-001');
  const critical = conflicts.find(c => c.severity === 'critical');
  assert.ok(critical, '锁定音频与母版的音乐同步许可重叠应判 critical');
  assert.match(critical!.versionAId, /^AST-\d+-V\d+$/);
  assert.match(critical!.versionBId, /^AST-\d+-V\d+$/);
  assert.notEqual(critical!.versionAId, critical!.versionBId);

  const v7 = getVersionDetail('AST-001-V7');
  assert.ok(v7.approvals.some(a => a.entityId === 'AST-001-V7'), '审批详情必须挂在具体版本上');
  assert.equal(v7.comparison.parent?.id, 'AST-001-V6', 'v7 来源可追溯到 v6');
  assert.ok(v7.audit.length >= 1, '版本审计历史只追加');
});
