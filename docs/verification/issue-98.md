# Issue #98 cleanup 测试迁移

实施起点：`1f9ad68`。父 Spec #93；固定旧基线 `7075bfc3f6a900c67a07e32e53e5a8aabc4ed1b4` 的同机证据复用 [#94](issue-94.md#整理前测量与验证) 和 [before.tar.gz](issue-94/before.tar.gz)。本映射先于测试编辑保存；下列目标通过后才删除对应旧断言。

## 旧断言 → 当前契约 → 迁移落点

| 旧测试及独立变体 | 当前契约与目标测试 | 退役依据 |
| --- | --- | --- |
| maintenance-sources：两种布局的四集双来源、CIDR 七文件、source/固定版本/稳定字节、旧地址失效、两轮清理、后续选择 | rules-cleanup：四集含 CIDR 的窗口、截止边界、当前/pin 豁免、多轮清理、旧证据屏蔽后 status/pin；实际来源及完整文件核验 | 人工 enter/prepare/switch、只留当前、旧 rebuild/rollback 索引由 ADR 0002 替代 |
| maintenance-sources：稳定入口未决写入 | rules-cleanup：真实 pendingDelivery 直接阻塞 cleanup，恢复后可清理 | 不使用旧 activation 索引 |
| check-now：维护重新确定当前/pin、过期任务拒绝；维护期间拒绝 resume/上游 | rules-cleanup 的保留计划、维护期间三种操作零写入及 resume 零上游读取；迟到 sync/pin 不覆盖新事实 | 人工 abort/resume 阶段与旧提交次数退役 |
| check-now：候选 files/metadata/evidence 在途阻塞 | rules-recovery 的 building 检查点；rules-cleanup 的 files/metadata/evidence 三种真实中断阻塞 | 保留真实登记，不伪造成功候选 |
| check-now：隔离提交后断线、稳定 head 移动 | rules-cleanup 的隔离回执丢失续做与外部 head 冲突保护 | 单 cleanup 恢复同一维护计划 |
| check-now：两布局 resume 提交后中断、来源失败保持恢复、兄弟不变、维护预览 | rules-operations/rules-selection 的 resume/pin 恢复与兄弟保护；rules-cleanup 未决交付/在途候选阻塞 | 旧 resume-check-pending 和 latestChecks/processed 字段随双暂停退役；auto 来源失败本身不应阻塞安全清理 |
| check-now：两布局新基线 HTTPS 中断、旧地址屏蔽、当前/来源/订阅/工具身份 | rules-cleanup 四集恢复与身份/稳定字节；rules-cleanup-baseline 的跨工具恢复 | 旧处理索引及固定三候选数退役 |
| check-now：两布局原子切换拒绝、回复丢失、稳定 URL 中断、核验检查点断线、临时 refs 删除失败、恢复不重复切换 | rules-cleanup 的故障恢复矩阵与冻结计划 | 不要求调用者选择维护阶段 |
| check-now：两布局两轮清理、pin/兄弟集、旧 sync/status 在途、新历史继续使用 | rules-cleanup 四集多轮清理、旧 sync 被隔离及只读 status；窗口内非当前版本仍可选 | 旧 history commit 参数及本地索引退役；查询无需保证返回最新并发快照 |
| check-now：人工激活 HTTPS 回读跨越 cleanup | rules-cleanup：pin 回读屏障，较新 pin 完成再 cleanup，迟到会话不覆盖 journal/稳定字节/heads | 当前远端事实替代本地回执 |
| remote-status：未归属稳定文件延期；维护预览固定保护 | rules-cleanup：未归属文件原样保留且零写入；四集当前/pin 豁免 | 其余历史解析与 SRS-only 留给 #99，分段删除这两项 |
| maintenance 常规 suite：前两项调度/维护入口 | 退役；当前调度已由 rule-workflow 与 rules-recovery 覆盖 | 旧 periodDays/startAt/人工恢复退役 |
| maintenance 常规 suite：后三项临时分支回复丢失/冲突、继承内容篡改、原子租约/不支持 atomic | 移至 maintenance-transport.test.ts，原断言完整保留 | transport 能力继续有效 |
| maintenance-switch 远端：切换回复丢失、HTTPS 回读失败、同一维护恢复/一次切换/临时 refs 清理 | acceptance/rules-cleanup：四集双来源、真实 Git/HTTPS、两种中断及恢复 | 新探针实际通过后退役 |
| official-rulesets-lifecycle 远端剩余清理：四集来源、pin/稳定字节、旧证据失效、后续使用 | acceptance/rules-cleanup：四集含 CIDR、多版本保留、完整证据/稳定 HTTPS、保留版本 pin | 只留当前/旧 rollback 被当前窗口契约替代；业务同步部分已由 #96 迁移 |
| maintenance-refs 远端 | 独立 test:acceptance:transport 入口保留 | 原子引用与租约能力独立于业务入口 |

## 执行状态

迁移删除前，两个本地 cleanup 文件 19/19 通过；补充新基线 HTTPS、外部 head 和 PublicationWriteError 故障验证 4/4 通过；transport、历史状态、当前工作流定向检查 26/26 通过。失败、跳过、取消和 todo 均为 0；typecheck 通过。较早测试预期错误的失败日志保留，不算通过。

替代覆盖通过后删除旧 maintenance-sources 与 check-now 全文件。旧 maintenance 常规 suite 的三个 transport 保护完整移至 maintenance-transport（原 suite 后三项），旧调度/维护入口两项退役。remote-status 仅删除已迁移的未归属文件和人工维护预览两项，保留 #99 的历史解析、SRS-only 与损坏拒绝。

旧维护期间禁止所有上游访问的断言不直接移植：当前 sync 在无待写配置变化时可能先读取输入，实际写入仍被 maintenance guard 拒绝；resume 在解除 pin 的写入被拒绝后不访问上游。新测试按五操作当前契约核验，不修改运行时行为。

负向验证将保留窗口比较临时从 `>= cutoff` 改为 `> cutoff`，四集测试在预览集合处失败：恰好边界的域名和 CIDR 两版本被错误排除。恢复原文件后继续验证；运行时源码最终 diff 为空。日志归档到本票证据。

## Standards

本地首轮审查 1 项 P2：旧 sync 若在到达上游屏障前失败，测试可能无限等待。已让 pin/sync 的等待同时观察操作提前结束，并给 sync 竞争场景设置 90 秒超时。注入“读取配置即失败”后，两种布局在约 2 秒明确报错，不再挂起；恢复后四个 pin/sync 交错场景 4/4 通过，typecheck 通过。原有 transport 三项断言完整保留，未发现其他规范问题。

## Spec

本地审查无未解决 findings。README 已补 cleanup、transport 入口及必填证据路径。远端探针尚在执行，旧远端测试仍保留；不把本地全绿当作真实远端验收完成。
