/**
 * 种子数据：把演示资产登记为“只增事件流”，喂给谱系台账。
 * 事件顺序即历史顺序；业务代码无法区分种子事件与真实事件。
 */
import type { AssetType, Grant, LedgerEvent } from './ledger.js';

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);
const ts = (days: number) => new Date(now + days * 86400000).toISOString();

class EventBuilder {
  private seq = 0;
  private day = -90;
  readonly events: LedgerEvent[] = [];
  at(): string { this.day += 2; return ts(this.day); }
  reg(p: { seriesId: string; projectId: string; name: string; assetType: AssetType; owner: string; version: number; parentId: string | null; checksum: string; changeNote: string; grant: Grant; actor?: string }): void {
    this.seq += 1;
    const nodeId = `${p.seriesId}@${p.version}`;
    const event: LedgerEvent = { type: 'version_registered', seq: this.seq, at: this.at(), actor: p.actor ?? p.owner, registeredBy: p.actor ?? p.owner, nodeId, ...p };
    this.events.push(event);
  }
  ev<T extends Exclude<LedgerEvent['type'], 'version_registered'>>(type: T, rest: Omit<Extract<LedgerEvent, { type: T }>, 'seq' | 'at' | 'type'>): void {
    this.seq += 1;
    this.events.push({ type, seq: this.seq, at: this.at(), ...rest } as Extract<LedgerEvent, { type: T }>);
  }
}

const g = (territories: string[], platforms: string[], from: number, to: number, rightsTags: string[]): Grant => ({ territories, platforms, availableFrom: iso(from), availableTo: iso(to), rightsTags });
const cs = (n: number) => `sha256:${n.toString(16).padStart(8, '0').repeat(4)}${n.toString(16).padStart(8, 'a')}`;

