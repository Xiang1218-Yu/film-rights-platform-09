import { useCallback, useEffect, useState } from 'react';
import {
  ApiError, request, shortChecksum, today,
  type AssetVersion, type Comparison, type Conflict, type Delivery, type LineageHead, type ScopeDiff, type VersionDetail,
} from './api';

interface Props {
  projectId: string;
  conflicts: Conflict[];
  notify: (message: string, isError?: boolean) => void;
  revision: number;
  afterMutation: () => Promise<void>;
}

const STATUS_LABEL: Record<string, string> = { draft: '草稿', review: '送审中', approved: '已通过', locked: '已锁定', withdrawn: '已撤回' };

function ScopeDiffView({ diff }: { diff: ScopeDiff }) {
  const rows: { label: string; added: string[]; removed: string[] }[] = [
    { label: '地域', added: diff.addedTerritories, removed: diff.removedTerritories },
    { label: '平台', added: diff.addedPlatforms, removed: diff.removedPlatforms },
    { label: '版权标签', added: diff.addedTags, removed: diff.removedTags },
  ];
  return (
    <div className="diff-box">
      {rows.filter(r => r.added.length || r.removed.length).map(r => (
        <div key={r.label} className="diff-row">
          <b>{r.label}</b>
          <span>{r.removed.map(x => <em key={x} className="removed">{x}</em>)}{r.added.map(x => <em key={x} className="added">{x}</em>)}</span>
        </div>
      ))}
      {diff.windowChanged && (
        <div className="diff-row">
          <b>授权窗口</b>
          <span><em className="removed">{diff.parentWindow.availableFrom} → {diff.parentWindow.availableTo}</em><em className="added">{diff.window.availableFrom} → {diff.window.availableTo}</em></span>
        </div>
      )}
      {!rows.some(r => r.added.length || r.removed.length) && !diff.windowChanged && <small>授权范围与父版本完全一致</small>}
    </div>
  );
}

export default function LineageTab({ projectId, conflicts, notify, revision, afterMutation }: Props) {
  const [lineages, setLineages] = useState<LineageHead[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [selectedLineage, setSelectedLineage] = useState('');
  const [detail, setDetail] = useState<VersionDetail>();
  const [selectedVersion, setSelectedVersion] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (versionId?: string) => {
    const [{ data: lineageList }, { data: deliveryList }] = await Promise.all([
      request<LineageHead[]>(`/projects/${projectId}/assets`),
      request<Delivery[]>(`/projects/${projectId}/deliveries`),
    ]);
    setLineages(lineageList);
    setDeliveries(deliveryList);
    const target = versionId
      ?? lineageList.find(l => l.lineage.id === selectedLineage)?.head?.id
      ?? lineageList[0]?.head?.id
      ?? '';
    if (target) {
      const { data } = await request<VersionDetail>(`/versions/${target}`);
      setSelectedLineage(data.lineage.id);
      setSelectedVersion(target);
      setDetail(data);
    }
  }, [projectId, selectedLineage]);

  useEffect(() => { setDetail(undefined); void load(); }, [projectId]);
  useEffect(() => { void load(selectedVersion); }, [revision]);

  const selectLineage = async (lineageId: string) => {
    const head = lineages.find(l => l.lineage.id === lineageId)?.head;
    if (head) { setSelectedLineage(lineageId); setSelectedVersion(head.id); const { data } = await request<VersionDetail>(`/versions/${head.id}`); setDetail(data); }
  };

  const selectVersion = async (versionId: string) => {
    setSelectedVersion(versionId);
    const { data } = await request<VersionDetail>(`/versions/${versionId}`);
    setDetail(data);
  };

  const act = async (fn: () => Promise<void>, success: string) => {
    setBusy(true);
    try { await fn(); notify(success); }
    catch (error) { notify(error instanceof ApiError ? error.message : '操作失败', true); }
    finally { setBusy(false); }
  };

  // 所有写操作统一走这里：请求成功后让 App 按最新 revision 重取，再加载版本详情。
  const mutate = async (path: string, body?: unknown, method: 'POST' | 'PATCH' = 'POST') => {
    await request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    await afterMutation();
    await load(selectedVersion);
  };

  const current = lineages.find(l => l.lineage.id === selectedLineage);

  return (
    <div className="grid lineage-grid">
      <section className="panel">
        <div className="panel-head"><h3>资产谱系</h3><span>{lineages.length} 条族系 · revision {revision}</span></div>
        {lineages.map(l => (
          <button key={l.lineage.id} className={`lineage-item ${l.lineage.id === selectedLineage ? 'active' : ''}`} onClick={() => void selectLineage(l.lineage.id)}>
            <b>{l.lineage.name}</b>
            <small>{l.lineage.id} · {l.lineage.type} · {l.depth} 个版本</small>
            {l.head && <span className={`pill ${l.head.status}`}>{STATUS_LABEL[l.head.status]} · v{l.head.version}</span>}
          </button>
        ))}
        {current?.head && current.head.status !== 'locked' && (
          <button className="register-toggle" onClick={() => setShowRegister(v => !v)}>{showRegister ? '收起登记表' : '＋ 登记每日新版本'}</button>
        )}
        {showRegister && current?.head && (
          <RegisterForm
            lineage={current}
            onDone={async (versionId, message) => {
              setShowRegister(false);
              await afterMutation();
              await load(versionId);
              notify(message);
            }}
            onError={message => notify(message, true)}
          />
        )}
      </section>

      <section className="panel wide">
        {detail ? <VersionDetailView
          key={detail.version.id}
          detail={detail}
          chain={current?.versions ?? []}
          conflicts={conflicts}
          deliveries={deliveries}
          busy={busy}
          onSelectVersion={id => void selectVersion(id)}
          onSubmit={() => void act(() => mutate(`/versions/${detail.version.id}/submit`, { actor: '控制台', approver: '总制片人' }), '已送审，审批队列已生成')}
          onRequestLock={() => void act(() => mutate(`/versions/${detail.version.id}/lock`, { actor: '控制台', approver: '总制片人' }), '锁定申请已进入审批队列')}
          onWithdraw={() => {
            const reason = window.prompt('撤回原因（旧版若被交付包引用将被拒绝）', '控制台撤回');
            if (reason) void act(() => mutate(`/versions/${detail.version.id}/withdraw`, { actor: '控制台', reason }), '版本已撤回');
          }}
          onPrecheck={packageId => void act(async () => { await mutate(`/deliveries/${packageId}/precheck`, { actor: '控制台' }); }, '预检完成：引用版本已钉住')}
        /> : <div className="empty">选择左侧谱系查看版本链。</div>}
      </section>
    </div>
  );
}

