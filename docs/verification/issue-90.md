# Issue #90：定时交付恢复与在途候选收尾验收

日期：2026-11-17（北京时间）。需求：[Spec #90](https://github.com/wangyingang/sing-box-config-manager/issues/90)，实现基于 `origin/main@6fc78fda5434acbae244477be45232a3531753a9`。分支为 `codex/issue-90`；交付停在 PR 待审阅阶段，工单保持 open，不执行生产操作。

## 已确认的恢复选择

按[用户确认的澄清](https://github.com/wangyingang/sing-box-config-manager/issues/90#issuecomment-6925949795)，已有当前交付时，先补齐原候选证据，再由正常最新输入检查决定一次交付。最新输入不可用时保留当前交付并报告失败。完整证据复验本身不要求重新获取该候选的固定输入，但不表示整次 sync 可以离线成功。

现有状态不能可靠区分“A 正在交付、B 更新中断”与“后来已观察到上游回退 A、旧实现 unchanged 却留下 B”。本次不新增持久 schema，也不按候选 ID、遍历顺序或恢复时间推断当前选择。没有当前交付且仅有一个有效在途候选时，仍可直接恢复并交付；已登记 pendingDelivery 的原稳定提交及 HTTPS 回读恢复不受此限制。

## 行为与验收边界

测试使用真实 `runRuleAutomation`、`syncRules`、`getRulesStatus`、`cleanupRuleHistory` 及 pin/resume 服务。复用 Git/HTTP/时钟外部边界与真实 sing-box 原生验证，不以固定返回值的业务服务 stub 替代恢复验收。

| 验收 | 本次观察到的结果 |
| --- | --- |
| A1 定时恢复 | 稳定提交后注入 HTTPS 回读失败，确认真实 pendingDelivery；新 context 的 schedule 清除原登记，继续 cleanup，同一次稳定交付不重复提交 |
| A2 未恢复与共享异常 | 持续回读故障仍失败并保留 pending；损坏、不可读、目标不符、无登记依据及混合共享异常只执行 status，不增加写入或 refs |
| A3 building 中断 | publishing 检查点提交失败留下原 building；单分支及 main/candidates 双分支均恢复原 ID，候选可选，真实 cleanup completed，重复运行无新增写入 |
| A4 全量 publishing | 双分支同源两规则的 metadata 提交故障各留下 publishing；两个原 ID 均 verified，不另建替代候选；同规则多记录由 A5 覆盖 |
| A5 旧残留与 unchanged | 同规则旧 building/publishing 全部补齐，当前交付记录及稳定 head 保持不变，候选数不增长；A→B→A 反例中 B 仅成为非当前完整版本，cleanup 实际完成 |
| A6 身份、时间与幂等 | 新 context 从持久状态恢复；未发布者在次日实际发布才首次赋时；已有证据恢复不改变 versionId/publishedAt；缺失版本检查点只从有效证据补回，冲突明确失败；重复 sync/cleanup 不重建或重交付 |
| A7 输入、意图与并发 | 固定 Release 恢复不取代为新来源，原输入缺失和工具 SHA 改变明确失败；新 pin 与旧恢复真实争用 CAS 时保留新控制；删除/重建、换源、pin/resume、配置权威和维护隔离既有回归通过 |
| A8 只读与门禁 | status 及四个写入口 dry-run 不改变写入/refs；更新 disabled 不解释为 pending 已清；维护未结束或 cleanup 门禁关闭时不开放上游与普通写入，继续沿用冻结计划 |
| A9 清理与证据 | 恢复后核对原 ID、verified、可选性及当前交付，再真实 cleanup；推进到 2026-12-18 后实际删除两个到期非当前候选，当前候选完整保留且可选；双布局保留边界、清理后 pin、未知时间/归属及真实在途 blocker 回归通过 |

额外覆盖已有当前交付时 latest 失败：原候选完整证据可以复验为 verified，原版本及时间保持；稳定交付不变，结果失败。上游恢复后重跑使用已恢复候选，不创建替代身份。多个旧候选的不同内容同样不按遍历顺序切换。

## 持久样本来源

- A1/A3/A4 及既有 metadata/evidence 回归由真实提交或 HTTPS 故障边界形成持久状态。
- `historicalResidues` 是基线行为等价样本：保存真实中断的 building/publishing 候选和不可变阶段，暂时隐藏在途索引，让真实 sync 产生后来的当前交付，再重组合 schema 合法记录。它模拟旧实现忽略 building 或第二 publishing 后的结果，不宣称整个样本由未修改的基线自然运行生成。
- A→B→A 样本保留真实 publishing 和原阶段，将 lastFailure 清除为旧 unchanged 等价检查点，验证不能据残留推断应交付 B。
- version/time 缺失兼容样本保留真实 readback，只移除 journal 对应字段；当前 publisher 会将证据和版本字段同次保存，因此不将此样本描述为当前原子提交自然形成的状态。已有登记与证据冲突时失败并保留记录。

## 本地验证

实现提交为 `4ad8d835409536ff2adde3762f7e210fc07bc438`，文件树为 `639195176f5c1e6595837de8d129003d6664acbe`。最终定向测试后没有修改实现或测试，本验收文档单独提交。Node.js `v26.13.0`、pnpm `10.33.2`、sing-box `1.14.4`；binary SHA-256 为 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。

在 `packages/rule-set-pipeline` 执行：

```sh
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 node --import tsx --test \
  test/integration/rules-recovery.test.ts \
  test/integration/rules-operations.test.ts \
  test/integration/rules-cleanup.test.ts \
  test/integration/rules-migration.test.ts \
  test/integration/rule-workflow.test.ts \
  test/rule-workflow.test.ts test/rules-context.test.ts
pnpm typecheck
```

结果：57 项通过（14 个新增场景、43 个既有回归），0 失败、0 取消、0 跳过；类型检查和 diff 检查通过。恢复测试覆盖真实原生编译、回读、原候选身份、稳定字节及实际清理结果。

初始 red 证据分别捕获 schedule 仅 status、building 被替代、同源第二 publishing 遗漏、unchanged 遗留 building。A→B→A 测试在临时推断方案下返回 delivered，移除推断后返回 unchanged。最终 57 项套件全通过；不把此前不同草稿的通过统计累加为最终覆盖。

原始日志、实施记录、工具及源码身份、SHA-256 清单保留在任务 worktree 的 `.verification/issue-90/`。`targeted-summary.json` 的范围为 `targeted-rules-recovery`，不是统一完整验收入口的 summary。本地未额外执行完整 workspace/native 或固定官方 Release 套件；PR 的完整 CI 和云端审查结果按覆盖 commit 更新到 PR/工单交付记录。

## 兼容与运行边界

保留现有五个入口、公开结果结构、journal schema、30 天保留策略及三份模块 ADR 的共享写入、失效回收和维护优先边界。不修改 agent-facing 指令或 #84/#85/#86 的历史验收事实。

恢复积压可能增加原固定输入读取、原生复验及证据提交；缺失输入、构建身份不符或证据不足仍明确失败。已有当前交付时不能离线确认新交付选择，是本次用户确认的限制。

没有生产转换、规则发布、历史重写、部署、开关变更或客户端配置修改。未观察真实原生 schedule 事件或邮件实收；本地原生编排测试不代表这些部署验收已完成。
