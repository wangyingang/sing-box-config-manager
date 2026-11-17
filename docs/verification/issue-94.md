# #94 候选查询与 pin 测试迁移

2026-11-17。原始映射先于测试编辑保存，固定基线为 `7075bfc3f6a900c67a07e32e53e5a8aabc4ed1b4`。本票处理 [#94](https://github.com/wangyingang/sing-box-config-manager/issues/94)，对应父 Spec #93 的 M1、M4 查询和 M5 pin 竞争，不代表父 Spec 整体完成。

## 当前覆盖定位

以下测试位于 `packages/rule-set-pipeline/test/integration/rules-selection.test.ts`，按完整测试名定位：

| 标识 | 测试名及断言 |
| --- | --- |
| S1 | `候选证据边界逐项拒绝损坏；status 只读且 pin 保留当前及兄弟集字节`：19 个独立变体，检查拒绝原因、不可选、heads、写入数与全部稳定字节 |
| S2 | `摘要随 SRS 篡改更新仍过不了真实原生 pin；域名与 CIDR 当前及兄弟集不变`：结构验证先通过，再由真实 sing-box 重新编译、反编译、加载及字节比对拒绝，两类规则分别验证 |
| S3 | `域名与 CIDR 按版本重选只改变目标；重复 pin 幂等且停止全部上游`：恢复原 source/字节，兄弟集记录及文件不变，重复 pin 不写入／不换控制，两个上游均零读取，旧不可变快照不变 |
| S4 | `候选不在保留登记中时，旧不可变地址仍能下载也不能查询或 pin`：旧地址可读不构成可选择依据，status 不列出，pin 拒绝且零写入 |
| S5 | `当前订阅或交付损坏时拒绝 pin；订阅字段顺序不改变契约`：14 个错误变体和字段重排成功；损坏当前记录／稳定字节时 status 失败，不兼容订阅时无可选候选，pin 均不写入 |
| S6 | `status 报告残缺候选但不补证据、不读上游、不推动恢复`：files/metadata/evidence 三阶段中断，查询保留 current，列出不可选在途候选；journal、heads、上游读取与写入均不变 |
| S7 | `合格但从未交付的保留候选可以 pin，其他规则的版本不能冒用`：准备失败后 verified 候选无稳定写入，status 可选，跨规则 pin 失败，本规则成功且兄弟集不变 |
| S8 | `<target>: 不同规则的 pin 竞争同一 head，失败方不覆盖成功方`：登记前屏障制造两个真实 CAS 竞争，恰好一个成功，失败方保留原版本和 auto |
| S9 | `<target>: pin 响应丢失先核实远端，查询不恢复且重试不重复交付`：registration/applied/not-applied/unknown/readback；依据 writeId 或交付回执核实，查询零写入，换会话重试最终只写一次稳定文件，总共只提交登记、稳定交付和收尾三次 |
| S10 | `<target>: 较新的 pin 取代响应未知的旧 pin，迟到会话不能覆盖`：新 pin 在旧响应返回前完成，迟到会话保留新 heads、全部稳定字节和控制修订，后续 sync 不重放 |
| S11 | `<target>: pin 写入前配置、维护、代次或 head 变化不会被旧会话覆盖`：configuration/maintenance/generation/head；外部权威改变后旧操作不切换稳定文件，不覆盖对方 head |
| S12 | `当前候选证据丢失或损坏时 status 保留真实交付，候选不可选且不写入`：缺失／损坏 readback 两个变体；current、deliveryState、稳定 URL、控制和字节保留，该候选不可选，journal、heads、读取和写入均不变 |

S8—S11 均执行共享分支 `acceptance-selection` 和双分支 `main` 两种内存 Git 布局；`main` 只模拟布局，不访问 GitHub 产物。S1 在已有 `verifyCandidateEvidence` 边界集中校验，四个代表性错误再经当前 `pinRuleVersion` 拒绝，不为每个结构错误重跑四集生命周期。status 仍是结构检查，摘要自洽但无效的 SRS 由 S2 证明原生 pin 拒绝，没有新增 status 原生复验承诺。

## 旧断言逐项去向

| 旧文件及变体 | 当前契约与落点 | 退役／保留条件 |
| --- | --- | --- |
| configured-activation：逐集切换 | 当前 pin 选择保留版本，目标及兄弟集稳定字节逐项比对 | 新 pin 覆盖通过后删除 |
| configured-activation：wrong-set、duplicate-ids、missing、extra、evidence、srs | 候选证据验证边界集中错误矩阵；当前 status 与 pin 拒绝 | 新边界及拒绝交付覆盖通过后删除 |
| configured-activation：native | pin 使用真实 sing-box；缺 binary 失败 | 新 pin 原生覆盖通过后删除 |
| configured-activation：usage、capability、reuse、path、v1 | 当前订阅与稳定路径契约；不能接受损坏或不兼容交付 | 新 status/pin 契约矩阵通过后删除 |
| configured-activation：old-record、old-bytes | 损坏当前记录／字节停止写入 | 当前规则操作及新 pin 断言通过后删除 |
| configured-activation：applied、not-applied、unknown、superseded、readback、registration | 当前 pin 通过 writeId、交付回执和远端 head 核实；status 只读 | 新 pin 故障矩阵通过后删除 |
| configured-activation：receipt | 本地回执不再参与当前五操作 | 按 ADR 0001 退役 |
| configured-activation：rejected | 远端未应用时保留当前，登记未决操作后按当前契约恢复 | 新 pin not-applied 覆盖通过后删除 |
| configured-activation：双分支 maintenance、generation、head；不同集竞争 | 当前配置、维护、代次、head 与 CAS 保护 | 新 pin 竞争覆盖通过后删除 |
| configured-activation：同候选新决定、再次指定必须换修订 | 重复 pin 同版本幂等；新版本决定取代旧操作 | 幂等覆盖通过后退役旧修订要求 |
| configured-activation：订阅字段顺序 | 顺序不改变既有订阅语义 | 迁到当前 pin 后删除整文件 |
| configured-rollback：逐集历史选择；换列表后选择旧来源 | pin 可选任何仍保留、合格的版本，包括旧来源 | 复用 rules-operations 换源失败／旧来源重选；新双格式版本选择补字节和兄弟集断言 |
| configured-rollback：other-set、wrong-identity、missing-candidate、candidate-bytes、subscription、native、stale-head | 当前规则身份、证据、订阅、原生和并发保护 | 替代覆盖通过后删除 |
| configured-rollback：history-json、history-bytes、historical-candidate | 不再用历史激活 commit／本地索引选择；以候选及 versionId 为准 | 退役旧回滚索引，保留候选证据拒绝 |
| china-ip-delivery：前三组非客户端测试（4 项） | CIDR pin、契约、证据、响应丢失 | 双格式当前 pin 覆盖通过后删除这些段落 |
| china-ip-delivery：同一真实客户端 | #97 负责 M7 | 保留测试及必要准备 |
| china-ip-delivery：未交付候选不可回滚（末项） | 合格且保留、尚未交付的候选可 pin | 新未交付候选可选择覆盖通过后退役 |
| remote-faults：retained、domains.srs、build.json、readback.json、changed-current-bytes | 缺失或替换的保留证据不可选，pin 不交付 | 新边界与 status/pin 覆盖通过后删除该组 |
| remote-faults：三阶段响应丢失、缓存、代次／维护／head、缺状态组 | #95 的恢复范围，非本票删除对象 | 原段落保留，避免提前退役 |
| remote-status：SRS-only 首项 | #99 一次性历史转换 | 保留样本及历史读取 |
| remote-status：8 种订阅／文件记录错误，以及当前稳定字节／非法历史记录（含 2 个变体） | 当前行为由 S5 覆盖；旧 `activationRecord` 仍被一次性转换使用 | 保留给 #99：新 schema 的 S5 不能代替旧解析器的损坏拒绝 |
| remote-status：空状态、待核实当前、有效历史版本、缺／坏证据与残缺阶段 | 当前 status 的 current/candidates/pendingOperation，零写入且不恢复；已交付候选证据故障明确由 S12 覆盖 | 新 status 覆盖通过后删除对应段落 |
| remote-status：历史订阅缺失／不兼容、旧对象仍存在、非法历史索引 | 版本选择看保留候选，不看旧 rollbackTargets／historyComplete | 候选覆盖通过后退役旧字段要求 |
| remote-status：未归属稳定文件、维护预览 | #98 清理范围 | 保留测试和必要准备 |

S1 变体的独立去向：

| 当前变体 | 旧来源／独立边界 |
| --- | --- |
| wrong-rule、build-identity、build-target | activation wrong-set；rollback other-set/wrong-identity；规则身份和构建目标 |
| duplicate-artifact、extra-artifact | activation duplicate-ids/extra；Manifest 身份唯一和精确产物集合 |
| missing-domains.srs、missing-build.json、missing-readback.json | activation missing；rollback missing-candidate；remote-faults 三个缺文件变体 |
| missing-readback、registered-digest | activation evidence；CIDR 已登记证据摘要；status 残缺证据 |
| readback-digest、readback-length、manifest-digest、manifest-length、build-digest | activation srs；rollback candidate-bytes；各层字节长度和摘要一致性 |
| retained-replacement | CIDR 和 remote-faults changed-current-bytes；不可变地址与保留树必须相同 |
| usage、capability、projection-mapping | activation usage/capability/reuse；投影完整性和能力约束 |

同时更新全部摘要后的无效 SRS 单独归 S2。旧 retained=false／保留树移除归 S4。旧 activation path/v1 和 rollback subscription 归 S5；当前五操作从正式配置派生订阅，不接受旧 activation 调用方传入的订阅覆盖。旧 rollback 的 history-json/history-bytes/historical-candidate 退役理由只适用于旧历史 commit 选择入口；转换仍使用的当前历史记录解析测试留给 #99。

旧首次空查询的零写入复用 `test/rule-workflow.test.ts` 的 `workflow status reads production without acquiring a write capability`；旧来源重选复用 `integration/rules-operations.test.ts` 的 `换源失败保留交付但撤销 pin；别名保持 pin；旧来源可明确重选`，其中也已有重复 pin 零写入断言。候选代次和已删除定义保护由同文件的 `混合新增换源删除独立完成；空集合删除全部；重加不继承固定` 覆盖。S8/S11 补齐 pin 自身竞争，已有 sync/pin/cleanup 并发及七阶段测试继续执行。

保留项：CIDR 同一进程客户端及必要 fixture 留给 #97；remote-faults 其余 16 项恢复测试留给 #95；remote-status 保留 SRS-only、8 个旧解析错误、当前稳定字节／非法历史记录、未归属文件和维护预览，共 12 项，由 #98/#99 收尾。`configured-activation-fixture.ts` 仍供迁移、客户端、恢复和远端验收使用，本票不删除。旧运行时实现、远端验收入口及 CI 接线未变。

## 整理前测量与验证

编辑测试前，在干净固定基线上运行根 README 的统一入口：

```sh
node scripts/verify.mjs --out <evidence>/before --binary <absolute-sing-box-1.14.4>
```

通过 `NODE_OPTIONS=--import=<evidence>/observe-processes.mjs` 观察 `child_process.execFile/spawn` 的命令类别和结束耗时，不改变 binary 路径、内容、参数、输出或退出状态。观测器保留 `execFile` 的 promisify 返回约定。整理前后使用同一观测器、工具和范围，未运行 Release 或真实远端写入验收。native 统计包括验证预检和预期失败；`sing-box` 路径／副本／直接转发调用与故障 wrapper 分开报告，不重复统计 shell 子进程。

基线环境：macOS arm64、Apple M2 Max、Node v26.13.0、pnpm 10.33.2、sing-box 1.14.4；精确环境、binary SHA-256 和工具身份以证据 JSON 为准。常规检查 396 项（工具 115、Compiler 99、Pipeline 182），原生集成 307 项（Compiler 28、Pipeline 279），均零失败、跳过、取消和 todo。常规检查 43.497 s，原生集成阶段 251.773 s，总墙钟 295.514 s。真实路径及副本调用 16,070 次，故障 wrapper 114 次。

原始基线、进程明细、环境、观测器、归类脚本和 CI job/step 身份保存在 [before.tar.gz](issue-94/before.tar.gz)；解压后的 `before/files.json` 可核对统一验证文件摘要。固定基线原 CI [run 43955404685](https://github.com/wangyingang/sing-box-config-manager/actions/runs/43955404685) 两个检查 job 都成功：Workspace checks 69 s、Native sing-box 575 s。这是既有 Linux runner 事实，不能与本机 macOS 耗时直接作同环境比较。

删除旧测试前，完整迁移 suite 70/70 通过（`selection-migrated.log`）；随后新增“保留登记删除”并加强成功 pin 的不可变字节断言，定向两项 2/2 通过（`selection-additions.log`）。两次临时故障验证均得到预期失败：移除重复产物身份检查时 duplicate-artifact 漏拒绝；停用原生复验时域名和 CIDR 无效 SRS 都被错误接受。mutation 日志和退出码已保存，`src/` 随后逐字还原。定向日志见 [targeted.tar.gz](issue-94/targeted.tar.gz)。typecheck 在新增和退役后均通过。

本地双轴审查：Standards 0 findings；Spec 发现 2 项 P2，均补充测试处理。第一项补 S12，明确迁移“当前候选证据故障不隐藏真实交付”；第二项为 S9 增加总写入恰三次的断言，S8 也限制仅成功方提交三次。中间一次统一验证因补测主动终止，记录为 SIGINT／未完成，不计为通过；修订后重新执行完整统一验证。

整理后完整统一验证、对比结果与审查状态在本票 PR 交付时补入；生产操作和远端写入验收未执行。
