# #96 四集双来源同步与 GitHub 交付验收迁移

2026-11-17。实施起点 `0daf266`，父 Spec #93，固定旧基线 `7075bfc3f6a900c67a07e32e53e5a8aabc4ed1b4`。本映射在编辑测试前保存。复用 [#94 的同环境旧基线](issue-94.md#整理前测量与验证)及其原始归档，不重建基线。

测试边界沿用父 Spec 已确认的当前应用服务 `status/sync/pin/resume/cleanup`，外部网络、存储可替换，真实 SRS 继续由 sing-box 1.14.4 验证。本票不接管清理、客户端或一次性转换。

## 当前覆盖目标

- I1：四集双来源共享读取，CIDR 独立变化，新 commit 同语义不新增版本或候选。
- I2：共同来源获取、checksum、YAML 错误只影响对应三集；CIDR 错误只影响 CIDR；单列表缺失／非法和交付回读失败不丢失独立成功，当前交付保留；后续恢复。
- I3：合法 `constructor` 经 sync/status/pin/resume 及新会话读取；订阅字段重排复用 #94 rules-selection 的 S5，避免重复生命周期。
- G1：当前应用服务在真实 GitHub 隔离分支执行四集双来源新增、内容更新、换源、pin、resume、删除。核验官方固定来源、候选全部文件、Manifest/Conversion Report/Build/Readback、稳定 HTTPS、历史字节及兄弟集不变。保存源码身份、请求、前后生产 refs/开关和失败时清理结果。

## 旧断言逐项映射（编辑前）

下表按实施起点的旧测试名定位；只有替代测试通过后才退役。旧契约的本地索引、selectedIds、双暂停、人工维护阶段不进入当前接口。

