# #99 一次性历史转换测试迁移

2026-11-18。实施起点 `1f9ad68d5bf99915e0ce57834023f3b6b7796e98`。本映射在测试编辑前保存。范围为 [#99](https://github.com/wangyingang/sing-box-config-manager/issues/99)，父 Spec #93 的 M9 历史读取与一次性转换。复用 [#94 同环境固定旧基线](issue-94.md#整理前测量与验证)，不重复建立基线。

## 断言映射与退役条件

| 旧断言／准备流程 | 当前契约与迁移落点 | 退役依据／保留条件 |
| --- | --- | --- |
| rules-migration：shared/split 的 checkRules + activateRules | 固定真实 writer 快照；保留有效固定、来源、稳定字节、未知发布时间、预览零写入、split 最终提交中断恢复、重复执行 | 替代测试通过后移除日常测试中的旧业务生成 |
| rules-migration：未完成候选与无法归属候选 | 由真实登记阶段截取的固定样本；转换隔离、定义删除回收、有主／无主原因与文件保留 | 不再人工拼装候选身份或重跑旧生命周期 |
| remote-status-binary：真实 SRS-only 读取与 rollbackTargets/native 字段 | 固定真实 SRS-only 激活快照，历史记录解析与一次性转换；订阅不匹配现行定义时零写入拒绝 | 原生 status 复验字段、回滚目标列表为旧接口；真实 SRS 在转换中验证 |
| remote-status：SRS-only 首项、8 种订阅／文件错误、稳定字节损坏及非法 history | 现有 activationRecord / verifyStableFiles 历史读取边界；转换入口损坏拒绝 | 保留历史解析器拒绝；移除旧 status 返回字段要求 |
| remote-state：初始化、状态缺失、读失败、JSON 损坏、来源资产身份损坏 | 固定 schema 1 journal 的只读解析，转换入口拒绝且零写入 | 初始化不是当前公开能力，不继续测试 legacy writer |
| remote-legacy-recovery：隔离分支 update/rebuild；文件阶段恢复及幂等；三阶段回复丢失；rebuild 保留 processed；固定来源下载失败；不再保留候选；完成证据离线恢复（9 项） | 当前 rules-operations / rules-recovery / rules-candidate-validation 覆盖运行恢复；本票固定 schema 1 样本覆盖一次性转换 | 替代转换通过后删除整文件，不继续承诺旧单集 writer 长期运行 |
| remote-status：未归属稳定文件、维护预览 | #98 当前 cleanup 覆盖，#99 不重复更改 | #98 尚未合入 main，首轮保留两项；整合 #98 后双方段落全部迁移，整文件删除 |

## 共享 fixture 清理条件

编辑前调用者：`configured-activation-fixture.ts` 仍供 check-now、maintenance-sources、acceptance/maintenance-switch 使用（包括 upstream）；`fixtures/publication-repository.ts` 仍供旧维护、publication/rebuild 等测试使用；`fixtures/legacy-workflow.ts` 仍供 legacy-workflow、official-rulesets-lifecycle 使用。原计划仅解除本票依赖，其他调用者迁移后再清理。实施期间 #98 合入 main（`3347fbd`），随后重新扫描：configured-activation-fixture 与 publication-repository 两份 fixture 已无任何调用者，本票作为最后一票删除；legacy-workflow 仍被 legacy-workflow.test.ts 使用，继续保留，待该常规 suite 完成迁移后清理。

## 验证记录

实施中，最终记录将补充源码身份、样本来源、定向与完整验证、审查和 CI 范围。未执行生产转换、生产 sync/cleanup 或远端写入验收。

## 固定样本依据

四份样本来自实施起点的实际 schema 1 writer，使用既有内存 Git/Release fixture 和真实 sing-box 1.14.4；它们是可复现的契约样本，**不是生产仓库或官方 Release 的历史快照**。保留 writer 产生的 UUID、来源身份、commit 地址、证据、配置、原始 JSON/SRS 字节，不替换为手写“正常”对象。存储层只重放捕获的快照及不可变下载，日常测试不调用 checkRules、activateRules 或 updateRules。

- `shared.json`：同分支三集 checkRules，然后手工固定 openai；保留有效 pin。
- `split.json`：candidates/main 双分支同等写入；测试中改期望列表，证明不再适用的旧 pin 不保留；转换最终 journal 提交中断后沿用检查点和回执，不重复切换稳定分支。
- `srs-only.json`：旧 configured updateRules 构建后首次 activateRules 仅提供 SRS 订阅。历史记录读取、SRS 原生复验、来源与订阅保留得到验证。当前配置要求双格式时转换拒绝且零写入；从现行配置移除该定义后可转换历史交付，不凭空补 source URL。这沿用现有订阅兼容约束，没有新增兼容 writer。
- `incomplete.json`：checkRules 的真实规则文件提交完成，manifest 提交前故障，保留原候选及原文件。未知归属场景在此样本上明确注入“丢失候选归属和 operation 索引”故障；转换保留待处理文件，不把它伪装为一个完整合法候选。

[样本 manifest](issue-99/historical-samples.json) 记录每份文件 SHA-256、大小、heads、候选 ID、具体生成步骤、writer 源码身份及 binary 摘要。每份样本内按内容摘要去重保存 blob，加载时逐个校验；过去快照仅保留不可变回读所需的规则／候选文件，最终状态保留完整 journal 与 identity。生成脚本归档于本票证据，不加入日常测试入口。

## 旧单集运行流程的逐项去向

| remote-legacy-recovery 原测试 | 有效保护落点／退役原因 |
| --- | --- |
| 独立验收分支 update/rebuild | 当前 rules-operations 的 shared/split 操作；公开 rebuild 已退役，一次性转换使用上述固定 schema 1 样本 |
| 文件提交中断后新目录恢复及后续幂等 | rules-recovery 的 building 原候选恢复、rules-operations 的 evidence/metadata 换机恢复；本票 split 转换中断／重复执行 |
| domains.json / manifest.json / readback.json 三种回复丢失 | rules-operations 的双分支响应丢失及 rules-performance 七阶段恢复；不继续支持旧 writer 的阶段计数 |
| rebuild 保留旧 update processed | processed 成功索引和独立 rebuild 契约已退役；构建身份由当前恢复测试保护，迁移保留原 buildId |
| 固定 Release 后下载失败 | rules-recovery 固定输入不随上游变化；来源身份各字段保护由 #95 迁入当前恢复测试 |
| 当前树不再保留完整候选时拒绝旧成功地址 | 当前候选证据／pin 测试覆盖 retained 内容缺失拒绝；本票 missing-current-file 转换拒绝 |
| 完成证据后离线恢复不重发 | rules-recovery 完整证据恢复、上游失败保留当前交付；本票转换 fetch 强制拒绝上游，来源／候选身份保持 |

替代的 25 项定向测试及类型检查通过后，删除 remote-legacy-recovery 与 remote-status-binary 整文件；remote-status 中移除 SRS-only 旧返回字段要求，8 种订阅／文件错误及非法历史、稳定字节损坏移到 historical-records 的现有历史解析边界。remote-state 保留缺状态、未初始化、HTTP 失败、损坏 JSON 与资产身份损坏的只读拒绝，解除初始化 writer 依赖。

## 本地审查与整合

code-review Standards 首轮 1 项 P3：#48 的 remote-status-binary 历史链接失效，已改为固定旧基线；同一历史段落的 remote-state、remote-status 也固定到旧源码，避免将历史验收说明链接到新边界。Spec 首轮零 findings。整合 `3347fbd` 后重新核对共享调用者和分段映射，未修改生产代码。
