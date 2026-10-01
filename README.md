# FrameLedger · 影视制作预算与资产版权协同平台

React + Vite + TypeScript 前端，Node.js + Express + TypeScript 服务端。面向中型影视制作团队，演示预算版本、成本预测、合同里程碑、资产版本、授权窗口冲突与审批审计的协同闭环。

## 启动

```bash
npm install
npm run dev
```

前端默认 Vite 端口 5175，API 默认 `http://localhost:4104`。

## 业务能力

- 项目 / 季 / 交付日期与预算基线；计划、承诺、实际、预测成本四账合一
- 供应商合同额度、付款里程碑与付款暴露额
- **资产版本谱系**：母版/预告/海报/音频/字幕以谱系（series）纳管，每个版本是不可变节点（`SER-001@7`），登记元数据（checksum、owner、变更说明）与父子关系（parentId），可回答“v8 从哪一版来”
- **只增事件日志 + 内存物化视图**：所有状态变化（登记/送审/审批/锁定/撤回/授权撤销/交付包操作）只能 append 事件；查询侧由事件重放重建。锁定历史不可静默覆盖
- **送审 / 锁定 / 撤回**：draft → in_review → approved → locked 生命周期；锁定需授权有效；在途交付包引用的版本不可撤回；锁定后授权失效只追加 `grant_revoked`，锁定记录保留但预检阻断交付
- **交付包预检**：引用具体版本，检出撤回版本、重复 checksum、过期/撤销授权、旧版引用、版权冲突（block/warning）
- 地域、平台、有效期、版权标签冲突检测（比较具体版本；撤回或授权失效版本退出冲突集合）
- 审批队列与审计事件：资产版本审批、交付审批、预算审批统一入口，全部指向具体版本
- React 控制台：版本时间线、血缘链与 checksum/授权 diff、登记新版本（expectedRevision 乐观并发）、交付包预检与送审；页头显示 `LEDGER rev.N`，每次写操作后整体重拉与服务端对齐

## 并发与重复请求

- `Idempotency-Key` 请求头（或 body 字段）：相同键 + 相同请求体返回首次结果，不重复登记；键相同而内容不同返回 `IDEMPOTENCY_CONFLICT`
- 登记时传 `expectedRevision`（谱系 revision）：并发的第二笔登记返回 `VERSION_CONFLICT`，控制台收到冲突后强制刷新
- checksum 与本谱系历史版本相同 → `CHECKSUM_DUPLICATE`（文件没有真的变）；跨谱系相同文件可登记，但同包出现时预检 `DUPLICATE_CHECKSUM`
- 版本号必须连续，跳号返回 `VERSION_GAP`

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:id/lineage` | 谱系树（节点、父子、授权、被哪些包引用） |
| POST | `/api/series/:seriesId/register` | 登记版本（expectedRevision / Idempotency-Key） |
| GET | `/api/nodes/:nodeId` | 版本详情 + ancestors 血缘链 |
| GET | `/api/nodes/:a/compare/:b` | checksum 与授权范围 diff |
| POST | `/api/nodes/:nodeId/submit|lock|withdraw|revoke-grant` | 送审/锁定/撤回/撤销授权 |
| GET/POST | `/api/projects/:id/packages`、`/api/packages/:id/refs`、`/precheck`、`/submit` | 交付包与预检 |
| PATCH | `/api/approvals/:id` | 预算/资产版本/交付包统一审批 |
| GET | `/api/state/events` | 只增审计事件流 |

当前使用内存数据，领域服务按模块设计，后续可替换 PostgreSQL（事件表 + 投影快照）、对象存储、工作流和版权方台账服务。