| 旧文件／测试 | 当前契约及去向 | 退役依据或保留边界 |
| --- | --- | --- |
| check-sources：四集共享各自来源；CIDR 改变只更新 china-ip，新 commit 同内容不重复发布 | I1/I2；固定输入恢复复用 rules-source-recovery；pin/resume 竞争复用 rules-selection、rules-performance、rules-operations | 替代通过后退役；pinned 期间继续产生候选、单集筛选及旧批次暂停按当前契约退役 |
| check-sources：共同输入和单列表失败各自隔离，其他规则集仍能交付变化 | I1/I2；固定输入恢复复用 rules-source-recovery；pin/resume 竞争复用 rules-selection、rules-performance、rules-operations | 替代通过后退役；pinned 期间继续产生候选、单集筛选及旧批次暂停按当前契约退役 |
| check-sources：候选提交回复丢失后，新目录续用已固定的两类来源 | I1/I2；固定输入恢复复用 rules-source-recovery；pin/resume 竞争复用 rules-selection、rules-performance、rules-operations | 替代通过后退役；pinned 期间继续产生候选、单集筛选及旧批次暂停按当前契约退役 |
| check-sources：恢复 china-ip 验证失败时保留当前规则，且不会访问 V2Fly 或修改其人工固定 | I1/I2；固定输入恢复复用 rules-source-recovery；pin/resume 竞争复用 rules-selection、rules-performance、rules-operations | 替代通过后退役；pinned 期间继续产生候选、单集筛选及旧批次暂停按当前契约退役 |
| check-sources：${branch}：旧 CIDR 检查不能覆盖后来人工固定和恢复的决定 | I1/I2；固定输入恢复复用 rules-source-recovery；pin/resume 竞争复用 rules-selection、rules-performance、rules-operations | 替代通过后退役；pinned 期间继续产生候选、单集筛选及旧批次暂停按当前契约退役 |
| check-sources：CIDR 激活待核实期间暂停同批写入，换目录继续时不重复切换 | I1/I2；固定输入恢复复用 rules-source-recovery；pin/resume 竞争复用 rules-selection、rules-performance、rules-operations | 替代通过后退役；pinned 期间继续产生候选、单集筛选及旧批次暂停按当前契约退役 |
| check-sources：人工固定期间，新 commit 的内容与已检查候选相同则保留该候选 | I1/I2；固定输入恢复复用 rules-source-recovery；pin/resume 竞争复用 rules-selection、rules-performance、rules-operations | 替代通过后退役；pinned 期间继续产生候选、单集筛选及旧批次暂停按当前契约退役 |
| configured-update：一次 update 共享固定输入，逐集发布独立候选并在新读取中保留结果 | I1/I2/I3；候选验证复用 rules-selection，固定输入拒绝恢复复用 rules-source-recovery | 替代通过后退役；旧 processed 索引、单集增选和本地成功文件不再是当前契约 |
| configured-update：Anthropic ${failure} 时保留兄弟候选${failure === 'readback' ? '，修复后可单独重试' : ''} | I1/I2/I3；候选验证复用 rules-selection，固定输入拒绝恢复复用 rules-source-recovery | 替代通过后退役；旧 processed 索引、单集增选和本地成功文件不再是当前契约 |
| configured-update：共同输入摘要损坏时不产生任何候选 | I1/I2/I3；候选验证复用 rules-selection，固定输入拒绝恢复复用 rules-source-recovery | 替代通过后退役；旧 processed 索引、单集增选和本地成功文件不再是当前契约 |
| configured-update：共同 YAML 文档无效时不产生任何候选 | I1/I2/I3；候选验证复用 rules-selection，固定输入拒绝恢复复用 rules-source-recovery | 替代通过后退役；旧 processed 索引、单集增选和本地成功文件不再是当前契约 |
| configured-update：同一 Release 后续增选只处理新集，来源摘要变化阻止失败集重试 | I1/I2/I3；候选验证复用 rules-selection，固定输入拒绝恢复复用 rules-source-recovery | 替代通过后退役；旧 processed 索引、单集增选和本地成功文件不再是当前契约 |
| configured-update：合法逻辑 ID constructor 的成功记录可跨进程持久化并跳过 | I1/I2/I3；候选验证复用 rules-selection，固定输入拒绝恢复复用 rules-source-recovery | 替代通过后退役；旧 processed 索引、单集增选和本地成功文件不再是当前契约 |
| check-now：同一 Release 只为内容改变的 Anthropic 发布并激活 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：单集失败仍交付兄弟集，下一次重试；共同来源校验失败不切换任何集 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：人工回滚停止检查该集，人工指定仍可产生候选但不会激活 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：来源列表变化重新判断同字节，订阅契约变化拒绝激活 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：${branch} 激活未提交时换机复用完整候选，候选发布语义保持独立 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：${branch} 激活提交后断线，换机确认已交付并保留同一条激活记录 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：${branch} 自动检查启动后人工固定，旧检查不能把新 head 当作父提交 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：构建期间进入维护并更换代次，旧检查拒绝候选提交 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：完整候选的证据已提交但进程断线，换机复验候选并补做激活 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：一个当前记录损坏，未激活的兄弟集仍可首次交付 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：已提交但 HTTPS 回读失败时报告当前版本和已知提交，换机后只补核实 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：稳定切换登记后发生人工固定，旧自动切换在提交前被拒绝 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：维护重新确定所有当前版本和 pin，从远端恢复并安全退出，旧任务仍然过期 | T5：原测试及必要准备保留 | 本票不删清理断言 |
| check-now：候选各提交阶段都使维护延期，远端登记在任务中断后仍然有效 | T5：原测试及必要准备保留 | 本票不删清理断言 |
| check-now：隔离已提交后断线，新调用续做保留集合。稳定 head 改变后保持隔离 | T5：原测试及必要准备保留 | 本票不删清理断言 |
| check-now：恢复只解除选中集的限制，并允许重新采用刚回滚掉的最新版本 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：${branch} 恢复决定提交后断线，换机检查失败仍保持恢复并能再次更新 | T5：其中维护预览阻塞断言尚未迁移 | 两种分支布局的原测试及必要准备保留，不由本票删除 |
| check-now：${branch} 自动检查登记后人工固定并恢复，最早任务仍不能发布或激活 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：维护期间拒绝保存恢复决定或访问上游 | T5：原测试及必要准备保留 | 本票不删清理断言 |
| check-now：恢复 OpenAI 立即检查最新来源，Anthropic 保留原批次和已发布的候选文件 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：单集恢复已固定来源后中断，正常批次用同一个 Release 继续三个规则集 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：恢复登记后断线，普通批次不会抢先更新仍有旧检查的兄弟集 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：恢复决定写入后断线，候选更新用原命令继续已暂存的 Release | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：普通批次不会把已恢复到新 Release 的兄弟集纳入较旧的恢复检查 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：使用不同构建配置重新请求中断的恢复时，旧请求不能重放 | I1/I2；恢复、七阶段故障/竞争复用 rules-recovery、rules-source-recovery、rules-performance、rules-selection、rules-operations | 替代通过后退役；旧双暂停、批次恢复/selectedIds/本地回执字段退役；共享状态损坏遵从当前停止全部写入契约 |
| check-now：${branch} 新基线回读中断后可恢复，屏蔽旧地址后仍核验各集当前版本、pin 和处理进度 | T5：原测试及必要准备保留 | 本票不删清理断言 |
| check-now：${branch} 切换后稳定 URL 回读中断，远端恢复完成清理且不重复切换 | T5：原测试及必要准备保留 | 本票不删清理断言 |
| check-now：${branch} 两轮清理保留 pin 和新历史，并拒绝旧代次写入、回滚及重建 | T5：原测试及必要准备保留 | 本票不删清理断言 |
| check-now：人工激活回读跨越清理后拒绝返回旧地址或覆盖本地回执 | T5：原测试及必要准备保留 | 本票不删清理断言 |

