import { useCallback, useEffect, useMemo, useState } from 'react';

// ---- 类型（与服务端 ledger 对齐的最小集合） ----
type Project = { id: string; title: string; status: string; deliveryDate: string };
type NodeStatus = 'draft' | 'in_review' | 'approved' | 'rejected' | 'locked' | 'withdrawn';
type GrantState = 'active' | 'expired' | 'revoked' | 'pending';
type Grant = { territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[] };
type RefInfo = { packageId: string; packageName: string; status: string };
type AssetNode = {
  nodeId: string; seriesId: string; name: string; type: string; version: number; parentId: string | null;
  owner: string; checksum: string; changeNote: string; registeredBy: string; createdAt: string;
  status: NodeStatus; grant: Grant; grantState: GrantState; revokedReason?: string; lockedAt?: string;
  withdrawReason?: string; referencedBy?: RefInfo[];
};
type Series = { seriesId: string; name: string; type: string; owner: string; revision: number; currentVersion: number; currentNodeId: string; nodes: AssetNode[] };
type Lineage = { revision: number; series: Series[] };
type Summary = {
  planned: number; forecast: number; actual: number; variance: number; utilization: number; committed: number;
  contractExposure: number; assetCount: number; nodeCount: number; pendingApprovals: number;
  highRiskLines: { subcategory: string }[]; lines: { id: string; category: string; subcategory: string; planned: number; forecast: number; actual: number; risk: string }[];
  contracts: { vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; status: string }[] }[];
  assets: AssetNode[]; approvals: Approval[]; project: Project;
};
type Approval = { id: string; title: string; status: 'pending' | 'approved' | 'rejected' | 'withdrawn'; approver: string; entityType: string; entityId: string; comment?: string; requestedBy: string; createdAt: string };
type Conflict = { severity: 'critical' | 'warning'; nodeA: string; labelA: string; nodeB: string; labelB: string; reason: string };
type PkgRef = { nodeId: string; addedAt: string; addedBy: string };
type Pkg = { id: string; name: string; owner: string; status: 'draft' | 'submitted' | 'approved' | 'rejected'; refs: PkgRef[]; precheckAt?: string; approvalId?: string };
type Finding = { level: 'block' | 'warning'; code: string; nodeId?: string; message: string };
type CompareResult = { relationship: string; checksumChanged: boolean; changedFields: string[]; a: AssetNode; b: AssetNode; fields: Record<string, { label: string; from: unknown; to: unknown; changed: boolean }> };

