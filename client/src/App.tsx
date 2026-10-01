import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LineageTab from './LineageTab';
import { ApiError, request, type Conflict, type Project, type Summary } from './api';

const money = (n: number) => `¥${(n / 10000).toFixed(0)}万`;

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('PRJ-001');
  const [summary, setSummary] = useState<Summary>();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [tab, setTab] = useState<'overview' | 'budget' | 'rights' | 'lineage'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // 服务端修订号（ledger revision）。每次响应都回传，控制台只渲染与该 revision 一致的数据。
  const [revision, setRevision] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const applyRevision = (rev: number) => setRevision(prev => Math.max(prev, rev));
  const notify = (text: string, isError = false) => (isError ? setError(text) : setMessage(text));

  const load = useCallback(async (id = 'PRJ-001') => {
    setLoading(true); setError('');
    try {
      const projectsResp = await request<Project[]>('/projects');
      applyRevision(projectsResp.revision);
      const active = projectsResp.data.find(item => item.id === id) ?? projectsResp.data[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      const [s, c] = await Promise.all([
        request<Summary>(`/projects/${active.id}/summary`),
        request<Conflict[]>(`/projects/${active.id}/rights-conflicts`),
      ]);
      applyRevision(s.revision); applyRevision(c.revision);
      setProjects(projectsResp.data);
      setSelected(active.id);
      setSummary(s.data);
      setConflicts(c.data);
      setRevision(s.data.ledger.revision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接制作服务');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // 轻量轮询：如果别的终端改了账本，控制台通过 revision 发现并重新拉取，保持同一状态。
  useEffect(() => {
    timer.current = setInterval(async () => {
      try {
        const { data, revision: rev } = await request<{ revision: number }>('/ledger');
        if (rev > 0 && data.revision !== revision) { setRevision(data.revision); await load(selected); }
      } catch { /* 离线时静默，保留当前状态 */ }
    }, 8000);
    return () => clearInterval(timer.current);
  }, [load, revision, selected]);

  const approve = async (id: string) => {
    try {
      await request(`/approvals/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved', comment: '在控制台完成复核', actor: '控制台' }) });
      setMessage('审批已通过，版本状态与审计事件已同步');
      await load(selected);
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : '审批操作失败'); }
  };

  const variancePct = useMemo(() => summary ? Math.round(summary.variance / summary.planned * 100) : 0, [summary]);

  if (loading && !summary) return <main className="connection-state"><div className="loading">正在载入制作控制台…</div><small>正在通过 Vite API 代理连接本地制作服务</small></main>;
  if (!summary) return <main className="connection-state"><h2>无法连接制作服务</h2><p>{error || '服务端没有返回项目数据。'}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5173 和 API 4104 均已启动。</p><button onClick={() => void load(selected)}>重新连接</button></main>;

  return <main>
    <header>
      <div>
        <div className="eyebrow">STUDIO OPS / RIGHTS & FINANCE CONTROL</div>
        <h1>FrameLedger <span>影视制作预算与资产版权协同</span></h1>
        <p>将预算承诺、供应商付款、资产版本谱系与跨地域版权窗口串成可审计的交付链路。</p>
      </div>
      <div className="header-actions">
        <select value={selected} onChange={e => { setSelected(e.target.value); void load(e.target.value); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <span className="live" title="服务端账本修订号（只增不减）"><i /> REV {revision}</span>
      </div>
    </header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}
    {error && <div className="toast error-toast" onClick={() => setError('')}>{error} ×</div>}

    <section className="kpis">
      <div><small>FORECAST COST</small><b>{money(summary.forecast)}</b><span>预算偏差 <em className={summary.variance > 0 ? 'bad' : ''}>{variancePct}%</em></span></div>
      <div><small>COMMITTED</small><b>{money(summary.committed)}</b><span>已锁定供应商与合同</span></div>
      <div><small>VERSION REGISTER</small><b>{summary.ledger.versionCount}<em> 个版本</em></b><span>{summary.assetCount} 条族系纳管</span></div>
      <div><small>RISK QUEUE</small><b>{summary.pendingApprovals + conflicts.length}<em> 项</em></b><span>{conflicts.length} 条版权冲突 / {summary.pendingApprovals} 个审批</span></div>
    </section>

    <nav className="tabs">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>项目驾驶舱</button>
      <button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>预算与合同</button>
      <button className={tab === 'rights' ? 'active' : ''} onClick={() => setTab('rights')}>资产版权图谱</button>
      <button className={tab === 'lineage' ? 'active' : ''} onClick={() => setTab('lineage')}>版本谱系</button>
      <span>交付日 {summary.project.deliveryDate} · LEDGER REV {revision}</span>
    </nav>

    {tab === 'overview' && <div className="grid">
      <section className="panel hero">
        <div className="panel-head"><div><div className="eyebrow">PROJECT HEALTH / {summary.project.id}</div><h2>{summary.project.title}</h2></div><span className="badge amber">{summary.project.status.toUpperCase()}</span></div>
        <div className="progress-label"><span>成本消耗 {Math.round(summary.utilization * 100)}%</span><b>{money(summary.actual)} / {money(summary.planned)}</b></div>
        <div className="progress"><i style={{ width: `${Math.min(100, summary.utilization * 100)}%` }} /></div>
        <div className="split"><div><small>合同暴露额</small><strong>{money(summary.contractExposure)}</strong></div><div><small>高风险预算项</small><strong className="bad">{summary.highRiskLines.length}</strong></div><div><small>版权冲突</small><strong className={conflicts.length ? 'bad' : ''}>{conflicts.length}</strong></div></div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>待审批队列</h3><span>{summary.approvals.filter(a => a.status === 'pending').length} PENDING</span></div>
        {summary.approvals.map(a => <div className="approval" key={a.id}>
          <span className={`status ${a.status}`} />
          <div><b>{a.title}</b><small>{a.approver} · {a.entityId}</small></div>
          {a.status === 'pending' ? <button onClick={() => approve(a.id)}>通过</button> : <em>已完成</em>}
        </div>)}
      </section>
      <section className="panel wide">
        <div className="panel-head"><h3>交付风险雷达</h3><span>冲突双方均指向具体版本</span></div>
        {conflicts.length ? conflicts.map((c, i) => <div className="risk-row" key={i}>
          <strong className={c.severity}>{c.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</strong>
          <div><b>{c.assetA} ↔ {c.assetB}</b><small>{c.versionAId} ↔ {c.versionBId} · {c.reason}</small></div>
        </div>) : <div className="empty">当前项目未发现版权窗口冲突。</div>}
      </section>
    </div>}

    {tab === 'budget' && <div className="grid">
      <section className="panel wide">
        <div className="panel-head"><h3>预算版本 V3 / 成本基线</h3><span>实际 + 承诺 + 预测</span></div>
        <div className="table"><div className="tr th"><span>科目</span><span>预算</span><span>已承诺</span><span>实际</span><span>预测</span><span>风险</span></div>{summary.lines.map(line => <div className="tr" key={line.id}><span><b>{line.category}</b><small>{line.subcategory}</small></span><span>{money(line.planned)}</span><span>{money(line.planned)}</span><span>{money(line.actual)}</span><span className={line.forecast > line.planned ? 'bad' : ''}>{money(line.forecast)}</span><span className={`risk ${line.risk}`}>{line.risk}</span></div>)}</div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>供应商付款里程碑</h3></div>
        {summary.contracts.map(c => <div className="contract" key={c.vendor}><b>{c.vendor}</b><small>{c.scope}</small><div className="contract-bar"><i style={{ width: `${Math.round(c.paid / c.committed * 100)}%` }} /></div><span>{money(c.paid)} / {money(c.committed)}</span><em>{c.milestones.filter(m => m.status !== 'paid').length} 个待结点</em></div>)}
      </section>
    </div>}

    {tab === 'rights' && <div className="grid">
      <section className="panel wide">
        <div className="panel-head"><h3>资产版本登记（当前链头）</h3><span>{summary.assets.length} 个活跃版本 / checksum tracked</span></div>
        <div className="table"><div className="tr th asset-th"><span>资产 / 具体版本</span><span>链头</span><span>状态</span><span>授权截止</span></div>{summary.assets.map(a => <div className="tr asset-tr" key={a.id}><span><b>{a.name}</b><small>{a.id} · {a.type} · 父 {a.parentVersionId ?? '无'}</small></span><span>v{a.version}</span><span><span className={`pill ${a.status}`}>{a.status}</span></span><span>{a.availableTo}</span></div>)}</div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>授权冲突</h3><span>{conflicts.length} detected</span></div>
        {conflicts.map((c, i) => <div className="conflict" key={i}><strong>{c.severity}</strong><b>{c.assetA}</b><small>{c.versionAId} ↔ {c.versionBId} · {c.reason}</small></div>)}
      </section>
    </div>}

    {tab === 'lineage' && <LineageTab projectId={selected} conflicts={conflicts} notify={notify} revision={revision} afterMutation={async () => { await load(selected); }} />}

    <footer>FrameLedger · 不可变版本历史（append-only ledger revision {revision}）+ 内存查询模型 · 所有资产、冲突与审批均指向具体版本</footer>
  </main>;
}