## 远端独有断言映射（编辑前）

| 旧入口 | 当前契约与目标 | 退役／保留依据 |
| --- | --- | --- |
| publication：固定 tag、固定 input SHA、七文件 HTTPS 和成功证据 | G1 固定官方 Release 及全文件字节/长度/摘要回读 | 当前候选 verified 和新会话 status 代替本地 processed；通过后删除 |
| configured-publication：三集、共享资产读取、Manifest 身份/版本/投影/格式、输入数 25/19/49、termCount、Build 来源、原生与远端证据 | G1 四集双来源首轮逐项核验 | 通过后删除 |
| activation：逐集当前/历史字节与兄弟集记录、canonical 稳定 URL 收敛 | G1 逐集 pin 原版本与 resume 新版本，每次比较所有兄弟集记录及文件 | 通过后删除；人工合成候选由当前换列表/真实来源取代 |
| rollback：历史原候选/文件恢复、兄弟不变、稳定 HTTPS | G1 通过当前 pin 选择保留 versionId，逐字节恢复 | 历史 activation commit 与专属 rollback 状态退役，通过后删除 |
| rebuild：固定输入 SHA、历史文件仍可读、确定性规则字节、原生复验、无变化不交付 | G1 历史证据回读及 pin/resume；本地 rules-source-recovery 工具身份与固定输入恢复；I1 同语义不新增 | 公开 rebuild、新 candidate 强制要求、本地 processed 不再是当前契约；通过后删除 |
| configured-rebuild：Manifest/Build/Report/Readback、历史与兄弟保留、固定来源 | G1 官方四集完整候选及历史回读；I1/I2 独立结果；rules-source-recovery 固定输入 | selectedIds 增选、专属 rebuild 操作退役；通过后删除 |
| official-rulesets-lifecycle：四集双来源、固定两个 Release/Git commit、CIDR 变化、pin/resume、稳定字节 | G1 从当前 sync/pin/resume 驱动四集双来源 | 独有业务断言迁移后移除对应断言；清理断言及必要准备继续保留 T5 |
| official-rulesets-lifecycle：清理代次、保留、pin、旧候选不可选及清理后回读/恢复 | T5 | 不在本票退役，必要旧业务调用仅作清理准备 |

运行结果与最终删除范围将在验证后补充；未执行或跳过不算通过。

## 本地替代覆盖通过后的退役

