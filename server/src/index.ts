import express from 'express';
import { approve, createBudgetApproval, dashboard, ledger, projectSummary, projects, rightsConflicts } from './domain.js';
import { LedgerError, type CommandOptions, type Grant } from './ledger.js';

const app = express();
app.use(express.json());

// ---- 错误码 → HTTP 状态映射（服务端与控制台共享同一状态机） -------------------
const errorStatus: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  CHECKSUM_DUPLICATE: 409,
  VERSION_GAP: 409,
  VERSION_CONFLICT: 409,
  STATE_CONFLICT: 409,
  LOCKED: 423,
  PACKAGE_REFERENCED: 409,
  PACKAGE_NOT_EDITABLE: 409,
  GRANT_LAPSED: 422,
  PRECHECK_FAILED: 422,
  IDEMPOTENCY_CONFLICT: 409,
};

function fail(res: express.Response, err: unknown) {
  if (err instanceof LedgerError) {
    return res.status(errorStatus[err.code] ?? 400).json({ message: err.message, code: err.code, details: err.details });
  }
  console.error(err);
  return res.status(500).json({ message: '服务端内部错误' });
}

function options(req: express.Request): CommandOptions {
  return {
    actor: String(req.header('X-Actor') ?? req.body?.actor ?? '当前用户'),
    idempotencyKey: req.header('Idempotency-Key') ?? req.body?.idempotencyKey,
    expectedRevision: req.body?.expectedRevision !== undefined ? Number(req.body.expectedRevision) : undefined,
  };
}

// ---- 既有概览接口 -----------------------------------------------------------
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', (req, res) => {
  const result = projectSummary(req.params.id);
  if (!result.project) return res.status(404).json({ message: '项目不存在' });
  res.json({ ...result, ledgerRevision: ledger.revision });
});
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));

// ---- 版本谱系 ----------------------------------------------------------------

app.get('/api/state', (_req, res) => res.json({ revision: ledger.revision }));
app.get('/api/state/events', (_req, res) => res.json(ledger.auditTrail()));

app.get('/api/projects/:id/lineage', (req, res) => {
  try { res.json(ledger.lineage(req.params.id)); } catch (err) { fail(res, err); }
});

app.post('/api/series/:seriesId/register', (req, res) => {
  try {
    const node = ledger.registerVersion({
      seriesId: req.params.seriesId,
      projectId: req.body.projectId,
      name: req.body.name,
      type: req.body.type,
      owner: req.body.owner,
      version: req.body.version,
      parentId: req.body.parentId,
      checksum: req.body.checksum,
      changeNote: req.body.changeNote,
      grant: req.body.grant as Grant,
    }, options(req));
    res.status(201).json({ node, revision: ledger.revision });
  } catch (err) { fail(res, err); }
});

app.get('/api/nodes/:nodeId', (req, res) => {
  try { res.json({ node: ledger.getNode(req.params.nodeId), ancestors: ledger.ancestors(req.params.nodeId) }); }
  catch (err) { fail(res, err); }
});

app.get('/api/nodes/:nodeId/compare/:otherId', (req, res) => {
  try { res.json(ledger.compare(req.params.nodeId, req.params.otherId)); }
  catch (err) { fail(res, err); }
});

app.post('/api/nodes/:nodeId/submit', (req, res) => {
  try { res.status(201).json(ledger.submitForReview(req.params.nodeId, String(req.body.approver ?? '总制片人'), options(req))); }
  catch (err) { fail(res, err); }
});

app.post('/api/nodes/:nodeId/lock', (req, res) => {
  try { res.json({ node: ledger.lockVersion(req.params.nodeId, options(req)), revision: ledger.revision }); }
  catch (err) { fail(res, err); }
});

app.post('/api/nodes/:nodeId/withdraw', (req, res) => {
  try { res.json({ node: ledger.withdrawVersion(req.params.nodeId, String(req.body.reason ?? ''), options(req)), revision: ledger.revision }); }
  catch (err) { fail(res, err); }
});

app.post('/api/nodes/:nodeId/revoke-grant', (req, res) => {
  try { res.json({ node: ledger.revokeGrant(req.params.nodeId, String(req.body.reason ?? ''), options(req)), revision: ledger.revision }); }
  catch (err) { fail(res, err); }
});

// ---- 交付包 ------------------------------------------------------------------

app.get('/api/projects/:id/packages', (req, res) => res.json(ledger.packagesForProject(req.params.id)));
app.post('/api/projects/:id/packages', (req, res) => {
  try { res.status(201).json(ledger.createPackage(req.params.id, String(req.body.name ?? ''), options(req))); }
  catch (err) { fail(res, err); }
});
app.post('/api/packages/:packageId/refs', (req, res) => {
  try { res.status(201).json(ledger.addPackageRef(req.params.packageId, String(req.body.nodeId ?? ''), options(req))); }
  catch (err) { fail(res, err); }
});
app.delete('/api/packages/:packageId/refs/:nodeId', (req, res) => {
  try { res.json(ledger.removePackageRef(req.params.packageId, req.params.nodeId, options(req))); }
  catch (err) { fail(res, err); }
});
app.post('/api/packages/:packageId/precheck', (req, res) => {
  try { res.json(ledger.precheckPackage(req.params.packageId, options(req))); }
  catch (err) { fail(res, err); }
});
app.post('/api/packages/:packageId/submit', (req, res) => {
  try { res.json(ledger.submitPackage(req.params.packageId, String(req.body.approver ?? '法务负责人'), options(req))); }
  catch (err) { fail(res, err); }
});
app.get('/api/packages/:packageId', (req, res) => {
  try { res.json(ledger.getPackage(req.params.packageId)); }
  catch (err) { fail(res, err); }
});

// ---- 审批（预算 / 资产版本 / 交付包统一入口） ---------------------------------

app.get('/api/projects/:id/approvals', (req, res) => {
  try {
    const summary = projectSummary(req.params.id);
    if (!summary.project) return res.status(404).json({ message: '项目不存在' });
    res.json(summary.approvals);
  } catch (err) { fail(res, err); }
});
app.post('/api/approvals', (req, res) => res.status(201).json(createBudgetApproval(req.body)));
app.patch('/api/approvals/:id', (req, res) => {
  try {
    const result = approve(req.params.id, req.body.status, req.body.comment);
    res.json(result);
  } catch (err) { fail(res, err); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform', revision: ledger.revision }));

const port = Number(process.env.PORT || 4104);
app.listen(port, () => console.log(`film rights API listening on ${port}`));
