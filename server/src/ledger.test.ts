import test from 'node:test';
import assert from 'node:assert/strict';
import { VersionGenealogyLedger, LedgerError, type RegisterInput } from './ledger.js';
import { buildSeedEvents } from './seed.js';

function freshLedger() {
  const ledger = new VersionGenealogyLedger();
  ledger.loadSeedEvents(buildSeedEvents());
  return ledger;
}

const grant = (over: Partial<RegisterInput['grant']> = {}): RegisterInput['grant'] => ({
  territories: ['CN'], platforms: ['StreamBox'], availableFrom: '2026-09-01', availableTo: '2028-09-01', rightsTags: ['演员-全媒介'], ...over,
});

test('种子谱系：v7 的血缘链可回溯到 v1，v6 仍被已批准的 DEL-007 引用', () => {
  const ledger = freshLedger();
  const chain = ledger.ancestors('SER-001@7').map(n => n.nodeId);
  assert.deepEqual(chain, ['SER-001@7', 'SER-001@6', 'SER-001@5', 'SER-001@4', 'SER-001@3', 'SER-001@2', 'SER-001@1']);
  const v6 = ledger.getNode('SER-001@6');
  assert.equal(v6.status, 'locked'); // 锁定历史不可静默覆盖
  const pkg = ledger.getPackage('DEL-007');
  assert.equal(pkg.status, 'approved');
  assert.ok(pkg.refs.some(r => r.nodeId === 'SER-001@6'), '旧版 v6 仍被交付包引用');
});

test('重复 checksum：文件没有真的变化时拒绝登记为新版本', () => {
  const ledger = freshLedger();
  const v7 = ledger.getNode('SER-001@7');
  let err: unknown;
  assert.throws(() => ledger.registerVersion({
    seriesId: 'SER-001', checksum: v7.checksum, changeNote: '想把同一个文件再登记一次', grant: grant(v7.grant),
  }), (e: unknown) => { err = e; return e instanceof LedgerError; });
  assert.ok(err instanceof LedgerError);
  assert.equal(err.code, 'CHECKSUM_DUPLICATE');
  assert.equal((err.details as { existingNodeId: string }).existingNodeId, 'SER-001@7');
});

test('跳号：版本号必须连续，v9 不能跳过 v8', () => {
  const ledger = freshLedger();
  assert.throws(() => ledger.registerVersion({
    seriesId: 'SER-001', version: 9, checksum: 'sha256:deadbeef0001', changeNote: '跳号登记', grant: grant(),
  }), (e: unknown) => e instanceof LedgerError && e.code === 'VERSION_GAP');
  // 失败不写入事件，revision 不变
  assert.equal(ledger.getNode('SER-001@7').version, 7);
});

test('并发登记：expectedRevision 乐观锁让第二个登记失败而不是覆盖', () => {
  const a = freshLedger();
  const revisionBefore = a.lineage('PRJ-001').series.find(s => s.seriesId === 'SER-001')!.revision;
  // 后期 A 基于最新 revision 成功登记 v8
  const v8 = a.registerVersion(
    { seriesId: 'SER-001', checksum: 'sha256:v8content000000000000000001', changeNote: 'A：v8 调光微调', grant: grant() },
    { expectedRevision: revisionBefore, actor: '后期A' },
  );
  assert.equal(v8.nodeId, 'SER-001@8');
  // 后期 B 拿着同样的旧 revision 并发登记 → VERSION_CONFLICT，且不会产生重复 v8
  assert.throws(() => a.registerVersion(
    { seriesId: 'SER-001', checksum: 'sha256:v8content000000000000000002', changeNote: 'B：并发的另一个 v8', grant: grant() },
    { expectedRevision: revisionBefore, actor: '后期B' },
  ), (e: unknown) => e instanceof LedgerError && e.code === 'VERSION_CONFLICT');
  const series = a.lineage('PRJ-001').series.find(s => s.seriesId === 'SER-001')!;
  assert.equal(series.currentVersion, 8, '并发失败者没有写入版本');
});

