# FrameLedger · 影视制作预算与资产版权协同平台

React + Vite + TypeScript 前端，Node.js + Express + TypeScript 服务端。面向中型影视制作团队，演示预算版本、成本预测、合同里程碑、资产版本、授权窗口冲突与审批审计的协同闭环。

## 启动

```bash
npm install
npm run dev
```

前端默认 Vite 端口 5173，API 默认 `http://localhost:4104`。

## 业务能力

- 项目 / 季 / 交付日期与预算基线；计划、承诺、实际、预测成本四账合一
- 供应商合同额度、付款里程碑与付款暴露额
- **资产版本谱系**：母版、预告、海报、音频、字幕按“族系（lineage）+ 具体版本”登记；
  每个版本记录元数据、父版本、变更说明、checksum 与授权范围
- **谱系问答**：“v8 从哪一版来”（parentVersionId 线性链）、“文件是否真的变了”（checksum 比对）、
  “旧版是否仍被交付包引用”（交付包只引用具体版本，预检后引用被钉住）
- **写路径安全**：版本号服务端按链头 +1 连号分配（无跳号）；同谱系重复 checksum 拒绝登记；
  `expectedHeadVersion` 乐观并发 + 谱系级互斥；`Idempotency-Key` 重放不产生新版本
- **生命周期**：草稿 → 送审（审批）→ 通过 → 锁定（审批）；锁定版本内容与授权不可变，
  授权到期也只能登记新版本承接；撤回会被“仍被交付包/预检引用”拦截
- 地域、平台、有效期、版权标签冲突检测，冲突双方均指向具体版本
- 交付包预检校验授权窗口、撤回状态与版本间冲突
- **不可变审计账本**：审批、锁定、撤回乃至被拒绝的操作全部只追加（append-only），
  审批不可重复决定；账本 `revision` 单调递增并通过 `X-Ledger-Revision` 随每个响应下发，
  控制台轮询 `/api/ledger` 发现偏差即刷新，保证服务端与控制台同一状态
- React 控制台新增「版本谱系」标签：族系/版本切换、父子链、checksum 与授权 diff、
  交付引用、版本审批与只追加审计流

## 设计权衡：不可变历史 × 内存查询

- 历史是 append-only 数组（版本与审计事件不更新/删除；版本状态字段走受控状态机），
  查询侧在内存中维护 checksum 索引、父子关系和交付引用反查；后续接 PostgreSQL 时
  只需替换仓储层，状态机与审计语义不变。
- 服务端是唯一事实源，控制台不缓存可变更结论，每次动作后按最新 revision 全量重取。

## 关键 API

- `GET /api/projects/:id/assets` 族系列表（含链头与完整版本链）
- `POST /api/lineages/:id/versions`（支持 `Idempotency-Key` 头）登记新版本
- `GET /api/versions/:id` 版本详情：父子、checksum/授权对比、交付引用、审批、审计
- `POST /api/versions/:id/submit|lock|withdraw`、`PATCH /api/versions/:id/scope`
- `POST /api/deliveries/:id/precheck`、`PATCH /api/approvals/:id`
- `GET /api/ledger` 账本修订号；`GET /api/audit?entityId=AST-001-V8` 版本审计

## 测试

`npm test --workspace server` 覆盖：重复 checksum、跳号、并发登记（409）、旧版已进预检
（撤回被拒）、锁定后授权失效（改授权被拒且拒绝留痕）、重复请求幂等重放，以及
送审→通过→锁定状态机和不可覆盖的锁定历史。

当前使用内存数据，领域服务按模块设计，后续可替换 PostgreSQL、对象存储、工作流和版权方台账服务。
