import express from 'express';
import {
  approve, budgetLines, contracts, createApproval, dashboard, projectSummary, projects,
  rightsConflicts, seedApprovals,
} from './domain.js';
import { auditEvents, approvals, getRevision, LedgerError } from './approval.js';
import {
  applyApprovalDecision, compareVersion, createDelivery, getLineage, getVersionDetail,
  listDeliveries, listLineages, precheckDelivery, registerVersion, seedLineage,
  submitForReview, updateScope, withdrawVersion, requestLock,
} from './lineage.js';

seedLineage();
seedApprovals();

const app = express();
app.use(express.json());

// 每个响应都携带账本修订号；控制台据此确认与服务端处于同一状态。
app.use((_req, res, next) => {
  res.setHeader('X-Ledger-Revision', String(getRevision()));
  next();
});

function handle(fn: (req: express.Request, res: express.Response) => unknown | Promise<unknown>) {
  return async (req: express.Request, res: express.Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof LedgerError) {
        res.status(error.status).json({ code: error.code, message: error.message, details: error.details });
        return;
      }
      console.error(error);
      res.status(500).json({ message: '服务内部错误' });
    }
  };
}

const paramId = (req: express.Request, key: string) => String(req.params[key]);

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform', revision: getRevision() }));
app.get('/api/ledger', (_req, res) => res.json({ revision: getRevision(), audit: auditEvents.length }));
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', handle((req, res) => {
  const result = projectSummary(paramId(req, 'id'));
  if (!result.project) throw new LedgerError('PROJECT_NOT_FOUND', 404, '项目不存在');
  res.json(result);
}));
app.get('/api/projects/:id/rights-conflicts', handle((req, res) => res.json(rightsConflicts(paramId(req, 'id')))));
app.get('/api/projects/:id/assets', handle((req, res) => {
  const projectId = paramId(req, 'id');
  if (!projects.some(p => p.id === projectId)) throw new LedgerError('PROJECT_NOT_FOUND', 404, '项目不存在');
  res.json(listLineages(projectId));
}));
app.get('/api/projects/:id/deliveries', handle((req, res) => res.json(listDeliveries(paramId(req, 'id')))));
app.get('/api/projects/:id/contracts', handle((req, res) => res.json(contracts.filter(contract => contract.projectId === paramId(req, 'id')))));
app.get('/api/budgets/:projectId/lines', handle((req, res) => res.json(budgetLines.filter(line => line.projectId === paramId(req, 'projectId')))));

// ---- 版本谱系 ----
app.get('/api/lineages/:id', handle((req, res) => res.json(getLineage(paramId(req, 'id')))));
app.get('/api/versions/:id', handle((req, res) => res.json(getVersionDetail(paramId(req, 'id')))));
app.get('/api/versions/:id/compare', handle((req, res) => res.json(compareVersion(paramId(req, 'id')))));
app.post('/api/lineages/:id/versions', handle(async (req, res) => {
  const key = req.header('Idempotency-Key') ?? (req.body.idempotencyKey as string | undefined);
  const result = await registerVersion({
    ...req.body,
    lineageId: paramId(req, 'id'),
    idempotencyKey: key,
  });
  res.status(result.idempotentReplay ? 200 : 201).json(result);
}));
app.post('/api/versions/:id/submit', handle((req, res) => {
  res.status(201).json(submitForReview(paramId(req, 'id'), req.body.actor ?? '当前用户', req.body.approver ?? '总制片人', req.body.comment));
}));
app.post('/api/versions/:id/lock', handle((req, res) => {
  res.status(201).json(requestLock(paramId(req, 'id'), req.body.actor ?? '当前用户', req.body.approver ?? '总制片人', req.body.comment));
}));
app.post('/api/versions/:id/withdraw', handle((req, res) => {
  res.json(withdrawVersion(paramId(req, 'id'), req.body.actor ?? '当前用户', req.body.reason ?? '控制台撤回'));
}));
app.patch('/api/versions/:id/scope', handle((req, res) => {
  res.json(updateScope(paramId(req, 'id'), req.body.actor ?? '当前用户', req.body.scope ?? req.body));
}));

// ---- 交付包 ----
app.post('/api/projects/:id/deliveries', handle((req, res) => {
  res.status(201).json(createDelivery({
    projectId: paramId(req, 'id'),
    title: req.body.title,
    refs: req.body.refs ?? [],
    createdBy: req.body.createdBy ?? '当前用户',
  }));
}));
app.post('/api/deliveries/:id/precheck', handle((req, res) => {
  res.json(precheckDelivery(paramId(req, 'id'), req.body.actor ?? '当前用户'));
}));

// ---- 审批 ----
app.get('/api/approvals', (_req, res) => res.json(approvals));
app.get('/api/audit', (req, res) => {
  const entity = typeof req.query.entity === 'string' ? req.query.entity : undefined;
  const entityId = typeof req.query.entityId === 'string' ? req.query.entityId : undefined;
  let list = auditEvents;
  if (entity) list = list.filter(e => e.entity === entity);
  if (entityId) list = list.filter(e => e.entityId === entityId);
  res.json(list);
});
app.post('/api/approvals', handle((req, res) => {
  res.status(201).json(createApproval(req.body));
}));
app.patch('/api/approvals/:id', handle((req, res) => {
  const { status, comment, actor } = req.body;
  const approval = approvals.find(item => item.id === paramId(req, 'id'));
  if (!approval) throw new LedgerError('APPROVAL_NOT_FOUND', 404, '审批不存在');
  // 资产版本审批有状态机副作用；预算等通用审批直接决议。
  const result = approval.entityType === 'assetVersion'
    ? applyApprovalDecision(paramId(req, 'id'), status, comment, actor)
    : { approval: approve(paramId(req, 'id'), status, comment) };
  res.json(result);
}));

const port = Number(process.env.PORT || 4104);
app.listen(port, () => console.log(`film rights API listening on ${port}`));