test('旧版已进预检/交付：在途交付包引用的版本不能撤回；草稿包只告警', () => {
  const ledger = freshLedger();
  // DEL-007 已 approved 且引用 SER-001@6（locked）：撤回直接 LOCKED；先验证非锁定旧版的引用阻断
  // 用 v5（withdrawn 历史已存在）不合适——构造一个新场景：登记 v8 后把 v7 加进草稿/在途包
  const v8 = ledger.registerVersion({ seriesId: 'SER-001', checksum: 'sha256:newv8content00000000000003', changeNote: 'v8 用于引用阻断测试', grant: grant() });
  assert.equal(v8.status, 'draft');
  const draft = ledger.createPackage('PRJ-001', '草稿包');
  ledger.addPackageRef(draft.id, v8.nodeId);
  // 草稿包不阻断撤回，但信息里给出引用
  const withdrawn = ledger.withdrawVersion(v8.nodeId, '测试撤回');
  assert.equal(withdrawn.status, 'withdrawn');

  // 再造一个已送审包引用未锁定版本（SER-002@4 approved）：撤回被 PACKAGE_REFERENCED 阻止
  const submitted = ledger.createPackage('PRJ-001', '在途物料包');
  ledger.addPackageRef(submitted.id, 'SER-002@4');
  // 预检（SER-002@4 授权 active、无冲突）后送审
  const pre = ledger.precheckPackage(submitted.id);
  assert.equal(pre.passed, true);
  ledger.submitPackage(submitted.id, '法务负责人');
  assert.throws(() => ledger.withdrawVersion('SER-002@4', '想撤回平台已引用版本'), (e: unknown) => {
    if (!(e instanceof LedgerError)) return false;
    if (e.code !== 'PACKAGE_REFERENCED') return false;
    assert.deepEqual((e.details as { activeRefs: { packageId: string }[] }).activeRefs.map(r => r.packageId), [submitted.id]);
    return true;
  });
  // SER-002@4 状态不被改变
  assert.equal(ledger.getNode('SER-002@4').status, 'approved');
});

test('预检阻断：撤回版本 / 包内重复 checksum / 过期授权都会被检出', () => {
  const ledger = freshLedger();
  const pkg = ledger.createPackage('PRJ-001', '问题交付包');
  const node = ledger.registerVersion({
    seriesId: 'SER-006', projectId: 'PRJ-001', name: '测试物料', type: 'poster',
    checksum: 'sha256:poster0000000000000000000000000001', changeNote: 'v1',
    grant: grant({ rightsTags: ['演员-宣传许可'], availableTo: '2026-09-20' }),
  });
  ledger.addPackageRef(pkg.id, node.nodeId);
  ledger.withdrawVersion(node.nodeId, '测试用：撤回已入包版本');
  let result = ledger.precheckPackage(pkg.id);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some(f => f.code === 'VERSION_WITHDRAWN'));
  assert.throws(() => ledger.submitPackage(pkg.id, '法务负责人'), (err: unknown) => err instanceof LedgerError && err.code === 'PRECHECK_FAILED');

  // 重复 checksum 入包
  const pkg2 = ledger.createPackage('PRJ-001', '重复文件包');
  ledger.addPackageRef(pkg2.id, 'SER-001@7');
  const dup = ledger.registerVersion({ seriesId: 'SER-007', projectId: 'PRJ-001', name: '复制文件', type: 'poster', checksum: ledger.getNode('SER-001@7').checksum, changeNote: '直接复制母版文件', grant: grant({ rightsTags: ['演员-全媒介'] }) });
  ledger.addPackageRef(pkg2.id, dup.nodeId);
  const pre2 = ledger.precheckPackage(pkg2.id);
  assert.ok(pre2.findings.some(f => f.code === 'DUPLICATE_CHECKSUM'));
});

test('锁定后授权失效：锁定记录保持不变，授权可撤销，预检标记 GRANT_LAPSED_AFTER_LOCK 并阻断交付', () => {
  const ledger = freshLedger();
  // SER-003@2 是种子里锁定的版本
  const before = ledger.getNode('SER-003@2');
  assert.equal(before.status, 'locked');
  // 法务撤销同步许可：只追加 grant_revoked，锁定状态/文件/checksum 全部不变
  const revoked = ledger.revokeGrant('SER-003@2', '音乐同步许可提前终止');
  assert.equal(revoked.status, 'locked');
  assert.equal(revoked.grantState, 'revoked');
  assert.equal(revoked.checksum, before.checksum);
  assert.equal(revoked.lockedAt, before.lockedAt);
  // DEL-007 引用了 SER-003@2：重新预检必须阻断
  const pre = ledger.precheckPackage('DEL-007');
  const finding = pre.findings.find(f => f.nodeId === 'SER-003@2');
  assert.ok(finding);
  assert.equal(finding!.level, 'block');
  assert.equal(finding!.code, 'GRANT_LAPSED_AFTER_LOCK');
  assert.equal(pre.passed, false);
  // 版权冲突引擎：授权失效版本退出冲突集合
  assert.ok(!ledger.rightsConflicts('PRJ-001').some(c => c.nodeA === 'SER-003@2' || c.nodeB === 'SER-003@2'));
  // 锁定的版本仍不能撤回（历史不可静默覆盖）
  assert.throws(() => ledger.withdrawVersion('SER-003@2', '试试覆盖锁定'), (e: unknown) => e instanceof LedgerError && e.code === 'LOCKED');
});