const money = (n: number) => `¥${(n / 10000).toFixed(0)}万`;
const api = '/api';
const statusCN: Record<NodeStatus, string> = { draft: '草稿', in_review: '送审中', approved: '已批准', rejected: '已驳回', locked: '已锁定', withdrawn: '已撤回' };
const grantCN: Record<GrantState, string> = { active: '授权有效', expired: '授权过期', revoked: '授权撤销', pending: '未生效' };
const short = (cs: string) => cs.length > 22 ? `${cs.slice(0, 16)}…${cs.slice(-6)}` : cs;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(body.message || `请求失败 (${response.status})`) as Error & { code?: string; details?: unknown; status?: number };
    err.code = body.code; err.details = body.details; err.status = response.status;
    throw err;
  }
  return body as T;
}
const idemKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random()}`);
const post = <T,>(path: string, payload: unknown, method = 'POST') =>
  request<T>(path, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey(), 'X-Actor': '控制台值班' }, body: JSON.stringify(payload) });

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('PRJ-001');
  const [summary, setSummary] = useState<Summary>();
  const [lineage, setLineage] = useState<Lineage>({ revision: 0, series: [] });
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [tab, setTab] = useState<'overview' | 'budget' | 'lineage' | 'packages'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<{ node: AssetNode; ancestors: AssetNode[]; compare?: CompareResult }>();
  const [findings, setFindings] = useState<Record<string, Finding[]>>({});
  const [openSeries, setOpenSeries] = useState<string>('SER-001');
  const [newPkg, setNewPkg] = useState('');
  const [addRef, setAddRef] = useState<Record<string, string>>({});

  const load = useCallback(async (id = 'PRJ-001') => {
    setError('');
    try {
      const items = await request<Project[]>('/projects');
      const active = items.find(item => item.id === id) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      const [s, lin, pkgs, c] = await Promise.all([
        request<Summary>(`/projects/${active.id}/summary`),
        request<Lineage>(`/projects/${active.id}/lineage`),
        request<Pkg[]>(`/projects/${active.id}/packages`),
        request<Conflict[]>(`/projects/${active.id}/rights-conflicts`),
      ]);
      // 服务端与控制台同一状态：以台账 revision 为准，任何写操作后都重新拉取整份谱系
      setProjects(items); setSelected(active.id); setSummary(s); setLineage(lin); setPackages(pkgs); setConflicts(c);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接制作服务');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, AssetNode>();
    lineage.series.forEach(s => s.nodes.forEach(n => m.set(n.nodeId, n)));
    return m;
  }, [lineage]);

  const notify = (text: string, isError = false) => (isError ? setError : setMessage)(text);

  // ---- 版本动作 ----
  const act = async (path: string, payload: unknown, ok: string, method = 'POST') => {
    try { await post(path, payload, method); setMessage(`${ok}（台账 rev.${lineage.revision} → 已刷新）`); await load(selected); }
    catch (reason) {
      const e = reason as Error & { code?: string };
      setError(`${e.message}${e.code ? ` [${e.code}]` : ''}`);
      if (e.code === 'VERSION_CONFLICT') await load(selected); // 并发冲突后强制对齐服务端状态
    }
  };
  const submitNode = (n: AssetNode) => act(`/nodes/${n.nodeId}/submit`, { approver: '总制片人' }, `${n.nodeId} 已送审`);
  const lockNode = (n: AssetNode) => act(`/nodes/${n.nodeId}/lock`, {}, `${n.nodeId} 已锁定，历史不可变`);
  const revokeGrant = (n: AssetNode) => {
    const reason = window.prompt(`撤销 ${n.nodeId} 的授权原因（锁定记录会保留，但交付将被阻断）：`, '授权方提前终止协议');
    if (reason) void act(`/nodes/${n.nodeId}/revoke-grant`, { reason }, `${n.nodeId} 授权已撤销`);
  };
  const withdrawNode = (n: AssetNode) => {
    const reason = window.prompt(`撤回 ${n.nodeId} 的原因：`, '已被后续版本取代');
    if (reason) void act(`/nodes/${n.nodeId}/withdraw`, { reason }, `${n.nodeId} 已撤回`);
  };
  const decide = (approvalId: string, decision: 'approved' | 'rejected') => {
    const comment = window.prompt(decision === 'approved' ? '审批批注（可空）：' : '驳回原因：', decision === 'approved' ? '在控制台完成复核' : '');
    if (comment === null) return;
    void act(`/approvals/${approvalId}`, { status: decision, comment }, `审批 ${approvalId} 已${decision === 'approved' ? '通过' : '驳回'}`);
  };

  const openDetail = async (n: AssetNode) => {
    const data = await request<{ node: AssetNode; ancestors: AssetNode[] }>(`/nodes/${n.nodeId}`);
    let compare: CompareResult | undefined;
    if (n.parentId) compare = await request<CompareResult>(`/nodes/${n.nodeId}/compare/${n.parentId}`);
    setDetail({ ...data, compare });
  };

  // ---- 交付包动作 ----
  const runPrecheck = async (pkg: Pkg) => {
    try {
      const r = await post<{ findings: Finding[]; passed: boolean }>(`/packages/${pkg.id}/precheck`, {});
      setFindings(prev => ({ ...prev, [pkg.id]: r.findings }));
      setMessage(`${pkg.id} 预检${r.passed ? '通过' : `未通过（${r.findings.filter(f => f.level === 'block').length} 个阻断项）`}`);
      await load(selected);
    } catch (e) { setError((e as Error).message); }
  };
  const submitPkg = async (pkg: Pkg) => {
    try { await post(`/packages/${pkg.id}/submit`, { approver: '法务负责人' }); setMessage(`${pkg.id} 已送审`); await load(selected); }
    catch (reason) {
      const e = reason as Error & { code?: string; details?: { findings?: Finding[] } };
      setError(`${e.message}${e.code ? ` [${e.code}]` : ''}`);
      if (e.details?.findings) setFindings(prev => ({ ...prev, [pkg.id]: e.details!.findings! }));
    }
  };
  const createPkg = async () => { if (!newPkg.trim()) return; await post(`/projects/${selected}/packages`, { name: newPkg.trim() }); setNewPkg(''); setMessage('交付包已创建'); await load(selected); };
  const addPkgRef = async (pkg: Pkg) => {
    const nodeId = addRef[pkg.id]; if (!nodeId) return;
    try { await post(`/packages/${pkg.id}/refs`, { nodeId }); setMessage(`${nodeId} 已加入 ${pkg.id}`); await load(selected); }
    catch (e) { setError((e as Error).message); }
  };
  const removePkgRef = (pkg: Pkg, nodeId: string) => act(`/packages/${pkg.id}/refs/${nodeId}`, {}, `${nodeId} 已移出 ${pkg.id}`, 'DELETE');

  const variancePct = useMemo(() => summary ? Math.round(summary.variance / summary.planned * 100) : 0, [summary]);

  if (loading && !summary) return <main className="connection-state"><div className="loading">正在载入制作控制台…</div><small>正在连接版本谱系台账（只增事件日志 + 内存物化视图）</small></main>;
  if (!summary) return <main className="connection-state"><h2>无法连接制作服务</h2><p>{error || '服务端没有返回项目数据。'}</p><button onClick={() => void load(selected)}>重新连接</button></main>;

  return (
    <main>
      <header>
        <div>
          <div className="eyebrow">STUDIO OPS / VERSION GENEALOGY CONTROL</div>
          <h1>FrameLedger <span>资产版本谱系 · 授权与交付审计</span></h1>
          <p>每个母版、预告、字幕都是谱系中的不可变版本节点；冲突、审批与交付包全部指向具体版本（如 SER-001@7）。</p>
        </div>
        <div className="header-actions">
          <select value={selected} onChange={e => { setSelected(e.target.value); void load(e.target.value); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
          <span className="live" title="服务端台账事件序号；控制台每次操作后整体重拉对齐"><i /> LEDGER rev.{lineage.revision}</span>
        </div>
      </header>
      {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}
      {error && <div className="toast error-toast" onClick={() => setError('')}>{error} ×</div>}

      <section className="kpis">
        <div><small>FORECAST COST</small><b>{money(summary.forecast)}</b><span>预算偏差 <em className={summary.variance > 0 ? 'bad' : ''}>{variancePct}%</em></span></div>
        <div><small>VERSION NODES</small><b>{summary.nodeCount}<em> 版 / {summary.assetCount} 谱系</em></b><span>登记 checksum 与父子血缘</span></div>
        <div><small>LOCKED HISTORY</small><b>{lineage.series.reduce((n, s) => n + s.nodes.filter(x => x.status === 'locked').length, 0)}<em> 个锁定版本</em></b><span>只增事件，不可静默覆盖</span></div>
        <div><small>RISK QUEUE</small><b>{summary.pendingApprovals + conflicts.length}<em> 项</em></b><span>{conflicts.length} 条版权冲突 / {summary.pendingApprovals} 个审批</span></div>
      </section>

      <nav className="tabs">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>审批驾驶舱</button>
        <button className={tab === 'lineage' ? 'active' : ''} onClick={() => setTab('lineage')}>版本谱系</button>
        <button className={tab === 'packages' ? 'active' : ''} onClick={() => setTab('packages')}>交付包预检</button>
        <button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>预算与合同</button>
        <span>交付日 {summary.project.deliveryDate}</span>
      </nav>

      {tab === 'overview' && (
        <div className="grid">
          <section className="panel">
            <div className="panel-head"><h3>待审批队列</h3><span>{summary.approvals.filter(a => a.status === 'pending').length} PENDING</span></div>
            {summary.approvals.map(a => (
              <div className="approval" key={a.id}>
                <span className={`status ${a.status}`} />
                <div>
                  <b>{a.title}</b>
                  <small>{a.approver} · {a.id} · 对象 <code>{a.entityType}:{a.entityId}</code>{a.comment ? ` · ${a.comment}` : ''}</small>
                </div>
                {a.status === 'pending'
                  ? <span className="btn-row"><button onClick={() => decide(a.id, 'approved')}>通过</button><button className="ghost" onClick={() => decide(a.id, 'rejected')}>驳回</button></span>
                  : <em>{a.status === 'withdrawn' ? '随版本关闭' : '已完成'}</em>}
              </div>
            ))}
          </section>
          <section className="panel">
            <div className="panel-head"><h3>版权冲突（指向具体版本）</h3><span>{conflicts.length} detected</span></div>
            {conflicts.length ? conflicts.map((c, i) => (
              <div className="conflict" key={i}>
                <strong>{c.severity}</strong>
                <b>{c.labelA} ↔ {c.labelB}</b>
                <small><code>{c.nodeA}</code> / <code>{c.nodeB}</code><br />{c.reason}</small>
              </div>
            )) : <div className="empty">当前在效授权版本未发现窗口冲突。</div>}
          </section>
          <section className="panel wide">
            <div className="panel-head"><h3>仍在交付包中被引用的旧版本</h3><span>回答“旧版是否仍被引用”</span></div>
            <div className="table">
              <div className="tr th compact"><span>版本</span><span>状态</span><span>授权</span><span>被引用</span><span></span></div>
              {lineage.series.flatMap(s => s.nodes).filter(n => (n.referencedBy?.length ?? 0) > 0 && n.nodeId !== lineage.series.find(x => x.seriesId === n.seriesId)?.currentNodeId).map(n => (
                <div className="tr compact" key={n.nodeId}>
                  <span><b>{n.name} v{n.version}</b><small><code>{n.nodeId}</code> · {short(n.checksum)}</small></span>
                  <span><span className={`pill ${n.status}`}>{statusCN[n.status]}</span></span>
                  <span className={n.grantState !== 'active' ? 'bad' : ''}>{grantCN[n.grantState]}</span>
                  <span>{n.referencedBy!.map(r => `${r.packageName}(${r.packageId}/${r.status})`).join('、')}</span>
                  <span><button className="ghost" onClick={() => void openDetail(n)}>血缘</button></span>
                </div>
              ))}
              {lineage.series.flatMap(s => s.nodes).filter(n => (n.referencedBy?.length ?? 0) > 0 && n.nodeId !== lineage.series.find(x => x.seriesId === n.seriesId)?.currentNodeId).length === 0
                && <div className="empty">交付包引用的都是各谱系当前版本。</div>}
            </div>
          </section>
        </div>
      )}

      {tab === 'lineage' && (
        <div className="grid">
          {lineage.series.map(s => {
            const open = openSeries === s.seriesId;
            const current = s.nodes[s.nodes.length - 1];
            return (
              <section className={`panel wide series ${open ? 'open' : ''}`} key={s.seriesId}>
                <div className="panel-head clickable" onClick={() => setOpenSeries(open ? '' : s.seriesId)}>
                  <h3>{s.name} <small className="mono">{s.seriesId} · {s.type} · {s.owner} · revision {s.revision}</small></h3>
                  <span>{s.nodes.length} 版 · 当前 <code>{current.nodeId}</code> {open ? '▾' : '▸'}</span>
                </div>
                {open && (
                  <>
                    <div className="timeline">
                      {s.nodes.map(n => (
                        <div className={`vnode ${n.status}`} key={n.nodeId}>
                          <div className="vnode-head">
                            <b>v{n.version}</b>
                            <span className={`pill ${n.status}`}>{statusCN[n.status]}</span>
                            <span className={`granttag ${n.grantState}`}>{grantCN[n.grantState]}</span>
                            <code className="nodeid">{n.nodeId}</code>
                            <span className="spacer" />
                            <button className="ghost" onClick={() => void openDetail(n)}>血缘/diff</button>
                          </div>
                          <div className="vnode-body">
                            <small title={n.checksum}>checksum {short(n.checksum)}</small>
                            <small>父版本 <code>{n.parentId ?? '无（谱系起点）'}</code></small>
                            <small>登记 {n.createdAt.slice(0, 10)} · {n.registeredBy}</small>
                          </div>
                          <p className="change-note">“{n.changeNote}”</p>
                          <div className="grant-line">
                            {n.grant.territories.join('/')} · {n.grant.platforms.join('/')} · {n.grant.availableFrom} → {n.grant.availableTo} · {n.grant.rightsTags.join('、') || '无版权标签'}
                          </div>
                          {n.revokedReason && <div className="flag block">授权撤销：{n.revokedReason}{n.status === 'locked' ? '（版本仍锁定，记录不可变）' : ''}</div>}
                          {n.withdrawReason && <div className="flag warn">撤回原因：{n.withdrawReason}</div>}
                          {(n.referencedBy?.length ?? 0) > 0 && <div className="flag info">被交付包引用：{n.referencedBy!.map(r => `${r.packageId}(${r.status})`).join('、')}</div>}
                          <div className="vnode-actions">
                            {(n.status === 'draft' || n.status === 'rejected') && <button onClick={() => submitNode(n)}>送审</button>}
                            {n.status === 'approved' && <button onClick={() => lockNode(n)}>锁定</button>}
                            {n.status === 'in_review' && <em>等待 {summary.approvals.find(a => a.entityId === n.nodeId && a.status === 'pending')?.approver ?? '审批人'} 决定</em>}
                            {n.status !== 'locked' && n.status !== 'withdrawn' && <button className="ghost" onClick={() => withdrawNode(n)}>撤回版本</button>}
                            {n.status === 'locked' && <button className="danger" onClick={() => revokeGrant(n)}>撤销授权</button>}
                            {n.status === 'withdrawn' && <em>历史版本，保留审计</em>}
                          </div>
                        </div>
                      ))}
                    </div>
                    <RegisterForm series={s} onDone={async () => { setMessage(`新版本已登记到 ${s.seriesId}`); await load(selected); }} onFail={(e) => { setError(`${e.message} [${e.code ?? ''}]`); if (e.code === 'VERSION_CONFLICT') void load(selected); }} />
                  </>
                )}
              </section>
            );
          })}
        </div>
      )}

      {tab === 'packages' && (
        <div className="grid">
          {packages.map(pkg => (
            <section className="panel wide" key={pkg.id}>
              <div className="panel-head">
                <h3>{pkg.name} <small className="mono">{pkg.id} · {pkg.status}{pkg.precheckAt ? ` · 最近预检 ${pkg.precheckAt.slice(0, 10)}` : ''}</small></h3>
                <span className="btn-row">
                  <button className="ghost" onClick={() => void runPrecheck(pkg)}>预检</button>
                  {(pkg.status === 'draft' || pkg.status === 'rejected') && <button onClick={() => void submitPkg(pkg)}>送审</button>}
                </span>
              </div>
              <div className="table">
                {pkg.refs.map(r => {
                  const n = nodeMap.get(r.nodeId);
                  return (
                    <div className="tr compact" key={r.nodeId}>
                      <span><b>{n?.name ?? r.nodeId} v{n?.version ?? ''}</b><small><code>{r.nodeId}</code>{n ? ` · ${short(n.checksum)}` : ''}</small></span>
                      <span>{n ? <span className={`pill ${n.status}`}>{statusCN[n.status]}</span> : '—'}</span>
                      <span className={n && n.grantState !== 'active' ? 'bad' : ''}>{n ? grantCN[n.grantState] : '—'}</span>
                      <span>{n ? `${n.grant.availableTo} 截止` : ''}</span>
                      <span>{(pkg.status === 'draft' || pkg.status === 'rejected') && <button className="ghost" onClick={() => void removePkgRef(pkg, r.nodeId)}>移除</button>}</span>
                    </div>
                  );
                })}
                {pkg.refs.length === 0 && <div className="empty">空交付包</div>}
              </div>
              {(pkg.status === 'draft' || pkg.status === 'rejected') && (
                <div className="ref-add">
                  <select value={addRef[pkg.id] ?? ''} onChange={e => setAddRef(prev => ({ ...prev, [pkg.id]: e.target.value }))}>
                    <option value="">选择具体版本加入…</option>
                    {lineage.series.flatMap(s => s.nodes).filter(n => n.status !== 'withdrawn' && !pkg.refs.some(r => r.nodeId === n.nodeId)).map(n =>
                      <option key={n.nodeId} value={n.nodeId}>{n.nodeId} · {statusCN[n.status]} · {grantCN[n.grantState]}</option>)}
                  </select>
                  <button onClick={() => void addPkgRef(pkg)}>加入引用</button>
                </div>
              )}
              {(findings[pkg.id]?.length ?? 0) > 0 && (
                <div className="findings">
                  {findings[pkg.id]!.map((f, i) => (
                    <div key={i} className={`finding ${f.level}`}><strong>{f.level === 'block' ? 'BLOCK' : 'WARN'} · {f.code}</strong> {f.nodeId ? <code>{f.nodeId}</code> : null} {f.message}</div>
                  ))}
                </div>
              )}
            </section>
          ))}
          <section className="panel wide">
            <div className="panel-head"><h3>新建交付包</h3></div>
            <div className="ref-add"><input value={newPkg} placeholder="例如：院线密钥包 KDM-Week1" onChange={e => setNewPkg(e.target.value)} /><button onClick={() => void createPkg()}>创建</button></div>
          </section>
        </div>
      )}

      {tab === 'budget' && (
        <div className="grid">
          <section className="panel wide">
            <div className="panel-head"><h3>预算版本 V3 / 成本基线</h3><span>实际 + 承诺 + 预测</span></div>
            <div className="table">
              <div className="tr"><span>科目</span><span>预算</span><span>已承诺</span><span>实际</span><span>预测</span><span>风险</span></div>
              {summary.lines.map(line => (
                <div className="tr" key={line.id}>
                  <span><b>{line.category}</b><small>{line.subcategory}</small></span>
                  <span>{money(line.planned)}</span><span>{money(line.planned)}</span><span>{money(line.actual)}</span>
                  <span className={line.forecast > line.planned ? 'bad' : ''}>{money(line.forecast)}</span>
                  <span className={`risk ${line.risk}`}>{line.risk}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h3>供应商付款里程碑</h3></div>
            {summary.contracts.map(c => (
              <div className="contract" key={c.vendor}><b>{c.vendor}</b><small>{c.scope}</small>
                <div className="contract-bar"><i style={{ width: `${Math.round(c.paid / c.committed * 100)}%` }} /></div>
                <span>{money(c.paid)} / {money(c.committed)}</span><em>{c.milestones.filter(m => m.status !== 'paid').length} 个待结点</em>
              </div>
            ))}
          </section>
        </div>
      )}

      {detail && <DetailDrawer data={detail} onClose={() => setDetail(undefined)} />}
      <footer>FrameLedger · 只增事件日志（事实源）+ 内存物化视图（查询）· 锁定历史不可静默覆盖 · 写操作携带 Idempotency-Key 与 expectedRevision</footer>
    </main>
  );
}

// ---- 新版本登记表：expectedRevision 乐观并发 --------------------------------
function RegisterForm({ series, onDone, onFail }: { series: Series; onDone: () => void; onFail: (e: Error & { code?: string }) => void }) {
  const parent = series.nodes[series.nodes.length - 1];
  const [form, setForm] = useState({
    checksum: '', changeNote: '',
    territories: parent.grant.territories.join(','), platforms: parent.grant.platforms.join(','), rightsTags: parent.grant.rightsTags.join(','),
    availableFrom: parent.grant.availableFrom, availableTo: parent.grant.availableTo,
  });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/series/${series.seriesId}/register`, {
        expectedRevision: series.revision, // 并发登记：revision 不匹配会被服务端拒绝
        checksum: form.checksum.trim(), changeNote: form.changeNote.trim(),
        grant: {
          territories: form.territories.split(/[,，]/).map(s => s.trim()).filter(Boolean),
          platforms: form.platforms.split(/[,，]/).map(s => s.trim()).filter(Boolean),
          rightsTags: form.rightsTags.split(/[,，]/).map(s => s.trim()).filter(Boolean),
          availableFrom: form.availableFrom, availableTo: form.availableTo,
        },
      });
      onDone();
    } catch (e) { onFail(e as Error & { code?: string }); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <div className="register-form">
      <div className="rf-title">登记下一版 v{series.currentVersion + 1}（父版本 <code>{parent.nodeId}</code>；谱系 revision {series.revision} 作为乐观锁）</div>
      <div className="rf-grid">
        <input placeholder="checksum，如 sha256:…" value={form.checksum} onChange={set('checksum')} />
        <input placeholder="变更说明（必填）" value={form.changeNote} onChange={set('changeNote')} />
        <input placeholder="地域（逗号分隔）" value={form.territories} onChange={set('territories')} />
        <input placeholder="平台" value={form.platforms} onChange={set('platforms')} />
        <input placeholder="版权标签" value={form.rightsTags} onChange={set('rightsTags')} />
        <span className="rf-dates"><input type="date" value={form.availableFrom} onChange={set('availableFrom')} /> → <input type="date" value={form.availableTo} onChange={set('availableTo')} /></span>
      </div>
      <button disabled={busy || !form.checksum.trim() || !form.changeNote.trim()} onClick={() => void submit()}>{busy ? '登记中…' : `登记 v${series.currentVersion + 1}`}</button>
      <small className="rf-hint">与本谱系历史版本相同的 checksum 会被拒绝；版本号必须连续；重复点击由 Idempotency-Key 去重。</small>
    </div>
  );
}