export function buildSeedEvents(): LedgerEvent[] {
  const b = new EventBuilder();
  // ---- SER-001 北境回声 S01E01 4K HDR Master：完整 v1..v7 谱系 ----
  const masterSeries = { seriesId: 'SER-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', assetType: 'master' as const, owner: '后期制片' };
  b.reg({ ...masterSeries, version: 1, parentId: null, checksum: cs(0x91b70001), changeNote: '初剪调光导出，仅作内部审看', grant: g(['CN'], ['内部'], -80, -20, []) });
  b.reg({ ...masterSeries, version: 2, parentId: 'SER-001@1', checksum: cs(0x91b70002), changeNote: '第二轮调色，修正暗部偏色', grant: g(['CN'], ['内部'], -78, -20, []) });
  b.reg({ ...masterSeries, version: 3, parentId: 'SER-001@2', checksum: cs(0x91b70003), changeNote: '声音预混合入，字幕轨缺失', grant: g(['CN', 'HK'], ['StreamBox'], -76, 200, ['演员-全媒介']) });
  b.reg({ ...masterSeries, version: 4, parentId: 'SER-001@3', checksum: cs(0x91b70004), changeNote: '补拍镜头替换 E01-12 场', grant: g(['CN', 'HK'], ['StreamBox'], -74, 300, ['演员-全媒介']) });
  b.reg({ ...masterSeries, version: 5, parentId: 'SER-001@4', checksum: cs(0x91b70005), changeNote: '终混合入；音乐同步授权仅覆盖 CN', grant: g(['CN'], ['影院', 'StreamBox'], -70, 180, ['音乐-同步许可', '演员-全媒介']) });
  // v6：审批通过并锁定过，后被新版取代（解锁后撤回），但仍被已批准的交付包 DEL-007 引用
  b.reg({ ...masterSeries, version: 6, parentId: 'SER-001@5', checksum: cs(0x91b70006), changeNote: '扩展 HK/SG 授权地域，DCP 打包', grant: g(['CN', 'HK', 'SG'], ['影院', 'StreamBox'], -60, 730, ['音乐-同步许可', '演员-全媒介']) });
  // v7：当前候选版本，等待总制片人锁定审批；v6 仍锁定并被已批准的 DEL-007 引用
  b.reg({ ...masterSeries, version: 7, parentId: 'SER-001@6', checksum: cs(0x91b70007), changeNote: '终审意见：片头厂标更换、片尾字幕错字修正', grant: g(['CN', 'HK', 'SG'], ['影院', 'StreamBox'], -2, 730, ['音乐-同步许可', '演员-全媒介']) });
  for (const v of [1, 2, 3, 4, 5]) b.ev('version_withdrawn', { nodeId: `SER-001@${v}`, actor: '后期制片', reason: `已被后续版本取代（v${v + 1}）` });

  // ---- SER-002 主预告 90s ----
  b.reg({ seriesId: 'SER-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', assetType: 'trailer', owner: '营销部', version: 1, parentId: null, checksum: cs(0x42ca0001), changeNote: '粗剪预告', grant: g(['CN'], ['内部'], -55, -10, []) });
  b.reg({ seriesId: 'SER-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', assetType: 'trailer', owner: '营销部', version: 2, parentId: 'SER-002@1', checksum: cs(0x42ca0002), changeNote: '替换配乐（临时占位音乐）', grant: g(['CN'], ['短视频'], -50, 30, ['音乐-同步许可']) });
  b.reg({ seriesId: 'SER-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', assetType: 'trailer', owner: '营销部', version: 3, parentId: 'SER-002@2', checksum: cs(0x42ca0003), changeNote: '加入终版台词与字幕', grant: g(['CN'], ['StreamBox', '短视频'], -30, 180, ['演员-宣传许可']) });
  b.reg({ seriesId: 'SER-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', assetType: 'trailer', owner: '营销部', version: 4, parentId: 'SER-002@3', checksum: cs(0x42ca0004), changeNote: '平台合规修改：片尾加备案号', grant: g(['CN'], ['StreamBox', '短视频'], 6, 180, ['演员-宣传许可']) });
  for (const v of [1, 2]) b.ev('version_withdrawn', { nodeId: `SER-002@${v}`, actor: '营销部', reason: '已被后续版本取代' });

  // ---- SER-003 片尾曲：锁定版本，授权窗口 52 天后到期（与母版存在真实冲突） ----
  b.reg({ seriesId: 'SER-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', assetType: 'audio', owner: '音乐版权', version: 1, parentId: null, checksum: cs(0x113c0001), changeNote: '初版混音', grant: g(['CN'], ['StreamBox'], -120, -2, ['音乐-同步许可']) });
  b.reg({ seriesId: 'SER-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', assetType: 'audio', owner: '音乐版权', version: 2, parentId: 'SER-003@1', checksum: cs(0x113c0002), changeNote: '终混，覆盖北美同步许可', grant: g(['CN', 'US', 'CA'], ['影院', 'StreamBox'], -40, 52, ['音乐-同步许可']) });
  b.ev('version_withdrawn', { nodeId: 'SER-003@1', actor: '音乐版权', reason: '初版混音已被终混取代' });

  // ---- SER-005 中文字幕（草稿） ----
  b.reg({ seriesId: 'SER-005', projectId: 'PRJ-001', name: '简体中文字幕 SRT', assetType: 'subtitle', owner: '字幕组', version: 1, parentId: null, checksum: cs(0x77f10001), changeNote: '初稿对轴，待技术校对', grant: g(['CN', 'HK', 'SG'], ['StreamBox'], -1, 730, ['字幕-内部校对']) });

  // ---- SER-004 Orbit E02 Satellite Plates（PRJ-002） ----
  b.reg({ seriesId: 'SER-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', assetType: 'master', owner: '视觉总监', version: 1, parentId: null, checksum: cs(0x8a100001), changeNote: '首轮航拍素材', grant: g(['全球'], ['影院'], -10, 300, ['航拍-编辑许可']) });
  b.reg({ seriesId: 'SER-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', assetType: 'master', owner: '视觉总监', version: 2, parentId: 'SER-004@1', checksum: cs(0x8a100002), changeNote: '卫星素材降噪处理', grant: g(['全球'], ['影院'], 0, 365, ['航拍-编辑许可']) });
  b.reg({ seriesId: 'SER-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', assetType: 'master', owner: '视觉总监', version: 3, parentId: 'SER-004@2', checksum: cs(0x8a100003), changeNote: '增补授权凭证后的送审版', grant: g(['全球'], ['影院'], 18, 365, ['航拍-编辑许可']) });
  for (const v of [1, 2]) b.ev('version_withdrawn', { nodeId: `SER-004@${v}`, actor: '视觉总监', reason: '已被后续版本取代' });

  // ---- 审批生命周期（ID 由提交顺序决定：APR-02/03/04） ----
  // SER-001 v6：送审 → 通过 → 锁定（历史已锁定过）
  b.ev('review_submitted', { nodeId: 'SER-001@6', actor: '后期制片', approvalId: 'APR-02', approver: '总制片人', title: '北境回声 S01E01 4K HDR Master v6 锁定审批' });
  b.ev('approval_decided', { approvalId: 'APR-02', decision: 'approved', comment: '授权齐备，同意锁定用于节展交付', actor: '总制片人', entityType: 'asset_version', entityId: 'SER-001@6' });
  b.ev('version_locked', { nodeId: 'SER-001@6', actor: '总制片人' });
  // v6 保持锁定：即使 v7 出现，锁定历史不可覆盖，且 DEL-007 仍在引用它（见下）。

  // SER-002 v4：审批通过
  b.ev('review_submitted', { nodeId: 'SER-002@4', actor: '营销部', approvalId: 'APR-03', approver: '法务负责人', title: '主预告 90s / Cut A v4 平台投放审批' });
  b.ev('approval_decided', { approvalId: 'APR-03', decision: 'approved', comment: '备案号已核验', actor: '法务负责人', entityType: 'asset_version', entityId: 'SER-002@4' });

  // SER-003 v2：审批通过并锁定（至今仍锁定）
  b.ev('review_submitted', { nodeId: 'SER-003@2', actor: '音乐版权', approvalId: 'APR-04', approver: '法务负责人', title: '片尾曲 / Winter Signal v2 同步授权锁定' });
  b.ev('approval_decided', { approvalId: 'APR-04', decision: 'approved', comment: '北美同步许可凭证齐全', actor: '法务负责人', entityType: 'asset_version', entityId: 'SER-003@2' });
  b.ev('version_locked', { nodeId: 'SER-003@2', actor: '法务负责人' });

  // SER-004 v3：等待审批
  b.ev('review_submitted', { nodeId: 'SER-004@3', actor: '视觉总监', approvalId: 'APR-05', approver: '制片主任', title: 'Orbit E02 Satellite Plates v3 送审' });

  // ---- SER-001 v7：当前待审批单 APR-06（对应历史 APR-02 语义） ----
  b.ev('review_submitted', { nodeId: 'SER-001@7', actor: '后期制片', approvalId: 'APR-06', approver: '总制片人', title: 'E01 最终母版锁定 v7' });

  // ---- DEL-007 海外节展交付包：已批准，仍引用旧版 SER-001@6 ----
  b.ev('package_created', { packageId: 'DEL-007', projectId: 'PRJ-001', name: '海外节展交付包', actor: '发行部' });
  b.ev('package_ref_added', { packageId: 'DEL-007', nodeId: 'SER-001@6', actor: '发行部' });
  b.ev('package_ref_added', { packageId: 'DEL-007', nodeId: 'SER-003@2', actor: '发行部' });
  b.ev('package_prechecked', { packageId: 'DEL-007', actor: '发行部' });
  b.ev('package_submitted', { packageId: 'DEL-007', approvalId: 'APR-07', approver: '法务负责人', actor: '发行部' });
  b.ev('approval_decided', { approvalId: 'APR-07', decision: 'approved', comment: '已补充航拍授权凭证', actor: '法务负责人', entityType: 'delivery', entityId: 'DEL-007' });

  return b.events;
}