test('锁定前授权失效：审批通过后授权被撤销，GRANT_LAPSED 拒绝锁定', () => {
  const ledger = freshLedger();
  const node = ledger.registerVersion({
    seriesId: 'SER-008', projectId: 'PRJ-001', name: '授权生变物料', type: 'poster',
    checksum: 'sha256:lapsed0000000000000000000000000001', changeNote: 'v1',
    grant: grant({ availableFrom: '2026-09-01', availableTo: '2028-12-31' }),
  });
  const approval = ledger.submitForReview(node.nodeId, '法务负责人');
  ledger.decideApproval(approval.id, 'approved', '同意');
  // 锁定前授权生变（被撤销）：锁定必须被拒绝
  ledger.revokeGrant(node.nodeId, '授权方提前终止');
  assert.throws(() => ledger.lockVersion(node.nodeId), (e: unknown) => e instanceof LedgerError && e.code === 'GRANT_LAPSED');
  assert.notEqual(ledger.getNode(node.nodeId).status, 'locked');
});

test('重复请求验证：相同 Idempotency-Key 返回首次结果且不重复登记；不同内容冲突报错', () => {
  const ledger = freshLedger();
  const input = { seriesId: 'SER-001', checksum: 'sha256:idempotentkey00000000000000001', changeNote: '网络重试的 v8', grant: grant() };
  const first = ledger.registerVersion(input, { idempotencyKey: 'REQ-88' });
  const again = ledger.registerVersion(input, { idempotencyKey: 'REQ-88' });
  assert.equal(again.nodeId, first.nodeId);
  assert.equal(ledger.lineage('PRJ-001').series.find(s => s.seriesId === 'SER-001')!.currentVersion, 8, '重试没有产生 v9');
  // 同一 key 换内容
  assert.throws(() => ledger.registerVersion({ ...input, changeNote: '换了变更说明' }, { idempotencyKey: 'REQ-88' }),
    (e: unknown) => e instanceof LedgerError && e.code === 'IDEMPOTENCY_CONFLICT');
});

test('送审→批准→锁定全链路与版本比较（checksum 与授权范围 diff）', () => {
  const ledger = freshLedger();
  const node = ledger.registerVersion({
    seriesId: 'SER-009', projectId: 'PRJ-001', name: '海报终稿', type: 'poster',
    checksum: 'sha256:posterfinal00000000000000000000002', changeNote: 'v1 终稿',
    grant: grant({ territories: ['CN', 'US'], rightsTags: ['演员-宣传许可'] }),
  });
  const approval = ledger.submitForReview(node.nodeId, '法务负责人');
  assert.equal(approval.status, 'pending');
  ledger.decideApproval(approval.id, 'approved', '同意');
  const locked = ledger.lockVersion(node.nodeId);
  assert.equal(locked.status, 'locked');
  const v2 = ledger.registerVersion({
    seriesId: 'SER-009', checksum: 'sha256:posterfinal00000000000000000000003',
    changeNote: 'v2 延长授权', grant: grant({ territories: ['CN', 'US', 'JP'], availableTo: '2029-09-01', rightsTags: ['演员-宣传许可'] }),
  });
  const diff = ledger.compare(node.nodeId, v2.nodeId);
  assert.equal(diff.checksumChanged, true);
  assert.deepEqual(diff.changedFields, ['checksum', '地域', '授权截止']);
  assert.equal(diff.relationship, 'lineal');
  // 审批不能重复决定
  assert.throws(() => ledger.decideApproval(approval.id, 'rejected', '反悔'), (e: unknown) => e instanceof LedgerError && e.code === 'STATE_CONFLICT');
});

test('事件日志只增：审计轨迹完整且按 seq 排列', () => {
  const ledger = freshLedger();
  const audit = ledger.auditTrail();
  for (let i = 1; i < audit.length; i += 1) assert.equal(audit[i].seq, i + 1);
  assert.ok(audit.some(e => e.action === 'LOCK' && e.entityId === 'SER-001@6'));
  assert.ok(audit.some(e => e.action === 'PRECHECK' && e.entityId === 'DEL-007'));
});
