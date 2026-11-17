# #95 固定来源、构建身份与恢复测试迁移

2026-11-17。测试编辑前保存映射，迁移覆盖通过后才删除旧段落。范围为 [#95](https://github.com/wangyingang/sing-box-config-manager/issues/95)，对应父 Spec #93 的 M2、M3、M4 恢复关联事实和 M9 工具身份。沿用当前应用服务与已有候选证据边界；真实 SRS 编译、反编译和验证继续使用 sing-box。

固定旧基线 `7075bfc3f6a900c67a07e32e53e5a8aabc4ed1b4` 的同机测量已由 #94 在测试编辑前保存，复用 [原始归档](issue-94/before.tar.gz) 和[环境、方法与统计](issue-94.md#整理前测量与验证)，本票不重复建立旧基线。

## 旧断言 → 当前契约 → 覆盖 → 退役条件

| 旧文件及参数变体 | 当前行为及已有／迁移后落点 | 最终处理 |
| --- | --- | --- |
| integration/update：正常更新、固定 latest、原生回读 | rules-operations、rules-inputs、rules-performance 七阶段 | 复用当前交付、字节及身份断言；processed 跳过与不激活要求退役 |
| integration/update：upload1/2/3、offline、七种候选文件 | rules-performance 七阶段、rules-selection 候选完整性；新增 Git 阶段回读恢复 | 替代测试通过后已删除；失败必须创建新 candidateId 的旧语义退役 |
| integration/update：download/convert/native/identity/content | 当前首次失败行为、固定来源漂移和真实原生能力 | 来源字段和字节分别迁移；首次失败即本地固定输入及 processed 索引退役 |
| integration/configured-update：前三项 rebuild、release/asset/commit/bytes | 当前 sync 恢复、当前版本保留、Release 独立身份参数化 | 新覆盖通过后已删除对应段落；独立 rebuild 与 selectedIds 语义退役 |
| integration/configured-update：共享输入、missing/invalid/readback、共同 checksum/YAML、后续增选、constructor | #96 负责 M6 与逻辑 ID | 保留有效断言及必要 fixture，不能整删文件 |
| integration/configured-update：latest 前进重试失败集、最终本地落盘失败 | 当前恢复按候选固定来源；当前交付后仍检查 latest | 固定来源保护迁移；本票退役该专属 retryRelease 场景和本地成功落盘；增选段落留给 #96 |
| integration/rebuild：确定字节、build 元数据、4 种 contracts 错误 | 当前恢复身份／字节、rules-selection 既有证据边界补 contracts 变体 | 验证后已退役独立 rebuild；不得丢弃 contracts 拒绝 |
| integration/rebuild：download/native/upload/readback/identity/content、工具字节变化 | 当前失败保留当前交付；新构建工具变化产生新 buildId；恢复拒绝工具变化 | 迁移后已删除；保留旧 processed 索引不再是当前契约 |
| integration/china-ip-candidate：正常发布／固定 commit rebuild、首次下载失败 | rules-inputs Git/CIDR；当前 sync 首次失败无候选、重试读取最新分支 | 首次输入尚未产生候选，不沿用旧 pendingOperation 固定 commit 语义 |
| integration/china-ip-candidate：route.json/manifest.json/readback.json 回复丢失 | 复用 rules-performance 七阶段回复丢失；Git 代表性阶段恢复 | 验证原 candidateId、source、buildId、versionId 与保留字节后已删除 |
| integration/china-ip-candidate：证据替换、HTTPS 失败后 route.srs 篡改／source.json 缺失、metadata 阶段篡改 | rules-selection retained-replacement；Git 恢复故障组 | 替代拒绝与恢复通过后已删除 |
| integration/china-ip-candidate：重建缺输入／历史、Release/Git 同日志 | 当前固定候选输入恢复、rules-selection 保留登记、双格式候选 | 退役公开固定 commit rebuild 与旧索引；保留来源保护 |
| integration/remote-recovery：files 恢复、binary 路径改变、完整证据离线恢复 | rules-operations metadata/evidence 换路径；rules-performance 七阶段；rules-recovery 离线上游 | 已有交付时恢复后仍检查 latest，不直接交付旧候选 |
| integration/remote-recovery：选择失败集、operationId/pendingOperation 四变体 | 当前应用服务按规则、候选及 pendingDelivery 关联事实校验 | 用当前状态损坏矩阵替换；旧字段结构与 retryRelease 退役 |
| integration/remote-faults：三阶段回复丢失、三阶段 × maintenance/generation/head、缺状态／坏状态／读失败 | 七阶段恢复与并发矩阵；补当前状态及写入守卫检查 | 替代证据通过后已删除；每次实际写入继续执行守卫 |
| integration/remote-faults：本地缓存不可替换 | 当前五操作无本地状态缓存 | 按 ADR 0001 退役 |
| test/update、test/rebuild：本地锁／processed／坏状态／旧参数 | 当前 session 状态保护、CLI 拒绝旧命令 | 新当前状态覆盖通过后已删除两个常规文件 |
| test/china-ip-cli：内部构建诊断／分支可信历史 | 内部 CIDR 构建仍有效 | 原断言逐字保留，已重命名为 china-ip-build.test.ts |

## 当前覆盖定位

- [rules-source-recovery.test.ts](../../packages/rule-set-pipeline/test/integration/rules-source-recovery.test.ts)：Release 7 个独立变体（Release ID、输入 asset ID、checksum asset ID、tag、commit、input bytes、checksum bytes）；Git 首次失败；Git/CIDR 三个阶段 HTTPS 回读失败后的固定 commit 恢复；固定输入失踪／变化；metadata/evidence 的保留文件损坏；新构建工具身份；当前 pendingDelivery 关联损坏。共 31 项（含子测试）。恢复比较原候选、来源、buildId、已登记 version/time、所有已保留文件的字节及不重复写入。
- [rules-state.test.ts](../../packages/rule-set-pipeline/test/rules-state.test.ts)：已有内容缺状态、JSON 损坏、状态读取失败、snapshot 失败、错误目标，5 项均断言零上游读取、零写入、原 head／字节不变。空仓库合法初始化由该套件准备过程及现有操作测试继续验证。
- [rules-selection.test.ts](../../packages/rule-set-pipeline/test/integration/rules-selection.test.ts)：扩展为七个候选文件独立缺失变体，并迁入 null、非法 Manifest 契约、缺 buildRecord、非法 buildRecord 四项。旧单列表 buildRecord=1 的“未来版本 2”在当前配置化构建中已合法，因此非法版本样本改为 3；不是恢复旧 buildRecord=1 契约。
- [rules-performance.test.ts](../../packages/rule-set-pipeline/test/integration/rules-performance.test.ts)：保留原共享／双分支七阶段中断和响应丢失矩阵，保留原五类并发场景；将 pin 竞争放到 metadata 写入、换源竞争放到 evidence 写入，以同一矩阵覆盖较晚实际写入的守卫，不新增九套旧流程。
- [rules-operations.test.ts](../../packages/rule-set-pipeline/test/integration/rules-operations.test.ts)：继续运行 metadata/evidence 不同 binary 路径恢复；[rules-recovery.test.ts](../../packages/rule-set-pipeline/test/integration/rules-recovery.test.ts)继续覆盖原工具变更拒绝、原版本、多个候选、已有交付时 latest 失败保留当前和恢复后选最新。

当前关联故障的独立变体为 pendingDelivery 缺 id、非法 stableHead、record 对应候选缺失、changes 摘要被改写，以及候选缺 controlRevision、绑定错误、logicalId 错误；不再构造旧 operationId/pendingOperation。七个候选文件缺失分别是 domains.json、domains.srs、manifest.json、source.json、conversion-report.json、build.json、readback.json。其摘要／字节替换由同一现有证据验证器及 Git metadata/evidence 恢复测试共同覆盖，不为每个文件再跑完整生命周期。

旧 17+8+10+5+16 项集成 suite 整文件退役，configured-update 分段删除 9 项、保留 #96 的 8 项和 fixture；常规 update/rebuild 共 3 项退役，内部 CIDR 两项改名保留。没有删除历史转换、客户端、原生能力或共享 legacy fixture。历史 #48 的链接改为固定旧基线地址，保留当时的验收事实。

## 验证记录

删除前新来源套件 31/31、扩展证据及既有并发定向检查 49/49、当前状态 5/5 通过。最早两轮曾因测试替身未提供替换 asset 的有效字节、以及误用当前合法 buildRecord 作为非法样本而失败，均修正并复测；这些失败不计为通过。工具身份 mutation 临时移除 unchanged 的工具校验，新测试检测到错误的 unchanged 结果；运行时源码随后逐字恢复。退役时 typecheck 发现仍保留的 #96 场景需要 readFile import，已恢复。

完整统一验证通过：

```sh
node scripts/verify.mjs --out .verification/issue-95/after --binary /absolute/path/to/sing-box-1.14.4
```

范围 `check-native`，源码身份为干净提交 `432d76e5c5030df25d6cb7c10452a2246e785e6d`（`clean=true`，tracked diff SHA-256 为空差异摘要 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`）。工具为 Node v26.13.0、pnpm 10.33.2、sing-box 1.14.4，binary SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`，与固定旧基线相同。实际完整命令与绝对路径由 summary 和 process 日志记录。

常规检查 390 项（工具 115、Compiler 99、Pipeline 176），原生集成 300 项（Compiler 28、Pipeline 272），共 690 项，全部通过，零失败、跳过、取消和 todo。typecheck、build、工作区引用和浏览器打包 smoke 也由统一入口执行。证据经 `inspect-evidence.mjs` 校验大小与摘要，1/1 通过。

原始 summary、files 清单、完整日志、过程观测、工具和环境身份、文件清单、计数方法及本地审查报告保存在 [after.tar.gz](issue-95/after.tar.gz)。解压后 `after/` 可由统一证据读取器复查。删除前定向验证和 mutation 证据见 [targeted.tar.gz](issue-95/targeted.tar.gz)。

## 整理后测量

复用 #94 的原始观测器和归类脚本，在同一 macOS arm64 / Apple M2 Max、同一工具版本和 `check-native` 范围测量。原生调用包括预检和负向场景，不重复统计 wrapper 的 shell 子进程。文件并发保持默认，未增加原生缓存、runner 或 CI 分片。

| 指标 | 固定旧基线 7075bfc | 本轮 432d76e |
| --- | ---: | ---: |
| 常规文件（tools / Compiler / Pipeline） | 6 / 12 / 21 | 6 / 12 / 20 |
| 原生文件（Compiler / Pipeline） | 8 / 26 | 8 / 21 |
| 常规测试 | 396 | 390 |
| 原生测试 | 307 | 300 |
| 常规检查耗时 | 43.497 s | 49.898 s |
| 原生阶段耗时 | 251.773 s | 238.642 s |
| 总墙钟 | 295.514 s | 288.761 s |
| 真实路径及副本原生调用 | 16,070 | 14,410 |
| 故障 wrapper 调用 | 114 | 114 |

| 原生调用用途 | 固定旧基线 | 本轮 |
| --- | ---: | ---: |
| version | 3,264 | 2,932 |
| rule-set compile | 3,113 | 2,781 |
| rule-set decompile | 3,114 | 2,782 |
| rule-set match | 6,423 | 5,759 |
| schema | 74 | 74 |
| check | 77 | 77 |
| run | 5 | 5 |

这是 #94 与本票累计结果：真实原生调用减少 1,660 次（10.3%），总墙钟减少 6.753 s（2.3%）；相对 #94 已记录的 15,095 次调用，本轮再减少 685 次。各次仅测量一轮，常规检查本轮反而较慢，不能将墙钟变化全部归因于本票，或承诺稳定降幅。未整理的旧 check-now 等流程仍由后续工单处理。

新来源恢复 suite 的十个顶层测试体合计 18.723 s（31 项含子测试）；保留的七阶段／并发性能 suite 为 35 项，测试体合计 63.523 s。父测试时间已含子测试，文件并行运行，不能将这些数字相加当总墙钟。原始测试名、时长及完整日志均在归档中。

## Standards

0 findings。独立审查覆盖全部新增、修改、删除与重命名；没有发现仓库约定违规或值得行动的 smell。测试沿用已确认边界，历史说明保留固定旧源码地址。

## Spec

0 findings。独立审查逐项核对 #95/#93、有效旧断言、Release/Git 来源保护、原身份和字节、当前关联事实、已有交付与 latest、新旧构建工具行为，以及跨票保留边界。没有确定的验收缺口或额外运行行为变化。

本地两轴均覆盖 `e12cca9...432d76e`。云端首轮审查也覆盖 `432d76e`，已完成且无 findings、无行内 comments 或 review threads。此后的提交只补充验证说明与证据归档；最终 CI、云端覆盖提交及工单状态以 PR 和工单交付评论为准，不为刷新这些状态追加源码提交。生产开关、profile、sync、cleanup、迁移与产物历史不在本票操作范围。远端写入验收未执行。
