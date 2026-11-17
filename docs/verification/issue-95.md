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

完整统一验证与审查结果待本轮执行后补充。生产开关、profile、sync、cleanup、迁移与产物历史不在本票操作范围。远端写入验收未执行。
