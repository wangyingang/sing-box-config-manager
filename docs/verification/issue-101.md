# #101 验证入口与覆盖核对

2026-11-18。核对范围为父 Spec [#93](https://github.com/wangyingang/sing-box-config-manager/issues/93) 的 T1–T7，固定旧基线 `7075bfc3f6a900c67a07e32e53e5a8aabc4ed1b4`，本票实施起点 `3b29ea5`。

## 旧集成断言去向

15 个旧 suite 共 188 项。下表按旧文件索引逐项映射。链接内保留独立故障、参数变体、替代断言和退役依据。跨票的步骤以最后处理对应段落的记录为准。

| 旧 suite | 基线项数 | 当前覆盖与退役依据 |
| --- | ---: | --- |
| check-now | 37 | [#96 同步、恢复与竞争](issue-96.md#旧断言逐项映射编辑前)、[#98 维护和交付交错](issue-98.md#旧断言--当前契约--迁移落点)。旧双暂停、单集筛选、人工维护阶段及本地回执随旧契约退役。 |
| configured-activation | 33 | [#94 候选证据、pin、响应丢失与兄弟集字节](issue-94.md#旧断言逐项去向)。当前同版本 pin 幂等，以远端事实核实写入。 |
| configured-rollback | 12 | [#94 版本选择、旧来源和损坏拒绝](issue-94.md#旧断言逐项去向)。选择使用保留候选和 versionId，旧历史激活 commit 参数退役。 |
| maintenance-sources | 3 | [#98 四集多轮清理与未决交付保护](issue-98.md)。保留期、当前及 pin 豁免取代只留当前候选的要求。 |
| check-sources | 8 | [#96 双来源与故障影响范围](issue-96.md)、[#95 固定输入](issue-95.md)。pinned 期间继续构建和单集 check 筛选退役。 |
| china-ip-delivery | 6 | [#94 版本选择、证据和并发](issue-94.md)、[#97 真实 CIDR 客户端与缓存](issue-97.md)。未交付候选若仍保留且合格，可被 pin。 |
| configured-update | 17 | [#95 固定来源和工具身份](issue-95.md)、[#96 四集输入、独立失败、constructor 和重复同步](issue-96.md)。旧 processed 索引、单集增选与公开 retryRelease 退役。 |
| update | 17 | [#95 固定资产身份、恢复、故障及无变化](issue-95.md)、[#94 损坏候选](issue-94.md)。恢复保留原候选身份，旧本地索引退役。 |
| remote-faults | 21 | [#94 保留对象和文件证据拒绝](issue-94.md)、[#95 断线、共享状态与并发写入](issue-95.md)。旧本地缓存不可写和旧阶段计数随旧状态模型退役。 |
| china-ip-candidate | 10 | [#95 已登记候选按固定 Git commit 恢复及输入失败](issue-95.md)。旧公开固定 commit rebuild 退役。 |
| rebuild | 8 | [#95 工具变化、buildId 与固定输入](issue-95.md)、[#96 确定性规则字节和历史回读](issue-96.md)。旧公开 rebuild 与本地成功索引退役。 |
| remote-legacy-recovery | 9 | [#99 九项旧单集运行流程逐项映射](issue-99.md#旧单集运行流程的逐项去向)。只读解析及一次性转换继续覆盖历史状态。 |
| remote-recovery | 5 | [#95 原候选恢复、工具路径与关联事实校验](issue-95.md)。旧指定失败集与固定 Release 强制重试退役。 |
| remote-status-binary | 1 | [#99 真实 SRS-only 历史快照](issue-99.md)。旧 status 原生字段和 rollbackTargets 退役。 |
| activation-client | 1 | [#97 同一进程、同一稳定 URL 的真实 DNS/Route 更新](issue-97.md)。用 sync、pin 和 resume 驱动。 |

### 常规测试与 fixtures

- [#100](issue-100.md) 删除 legacy-workflow 的七项旧编排测试和最后一个调用者，移除 `fixtures/legacy-workflow.ts`。稳定 URL 与各用途复用断言迁入 `rule-subscriptions.test.ts`。
- [#98](issue-98.md) 将 maintenance 的临时 refs、继承内容和原子租约断言移到 `maintenance-transport.test.ts`。旧调度由 `rule-workflow.test.ts` 及当前恢复覆盖替代。
- 旧 remote-status、remote-state 的有效证据与状态保护分别落在 [#94 查询与版本选择](issue-94.md)、[#98 未归属文件与清理](issue-98.md)、[#99 历史解析与转换](issue-99.md)。常规 update/rebuild 的旧本地锁、参数和成功索引退役，当前缺失／损坏状态见 `rules-state.test.ts` 和 [#95](issue-95.md)。旧 china-ip-cli 更名为 `china-ip-build.test.ts`，原断言沿用。
- [#99](issue-99.md#共享-fixture-清理条件) 删除了最后已无调用者的 `configured-activation-fixture.ts` 和 `publication-repository.ts`。`fixtures/historical/` 供历史解析与一次性转换使用；`test/fixtures/20261102130044.conversion-report.json` 仍为 #15 历史验证记录的证据。固定 Release 样本仍用于现行普通、原生或只读验收。当前测试树已无旧 workflow 及其三个共享 fixture。

### 关键覆盖的当前定位

- `test/integration/rules-{operations,selection,inputs,source-recovery,recovery,performance,cleanup,cleanup-guards,cleanup-baseline}.test.ts` 覆盖五操作、固定来源与恢复、并发和相互隔离、交付准备与回读故障。七阶段的提交中断与响应丢失矩阵、四集首轮恰 29 次写入的断言保留在 `rules-performance.test.ts`。
- `test/integration/native.test.ts`、`rules-domain-client.test.ts`、`rules-cidr-client.test.ts` 和 `client-failure-recovery.test.ts` 保留真实原生能力、两个同进程更新场景，以及独立失败和缓存覆盖。订阅兼容与一次性转换见 `test/rule-subscriptions.test.ts`、`test/historical-records.test.ts`、`test/integration/rules-migration.test.ts`。transport 继续有常规和隔离远端入口。

## 入口与隔离证据

`test:release` 与 `scripts/verify.mjs --release` 都选取 `release.test.ts` 和 `configured-release.test.ts`。旧 publication、activation、rollback、rebuild 的包脚本和业务验收文件已删除。当前四个远端写入入口仍需显式门禁。

| 入口 | 既有实测及受测身份 | 退役或保留范围 |
| --- | --- | --- |
| `test:acceptance:rules` | [#96 第七轮](issue-96.md#完整真实-github-结果与远端退役)，`1527f51`，1/1，588 条 HTTPS 回读 | 旧 publication、configured-publication、configured-activation、configured-rollback、rebuild、configured-rebuild，以及 official-rulesets-lifecycle 的同步和版本选择部分。 |
| `test:acceptance:cleanup` | [#98 第四轮](issue-98.md#真实隔离验收与远端退役)，`c526b3591e772379d6712414cc5e89fb52b052c9`，1/1 | 旧 maintenance-switch 及 official-rulesets-lifecycle 的剩余清理行为。 |
| `test:acceptance:automation` | [#100 第四轮](issue-100.md#真实隔离验收)，`6af9fe468d34a00921ceb40ee78e6dc9f1375804`，1/1 | 保留实际 push、dispatch 与旧事件重跑，显式核验受审查分支与 SHA。真实 schedule 和邮件实收仍缺观察。 |
| `test:acceptance:transport` | [#98 独立原子引用与租约验收](issue-98.md#真实隔离验收与远端退役)，1/1 | 保留 maintenance-refs，验证原子更新、陈旧租约拒绝、隔离 refs 删除。 |

三个业务探针的成功轮均有隔离目标回收与生产状态对照。本票只调整 Release 文件选择与说明，复用对应受测提交的远端证据。保留 #107 已合并的调度：PR／main push 默认工作区检查，手动 `full_native=true` 或每日运行执行原生 job。变更检测、冻结锁文件安装、原生版本和摘要核对、日志归档均沿用。统一入口缺少原生 binary 时在预检失败；CI 和统一完整本地检查均不调用远端写入入口。

## 本次定向验证

执行时工作区基于 `3b29ea53698eed21574a5c7e1eab65d74ee447ec`，已应用本票的 `test:release` 脚本改动。Node v26.13.0、pnpm 10.33.2；sing-box 1.14.4 的 binary SHA-256 为 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。

| 命令 | 结果 | 日志 SHA-256 |
| --- | --- | --- |
| `pnpm --dir packages/rule-set-pipeline test:release`（指定上述 `SING_BOX_TEST_BINARY`） | 退出码 0，实际下载和原生构建 2/2 通过，约 35.55 秒。[日志](issue-101/release.txt) | `b0e452d2511cb7bbb031d8ed8378c1def4fd8a27a9022ca4ec84362f40316633` |
| `node --test --test-name-pattern='selects only the read-only Release tests' scripts/test/verify.test.mjs` | 退出码 0，1/1 通过。临时 fixture 核对 `--release` 的选择范围及其与包脚本的一致性，未启动仓库全套检查。[日志](issue-101/verify-release.txt) | `99a4114750621c5cf0cedc4a957466f874b84a819fcc8195f4924cd6923a8c28` |

两次定向运行的失败、跳过、取消和 todo 均为 0。

## 测量与余项

[#94 旧基线](issue-94.md#整理前测量与验证)与 [#99 同环境测量](issue-99.md#同环境测量)保留原始方法、环境、按用途的原生调用分布和主要 suite 测试体耗时。两次都用 macOS arm64、Apple M2 Max、Node v26.13.0、pnpm 10.33.2、sing-box 1.14.4，范围是常规检查加完整原生集成。

| 指标 | 旧基线 `7075bfc` | #99 受测提交 `efc4b59` |
| --- | ---: | ---: |
| 测试文件（工具 / Compiler 常规 / Pipeline 常规 / Compiler 原生 / Pipeline 原生） | 6 / 12 / 21 / 8 / 26 | 6 / 12 / 20 / 8 / 16 |
| 测试项 | 703 | 654 |
| 直接原生调用 | 16,070 | 11,810 |
| 故障 wrapper 调用 | 114 | 22 |
| 常规检查 / 原生集成 | 43.497 s / 251.773 s | 47.854 s / 135.311 s |
| 总墙钟 | 295.514 s | 183.392 s |

旧基线 [CI 运行](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43955404685) 的 Workspace checks 为 69 s，Native sing-box 为 575 s。主机负载、文件并发和执行范围变化均影响耗时。#99 数字仅用于历史对照，未包含 T7 与本次收尾；Linux CI 和本机结果分别解读。

前次收尾受执行限制，未运行最终完整本地验证、同环境全量测量或 CI；上述历史快照和定向验证只证明各自记录的源码与范围。2026-11-18 按维护者补充授权完成的回归与对比见下节。


## 2026-11-18 最终完整回归与提速核验

受测源码为干净的 `6766f1801969483db88f1e9857aded0688cba836`，已包含 #94—#101 全部迁移和退役变更。本次后续提交只补充本文与证据，不修改测试、业务实现、CI 或生产设置。#101 和父 Spec #93 已由维护者在前次收尾时关闭，本节补齐当时明确留下的完整回归与性能证据，不将“已关闭”作为通过依据。

### 范围与可复查证据

本地运行 README 指定的统一入口，范围为 `check-native`：

```sh
NODE_OPTIONS=--import=<evidence>/baseline/observe-processes.mjs \
RULE_TEST_PROCESS_LOG=<evidence>/final-processes.jsonl \
node scripts/verify.mjs --out <evidence>/final --binary <absolute-sing-box-1.14.4>
```

固定旧基线继续使用 #94 的 `7075bfc3f6a900c67a07e32e53e5a8aabc4ed1b4`，未重复建立基线。旧证据与本次证据分别经 `inspect-evidence.mjs` 校验，原运行结果、文件大小与 SHA-256 均通过（各 1/1）。完整日志、客户端证据、原生进程明细、归类脚本、测试文件清单、suite 测试体耗时和工具身份见 [本次证据归档](issue-101/final-20261118/evidence.tar.gz)；[归档清单](issue-101/final-20261118/manifest.json) 记录归档摘要与归档内文件摘要，[比较摘要](issue-101/final-20261118/comparison.json) 可直接读取。

两次使用相同的 macOS 27.2.1 arm64、Apple M2 Max（12 核、32 GiB）、Node v26.13.0、pnpm 10.33.2、sing-box 1.14.4。binary SHA-256 均为 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。沿用 #94 原观察器，SHA-256 为 `05b66ab1853025cec5aa6e6564d4dae61ea63cd8d810053f57e9c73d3b9f8b4a`；只观察 child_process 调用，不改变原生命令参数、字节或退出状态。

本轮没有运行 Release 下载验收或任何远端写入验收。Release 的两项只读结果仍见上文；T3/T5/T7 的隔离远端证据沿用前表。没有修改生产配置、启停用户的 sing-box 服务、修改生产开关或运行生产 sync/cleanup/迁移。

### 完整本地结果与同环境对比

本次 707 项全部通过：工具 167、Compiler 常规 99、Pipeline 常规 175、Compiler 原生 28、Pipeline 原生 238；失败、跳过、取消、todo 均为 0。源码 clean，tracked diff SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。

| 指标 | 固定旧基线 `7075bfc` | 最终源码 `6766f18` | 变化 |
| --- | ---: | ---: | ---: |
| 测试文件（工具 / Compiler 常规 / Pipeline 常规 / Compiler 原生 / Pipeline 原生） | 6 / 12 / 21 / 8 / 26 | 7 / 12 / 21 / 8 / 16 | Pipeline 原生文件减少 10 个 |
| 常规测试项 | 396 | 441 | +45 |
| 原生测试项 | 307 | 266 | −41 |
| 测试项合计 | 703 | 707 | +4 |
| 常规检查 | 43.497 s | 78.121 s | +34.624 s |
| 原生集成 | 251.773 s | 134.998 s | −116.775 s（−46.4%） |
| 完整入口总墙钟 | 295.514 s | 213.361 s | −82.153 s（−27.8%） |
| 直接 binary／副本调用 | 16,070 | 11,810 | −4,260（−26.5%） |
| 故障 wrapper 调用 | 114 | 22 | −92 |

检查层级相同，但执行集合按迁移目标发生变化：旧有效断言迁入当前测试，旧契约断言退役，同时增加了工具与自动化探针测试。工具用例增加 52 项，其中新增 `scripts/test/pr-closeout.test.mjs`；不能将常规阶段变慢或总墙钟变化全部归因于旧测试删除。两端 Compiler 和 Pipeline 的 `src/` 无差异，本次没有修改运行时算法来降低调用量。

本次相对固定旧基线，完整检查节省约 1 分 22 秒；原生阶段节省约 1 分 57 秒。这是 #94—#101 累计整理后的实际观测，不是单独 #101 的收益。它也不同于 #107 把全量测试移出逐次提交的等待时间收益。两端各一轮、旧基线取自归档，未做多次抽样；主机负载和文件并发有噪声，不能据此承诺固定百分比或耗时。

### 原生调用用途与主要 suite

直接 binary／副本调用包含统一入口预检和负向场景；故障 wrapper 单列，不将 shell 内部子进程再加一次。

| 用途 | 旧基线直接调用 | 最终直接调用 | 旧 wrapper | 最终 wrapper |
| --- | ---: | ---: | ---: | ---: |
| version | 3,264 | 2,384 | 28 | 8 |
| rule-set compile | 3,113 | 2,267 | 25 | 7 |
| rule-set decompile | 3,114 | 2,268 | 24 | 6 |
| rule-set match | 6,423 | 4,731 | 37 | 1 |
| schema | 74 | 76 | 0 | 0 |
| check | 77 | 79 | 0 | 0 |
| run | 5 | 5 | 0 | 0 |

原生 `schema/check/run` 覆盖没有随旧 suite 退役而减少。旧基线最长的顶层测试体合计为 check-now 246.843 s、configured-activation 115.325 s、maintenance-sources 92.979 s。最终最长的六个 suite 如下；其全部动态名称均匹配到受测源码，未匹配数为 0。

| 最终 Pipeline suite | 顶层测试体合计 |
| --- | ---: |
| rules-cleanup | 130.238 s |
| rules-selection | 113.973 s |
| rules-inputs | 101.296 s |
| rules-cleanup-guards | 87.663 s |
| rules-performance | 66.080 s |
| rules-operations | 65.349 s |

上述数值是日志中的顶层测试体时间总和，不含启动；不同文件并发执行，不能相加作为完整检查墙钟时间。迁移前后 suite 职责变化，旧 suite 与新 suite 也不是逐行一对一的速度比较。

### GitHub Actions 全量回归

[本次手动全量运行 44160005864](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44160005864) 使用任务分支上的受测源码 `6766f18`，显式 `full_native=true`；Detect changes、Workspace checks、Native sing-box 均实际执行且成功。原生 Compiler 28 + Pipeline 238 = 266 项通过，零失败／跳过／取消／todo。工作区命令成功，但其中两个既有 build 测试因该 job 不提供 binary 而跳过（441 项中 439 通过、2 跳过）；本地显式 binary 的 441 项结果已覆盖这两项，不把 CI 工作区成功称为无跳过的完整本地验证。

与 [固定旧基线运行 43955404685](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43955404685) 分别按 job、step 和整轮比较；两次均为 ubuntu-24.04、Node 24、pnpm 10.33.2、sing-box 1.14.4，安装、版本／摘要检查和日志步骤保留。GitHub 托管 runner 不是同一台物理机器，环境调度噪声与本机测量分开说明。

| CI 指标 | 旧基线 | 最终源码 | 变化 |
| --- | ---: | ---: | ---: |
| Workspace checks job | 69 s | 74 s | +5 s |
| Check workspace step | 47 s | 62 s | +15 s |
| Native sing-box job | 575 s | 458 s | −117 s（−20.3%） |
| Run native integration tests step | 547 s | 416 s | −131 s（−23.9%） |
| 整轮墙钟 | 585 s | 463 s | −122 s（−20.9%） |

整轮墙钟统一取 `run_started_at` 到最后一个 job 的 `completed_at`；原始 run、job 与全部 step 时间戳均在归档中，摘要另见 [CI 对比](issue-101/final-20261118/ci-comparison.json)。旧事件为 main push，本次为显式全量 dispatch；两次都执行常规与原生检查，但调度／取消策略已按 #107 更新，所以整轮降幅同时包含编排差异。原生测试 step 的对比更接近测试集合本身的执行成本；它也不能与 macOS 秒数混算。

### 验收结论与边界

本次补齐 #101 的完整本地回归、同环境工具与调用统计、主要 suite 耗时，以及真实双 job CI 和 step/job／墙钟对照。结果支持“迁移并退役旧测试降低了重复原生调用和完整回归时间”，不支持固定耗时承诺，也不表示全部常规检查都变快。

后续文档 PR 的 head 只增加验收记录和证据；本节完整回归与全量 CI 的受测提交固定为 `6766f18`，不将其冒称为后续文档提交已重新全量执行。PR 最新 CI 与云端审查状态更新在 PR 和 #101 交付评论中。真实 schedule 与邮件实收仍沿用 #100 的未观察边界，不属于本次本地回归／性能补验；本次没有执行生产操作。
