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

本地审查无未解决 findings。README 已补 cleanup、transport 入口及必填证据路径。修正探针已于北京时间 2026-11-18 完成真实隔离验收；通过后退役对应旧远端测试。


## 完整本地验证及基线对照

干净提交 `aa1293f5df8ac66c1fa0e93b4dd17756c87a9e36` 的统一入口通过，范围 `check-native`，tracked diff SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`：

```sh
node scripts/verify.mjs --out .verification/issue-98/complete --binary /absolute/path/to/sing-box-1.14.4
```

常规 386 项（tools 115、Compiler 99、Pipeline 172）、原生 270 项（Compiler 28、Pipeline 242），共 656 项全部通过，失败、跳过、取消和 todo 均为 0。typecheck、build、workspace/browser smoke 同轮执行；证据读取器核对文件大小与摘要通过。此前干净 `ad29e40` 的同范围验证也通过并保留为中间证据。

工具为 Node v26.13.0、pnpm 10.33.2、sing-box 1.14.4；binary SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。环境仍为 macOS arm64、Apple M2 Max，沿用 #94 的同一进程观测器及归类脚本，suite 统计仅调整输出目录。

| 同机测量 | 固定旧基线 `7075bfc` | 本轮 `aa1293f` |
| --- | ---: | ---: |
| 常规文件（tools / Compiler / Pipeline） | 6 / 12 / 21 | 6 / 12 / 20 |
| 原生文件（Compiler / Pipeline） | 8 / 26 | 8 / 18 |
| 常规 / 原生用例 | 396 / 307 | 386 / 270 |
| 真实路径或副本的原生调用 | 16,070 | 12,125 |
| wrapper 分组调用 | 114 | 22 |
| 常规检查 / 原生阶段耗时 | 43.497 / 251.773 s | 49.467 / 130.910 s |
| 总墙钟 | 295.514 s | 180.611 s |

此比较累计包含 #94—#98，不能把全部差值归因于本票。本票相对实施起点的原生用例净减少 1 项（删除旧 16 项、新增当前 guards 15 项），常规净减少 4 项；已有保留与恢复样本扩充到四集。wrapper 分组减少的 92 次来自旧 check-now 中仅改变可执行文件身份的转发 wrapper；真实跨工具恢复仍由 rules-cleanup-baseline 覆盖，原生能力故障矩阵未删除。每次调用的用途、退出码与耗时保留在进程明细；真实路径/副本、转发及故障 wrapper 的分类沿用基线，不重复计 shell 子进程。

测量期间另有隔离远端探针运行，墙钟可能受并发负载和系统噪声影响；这不是严格隔离的性能基准，也不承诺固定加速比。调用数量和实际执行范围单独记录，不用耗时下降替代覆盖证明。

完整本地验证之后，已完成的修改仅涉及远端验收断言、类型与目录筛选。旧远端测试在第四轮真实验收通过后退役。最新类型检查、真实隔离运行及 CI 覆盖提交分别记录，不把旧提交的完整验证当作后续全部变更已经同轮重跑。


## 真实隔离验收与远端退役

第四轮从干净提交 `c526b3591e772379d6712414cc5e89fb52b052c9` 运行显式 `test:acceptance:cleanup`，于北京时间 2026-11-18 00:24:46 完成。1/1 通过，失败、跳过、取消和 todo 均为 0，测试体约 1,673.027 秒。四集使用真实固定 Release/Git 来源、真实 GitHub 引用和 HTTPS，以及真实 sing-box 1.14.4；只用隔离应用时钟构造候选年龄，不冒充历史真实发布时间。

首轮 cleanup 注入 journal 阶段中断、原子切换拒绝、已切换但回复丢失及稳定 HTTPS 回读失败，随后用同一公开 cleanup 和同一维护身份恢复。第二轮改变 cutoff，继续保护当前与 pin、保留窗口内非当前版本。两轮实际只切换 2 次，保留的 6 个候选均可查询、原生复验并通过新地址读取完整七文件；域名边界版本和 CIDR 版本选择成功。交付记录仅允许证据地址重写，业务身份、首次发布时间、来源、订阅、control 与规则字节均保持。

测试在外部下载边界屏蔽旧历史 SHA 地址后继续验证新基线，不宣称 GitHub 已物理回收旧对象。真实管理分支的可达图已与旧历史分离；其他引用不删除。两次维护 ID、固定输入、每项操作、回读地址/摘要/长度及清理结果均保存在原始记录中。

| 轮次 / 受测提交 | 实际结果 | 隔离清理与生产对照 |
| --- | --- | --- |
| 1 / `bea41fd` | CIDR 来源 `fetch failed`，未进入 cleanup；不算通过 | remaining=[]、cleanupErrors=[]，生产前后相同 |
| 2 / `aa1293f` | Git 目录项被误当文件读取，检查器失败；不算通过 | remaining=[]、cleanupErrors=[]，生产前后相同 |
| 3 / `0cba8e9` | 已知目录断言错误后主动停止；不算通过 | 现有 leased transport 显式清空目标；仅具备终止后清理的生产前后对照，原轮完整对照未完成 |
| 4 / `c526b35` | 完整 cleanup 场景 1/1 通过 | remaining=[]、cleanupErrors=[]，生产 refs/Actions variables 前后相同 |

此前还修正了 pin 后结果重排、证据地址按契约重写及 TypeScript 推断错误；失败日志和对应提交全部保留，未把旧结果改记成新提交通过。第四轮开始后没有为小修正终止或并行启动新完整轮次。第四轮通过后直接退役、归档和交付，没有新增通用恢复框架。

独立 `test:acceptance:transport` 已真实运行 1/1 通过，保留原子更新、陈旧租约拒绝及隔离 refs 删除。默认 CI 与统一完整本地入口均不执行远端写入验收。

替代覆盖通过后，删除旧 `acceptance/maintenance-switch.test.ts` 与 `official-rulesets-lifecycle.test.ts`，不保留旧阶段别名。其历史命令保留在历史记录并链接当时源码；当前操作见模块 README。legacy workflow fixture 仍有 #101 的常规测试调用者，不在本票删除。运行时旧实现没有清理。

[evidence.tar.gz](issue-98/evidence.tar.gz) 包含完整本地验证、进程统计、工具/环境身份、定向及负向验证、两轴审查、四轮远端原始记录和所有清理证据；[manifest.json](issue-98/manifest.json) 记录归档摘要、源码身份、范围、统计及限制。后续最终 CI 与云端审查覆盖的 commit 更新到 PR/工单交付记录，不为刷新状态新增源码提交。

第四轮目标 `acceptance-issue-98-c7ba020f-8b0c-47f6-b313-474b9f828002`；维护 ID `c37e1e87-e8d8-4876-a12b-5bff8ae45b09`、`c6193e75-06a6-45ed-87d5-816a5a761241`；归档独立 HTTPS 回读 108 条。源码身份和 probe SHA-256 以原始 JSON 为准。