// ---- 血缘抽屉：v8 从哪一版来 + checksum/授权 diff ---------------------------
function DetailDrawer({ data, onClose }: { data: { node: AssetNode; ancestors: AssetNode[]; compare?: CompareResult }; onClose: () => void }) {
  const { node, ancestors, compare } = data;
  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={e => e.stopPropagation()}>
        <div className="panel-head"><h3>{node.name} v{node.version}</h3><button className="ghost" onClick={onClose}>关闭</button></div>
        <code className="drawer-id">{node.nodeId}</code>
        <p className="change-note">“{node.changeNote}”</p>
        <small>checksum <b className="mono">{node.checksum}</b></small>
        <h4>版本谱系（{node.nodeId} 从哪一版来）</h4>
        <div className="chain">
          {ancestors.map((n, i) => (
            <div key={n.nodeId} className={`chain-item ${n.nodeId === node.nodeId ? 'current' : ''}`}>
              <span className="chain-arrow">{i === 0 ? '●' : '↑'}</span>
              <code>{n.nodeId}</code><span className={`pill ${n.status}`}>{statusCN[n.status]}</span>
              <small>{n.createdAt.slice(0, 10)} · {short(n.checksum)}</small>
              <small className="chain-note">{n.changeNote}</small>
            </div>
          ))}
        </div>
        {compare && (
          <>
            <h4>与父版本 {compare.b.nodeId} 比较</h4>
            <div className={`compare-banner ${compare.checksumChanged ? 'changed' : 'same'}`}>
              checksum {compare.checksumChanged ? '已变化 ✓ 文件确实不同' : '未变化（文件相同）'} · 关系：{compare.relationship === 'lineal' ? '直系父子' : compare.relationship}
            </div>
            <div className="table">
              {Object.values(compare.fields).map(f => (
                <div className="tr compare-row" key={f.label}>
                  <span>{f.label}</span>
                  <span className={f.changed ? 'diff-from' : ''}>{JSON.stringify(f.from)}</span>
                  <span className={f.changed ? 'diff-to' : ''}>{JSON.stringify(f.to)}</span>
                </div>
              ))}
            </div>
            <small>变化字段：{compare.changedFields.join('、') || '无'}</small>
          </>
        )}
      </aside>
    </div>
  );
}