function VersionDetailView({ detail, chain, conflicts, deliveries, busy, onSelectVersion, onSubmit, onRequestLock, onWithdraw, onPrecheck }: {
  detail: VersionDetail;
  chain: AssetVersion[];
  conflicts: Conflict[];
  deliveries: Delivery[];
  busy: boolean;
  onSelectVersion: (id: string) => void;
  onSubmit: () => void;
  onRequestLock: () => void;
  onWithdraw: () => void;
  onPrecheck: (id: string) => void;
}) {
  const { version: v, comparison, referencedBy, approvals, audit } = detail;
  const versionConflicts = conflicts.filter(c => c.versionAId === v.id || c.versionBId === v.id);
  return (
    <>
      <div className="panel-head">
        <div>
          <div className="eyebrow">{v.lineageId} · 版本详情</div>
          <h3>{v.name} <em className="vnum">v{v.version}</em></h3>
          <small>{v.id} · {v.owner} · {v.createdAt.slice(0, 10)} 登记 · {v.createdBy}</small>
        </div>
        <span className={`pill ${v.status}`}>{STATUS_LABEL[v.status]}</span>
      </div>

      <div className="chain-strip">
        {chain.map(c => (
          <button key={c.id} className={`chain-pill ${c.id === v.id ? 'active' : ''}`} onClick={() => onSelectVersion(c.id)} title={c.changeNote}>
            v{c.version} <span className={`pill ${c.status}`}>{STATUS_LABEL[c.status]}</span>
          </button>
        ))}
      </div>

      <div className="version-actions">
        {v.status === 'draft' && <button disabled={busy} onClick={onSubmit}>送审</button>}
        {v.status === 'review' && <em className="hint">等待审批中…</em>}
        {v.status === 'approved' && <button disabled={busy} onClick={onRequestLock}>申请锁定</button>}
        {v.status === 'locked' && <em className="hint locked-hint">🔒 已锁定：内容与授权不可变，变更只能登记新版本</em>}
        {!['locked', 'withdrawn'].includes(v.status) && <button className="ghost" disabled={busy} onClick={onWithdraw}>撤回版本</button>}
      </div>

      <div className="lineage-chain">
        <div className="eyebrow">父子谱系（v{v.version} 从哪来）</div>
        <ChainTimeline version={v} parent={comparison.parent} onSelect={onSelectVersion} />
      </div>

      <div className="detail-columns">
        <div>
          <h4>checksum 与文件比对</h4>
          <div className="kv"><small>当前 checksum</small><code>{shortChecksum(v.checksum)}</code></div>
          {comparison.parent && <div className="kv"><small>父版本 checksum</small><code>{shortChecksum(comparison.parent.checksum)}</code></div>}
          <div className={`compare-flag ${comparison.checksumChanged ? 'changed' : 'same'}`}>
            {comparison.checksumChanged ? '✓ 文件确实发生变化' : '✗ 与父版本字节相同（无需新版本）'}
          </div>
          {comparison.sameAs.length > 0 && (
            <div className="kv"><small>相同 checksum 还出现在</small><span>{comparison.sameAs.map(s => <button key={s.versionId} className="link" onClick={() => onSelectVersion(s.versionId)}>{s.label}</button>)}</span></div>
          )}
          <h4>变更说明</h4>
          <p className="change-note">{v.changeNote}</p>
        </div>
        <div>
          <h4>授权范围对比</h4>
          <ScopeDiffView diff={comparison.scopeDiff ?? {
            addedTerritories: [], removedTerritories: [], addedPlatforms: [], removedPlatforms: [],
            addedTags: [], removedTags: [], windowChanged: false,
            parentWindow: { availableFrom: '-', availableTo: '-' }, window: { availableFrom: v.availableFrom, availableTo: v.availableTo },
          }} />
          <div className="kv"><small>地域</small><span>{v.territories.join('、') || '—'}</span></div>
          <div className="kv"><small>平台</small><span>{v.platforms.join('、') || '—'}</span></div>
          <div className="kv"><small>窗口</small><span>{v.availableFrom} ~ {v.availableTo}{v.availableTo < today() && <em className="removed"> 已失效</em>}</span></div>
          <div className="kv"><small>版权标签</small><span>{v.rightsTags.join('、') || '—'}</span></div>
        </div>
      </div>

      <div className="detail-columns">
        <div>
          <h4>交付包引用（旧版是否仍被引用）</h4>
          {referencedBy.length === 0 && <div className="empty compact">暂无交付包引用，可安全撤回。</div>}
          {referencedBy.map(ref => {
            const pkg = deliveries.find(d => d.id === ref.id);
            return (
              <div className="ref-row" key={ref.id}>
                <b>{ref.id} · {ref.title}</b>
                <span className={`pill ${ref.status === 'prechecked' ? 'review' : ref.status}`}>{ref.status}</span>
                {pkg?.status === 'draft' && <button className="ghost" disabled={busy} onClick={() => onPrecheck(ref.id)}>执行预检</button>}
                {pkg?.precheck && <small>预检于 {pkg.precheck.at.slice(0, 10)} 钉住此版本：{pkg.precheck.findings.join('；')}</small>}
              </div>
            );
          })}
        </div>
        <div>
          <h4>关联审批（指向本版本）</h4>
          {approvals.length === 0 && <div className="empty compact">暂无审批记录。</div>}
          {approvals.map(a => (
            <div className="ref-row" key={a.id}>
              <b>{a.title}</b>
              <span className={`status-dot ${a.status}`}>{a.status}</span>
              <small>{a.id} · 审批人 {a.approver}{a.comment ? ` · ${a.comment}` : ''}</small>
            </div>
          ))}
          {versionConflicts.length > 0 && <>
            <h4>本版本的版权冲突</h4>
            {versionConflicts.map((c, i) => (
              <div className="ref-row" key={i}>
                <strong className={c.severity}>{c.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</strong>
                <span><button className="link" onClick={() => onSelectVersion(c.versionAId === v.id ? c.versionBId : c.versionAId)}>
                  {c.versionAId === v.id ? c.assetB : c.assetA}
                </button></span>
                <small>{c.reason}</small>
              </div>
            ))}
          </>}
        </div>
      </div>

      <h4>只追加审计历史（不可静默覆盖）</h4>
      <div className="audit-list">
        {audit.map(e => (
          <div key={e.id} className={`audit-row ${e.denied ? 'denied' : ''}`}>
            <span className="rev">#{e.revision}</span>
            <b>{e.action}</b>
            <small>{e.actor} · {e.at.slice(0, 16).replace('T', ' ')}</small>
            <em>{e.details}{e.denied ? '（已拒绝并留痕）' : ''}</em>
          </div>
        ))}
      </div>
    </>
  );
}

function ChainTimeline({ version, parent, onSelect }: { version: AssetVersion; parent: AssetVersion | null; onSelect: (id: string) => void }) {
  // 展示直接父版本 + 当前版本；完整链可在左侧谱系列表中逐个查看。
  return (
    <div className="timeline">
      {parent && <>
        <button className="chain-node" onClick={() => onSelect(parent.id)}>
          <b>v{parent.version}</b><small>{parent.id}</small><span className={`pill ${parent.status}`}>{STATUS_LABEL[parent.status]}</span>
        </button>
        <span className="chain-arrow">→</span>
      </>}
      <span className="chain-node current"><b>v{version.version}</b><small>{version.id}</small><span className={`pill ${version.status}`}>{STATUS_LABEL[version.status]}</span></span>
    </div>
  );
}

function RegisterForm({ lineage, onDone, onError }: {
  lineage: LineageHead;
  onDone: (versionId: string, message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const head = lineage.head!;
  const [checksum, setChecksum] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [territories, setTerritories] = useState(head.territories.join(','));
  const [platforms, setPlatforms] = useState(head.platforms.join(','));
  const [availableFrom, setFrom] = useState(today());
  const [availableTo, setTo] = useState(head.availableTo);
  const [rightsTags, setTags] = useState(head.rightsTags.join(','));
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!/^[0-9a-f]{64}$/i.test(checksum.trim())) { onError('请粘贴 64 位十六进制 sha256（不含前缀）'); return; }
    if (!changeNote.trim()) { onError('变更说明不能为空'); return; }
    const split = (s: string) => s.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
    const idempotencyKey = `reg-${lineage.lineage.id}-${Date.now()}`;
    setSubmitting(true);
    try {
      const { data } = await request<{ version: AssetVersion; checksumDuplicate: boolean; idempotentReplay: boolean }>(
        `/lineages/${lineage.lineage.id}/versions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', IdempotencyKey: idempotencyKey },
          body: JSON.stringify({
            projectId: lineage.lineage.projectId,
            name: head.name, type: head.type, owner: head.owner,
            checksum: `sha256:${checksum.trim()}`,
            parentVersionId: head.id,
            expectedHeadVersion: head.version,
            changeNote,
            createdBy: '控制台',
            territories: split(territories), platforms: split(platforms), rightsTags: split(rightsTags),
            availableFrom, availableTo,
          }),
        },
      );
      await onDone(data.version.id, data.checksumDuplicate
        ? `已登记 ${data.version.id}；警告：checksum 与其他谱系版本相同`
        : `已登记 ${data.version.id}（父版本 v${head.version}）`);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : '登记失败');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="register-form">
      <div className="eyebrow">基于链头 v{head.version} 登记，新版本号由服务端分配</div>
      <label>sha256（64 位 hex）<input value={checksum} onChange={e => setChecksum(e.target.value)} placeholder="粘贴文件校验值…" /></label>
      <label>变更说明<textarea value={changeNote} onChange={e => setChangeNote(e.target.value)} placeholder="相对父版本改了什么？" rows={2} /></label>
      <label>地域（逗号分隔）<input value={territories} onChange={e => setTerritories(e.target.value)} /></label>
      <label>平台<input value={platforms} onChange={e => setPlatforms(e.target.value)} /></label>
      <div className="form-row">
        <label>授权起<input type="date" value={availableFrom} onChange={e => setFrom(e.target.value)} /></label>
        <label>授权止<input type="date" value={availableTo} onChange={e => setTo(e.target.value)} /></label>
      </div>
      <label>版权标签<input value={rightsTags} onChange={e => setTags(e.target.value)} /></label>
      <button disabled={submitting} onClick={() => void submit()}>{submitting ? '登记中…' : '提交登记（自动带 Idempotency-Key）'}</button>
    </div>
  );
}