2026-11-17：`rules-inputs` 13/13、操作/七阶段/恢复/来源/选择五个 suite 共 175/175 通过，均零跳过。由此删除 `check-sources` 8 项、`configured-update` 剩余 8 项，并从 `check-now` 分段移除已迁移的同步、恢复、竞争和过时批次断言。`check-now` 的维护预览、保留、清理切换、中断恢复及跨清理回读保留，包含“恢复决定提交后断线”中的维护阻塞保护；其必要旧业务准备不提前删除。

旧“一个当前记录损坏仍交付兄弟集”由 `test/rules-state.test.ts` 五项当前状态保护代替：损坏共享状态时停止全部写入；正常来源或列表失败则由 I2 保留独立成功。旧来源绑定/订阅校验分别落在 `rules-operations` 换源与路径保护及 `rules-selection` S5；旧七阶段/人工控制竞争落在 `rules-performance` 和 `rules-selection`，不是减少守卫。配置增选改为当前定义新增，不恢复 selectedIds；constructor 不再依赖旧 processed 索引。

`test:release` 的通配收敛留给 #101，本票只接线 `test:acceptance:rules`。尚有调用者的 legacy workflow、configured activation 和客户端 fixture 保留。

## 审查与未通过的远端运行

Standards 首轮 1 项 P3：映射生成把 fetch 实现片段当作测试名，已删除伪条目并清理测试名中的代码尾段。Spec 首轮 1 项 P2：固定官方样本的独立输出数量和来源列表断言遗漏，已补齐三域名的 25/19/49、旧单集样本的 214，以及 `build.definition.list`；pin 明确检查请求版本，resume 对照固定前最新来源和字节。双轴静态复核均无剩余问题。

远端前四轮均不计通过：

- attempt-1：探针的 API 路径限制误拒绝仓库元信息读取，尚未进入业务。隔离目标已清理，生产 refs/variables 前后相同。
- attempt-2：三域名交付成功，CIDR 的 ref 更新返回 HTTP 422；全轮失败。隔离目标已清理，生产前后相同。后续仅对明确临时服务错误重试公开操作，仍由正常 session/heads/writeId 核实已应用结果，不直接重放底层写请求。
- attempt-3：为补齐本地审查断言主动 SIGINT；不算完成。手工删除精确隔离 ref 后确认没有残留。原始进程未及时落盘本轮初始生产快照，因此归档明确以 attempt-2 的结束快照作最近已记录参照，不能把它冒称为本轮初始快照。后续版本增加初始快照及每个完成阶段的即时落盘。
- attempt-4：四集新增和稳定 HTTPS 回读成功；一次额外 status 查询的 OpenAI 可选计数降为 0，触发断言失败。此前已保存的查询中四集均可选；失败查询本身未保存候选 reason，具体网络原因未证实。隔离目标已清理，生产前后相同。后续复用已记录查询，并恢复原探针对下载 TypeError 的一次重试；不放宽摘要、字节、身份或原生校验。

显式门禁下缺少 binary、缺少 evidence 路径均已执行拒绝验证，业务未运行。关闭语义去重的临时 mutation 使四集测试按预期失败，源码随后逐字还原。根 `src/` 和模块业务源码没有最终差异。

- attempt-5：四集新增、候选固定来源／七文件、CIDR-only、Release 更新及 OpenAI 换列表通过；canonical URL 的 `max-age=300` 使逐次等待过长，主动中断，不算完整通过。精确隔离 ref 已清理，保存的本轮生产快照前后相同。后续沿用旧 activation/rollback 的分批回读策略：逐集保留不可变快照和兄弟集比较，全部固定后统一回读 canonical 原版本，全部恢复后统一回读 canonical 最新内容。
- attempt-6：用户网络中断期间出现顶层 `fetch failed`，全轮失败；自动删除隔离 ref 也因网络失败而未完成。恢复后通过 `gh` 手工删除唯一精确 ref，另存清理证据，确认无残留且生产前后相同。原始失败证据保留，不改写为通过。
