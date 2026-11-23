# 配置驱动操作、状态与版本契约

本页描述 [#128 无变化同步](https://github.com/wangyingang/sing-box-config-manager/issues/128)、[Spec #84](https://github.com/wangyingang/sing-box-config-manager/issues/84)、[Spec #85](https://github.com/wangyingang/sing-box-config-manager/issues/85)、[Spec #86](https://github.com/wangyingang/sing-box-config-manager/issues/86) 及 [Spec #90 恢复修复](https://github.com/wangyingang/sing-box-config-manager/issues/90) 的应用服务结果、自动运行边界及远端持久事实。它不是 Compiler 的输入契约；Compiler 继续消费 [Rule Subscription v2](rule-subscription-v2.md) 或固定 [Artifact Manifest v2](README.md)。

## 配置

正式配置为源码 main 当前 commit 的 `packages/rule-set-pipeline/config/rulesets.yml`。完整结构使用 `schemaVersion: 3`，字段为 `candidateRetentionDays`、`sources`、`target`、`ruleSets`。各层拒绝未知字段；`candidateRetentionDays` 必须为显式正整数，正式值为已确认的 30 天，由 cleanup 执行年龄保留策略。

`target.repository` 固定为 `wangyingang/sing-box-rule-artifacts`；分支只能是 `main` 或受限 `acceptance-*`。`ruleSets` 中 ID 唯一，`source` 必须存在，`stablePath` 为互不重叠的 `stable/` 路径。显式空集合表示删除全部；缺少集合、读取失败或解析错误不能解释为删除。

获取机制与解析语义分别声明：GitHub Release 资产使用 `version: latest-release` 和 asset/checksum；固定 Git 分支输入使用 `version: git-branch`、branch/path。两者都接受已有的 `plain-yaml` 规则列表或 `cidr-text` 语义。Git 分支输入还接受 `domain-suffix-text`、`typed-domain-text` 和 `sing-box-domain-json`，使用 `list: all` 选择整个文件并生成域名产物。配置按格式的域名或地址产物校验 Route、DNS query 和 DNS response 的用途声明。来源记录保存真实仓库、Release/commit 身份、输入文件、摘要和字节数。官方 ChatGPT Voice 使用 `version: openai-voice`、`format: openai-voice-json` 和固定 `https://openai.com/chatgpt-voice.json`，读取非空 `prefixes` 列表中的 `ipv4Prefix` 或 `ipv6Prefix`，使用现有 CIDR 规则处理。其来源记录保存 URL、原始字节的 SHA-256 和长度，以及可用的强 ETag。恢复使用登记的固定输入。

`typed-domain-text` 读取 UTF-8 的 `类型,值`，忽略空行和以 `#` 开头的注释行。域名后缀使用裸域名的规范化方式，关键词转为小写，保留子串匹配语义。转换报告的 `filteredRules` 记录按用途过滤的 `PROCESS-NAME` 类型、值和行号。`inputCount` 包含已过滤条目。其他类型、格式错误和没有可用域名的输入使本次构建失败。

`sing-box-domain-json` 读取 UTF-8 的 Source Format v2 JSON。顶层包含 `version` 和 `rules`，规则对象仅接受 `domain`、`domain_suffix` 和 `domain_keyword` 的字符串数组，且须有可用的匹配值。每个值都是独立匹配条件，保留原值，按类型和值去重。重复字段、其他字段、非法结构或非法值使构建失败，诊断标明输入文件和对应规则或字段。生成的候选继续使用 Source Format v4。

隔离目标可使用 [v4 配置 Schema](../config/rulesets.schema.json)。同步使用同一份 Schema，并额外核对 `data.source` 和对应获取方式、格式及最终路径。配置错误会在上游获取或产物写入前停止整次同步。v4 可共用 `publishPath`，但 `publishPath/artifact.json` 和 `publishPath/artifact.srs` 必须由一集独占。

## 共同结果

五个服务返回 `RulesResult`，CLI `--json` 直接呈现相同业务结果：

Node 请求可选传入 `onProgress(event)`，事件为 `RulesProgress`（`stage` 及可选 `logicalId`）。这是非持久观察信息，不是成功回执；回调抛错不能中止业务操作。CLI 和 Actions 将阶段及累计耗时写到 stderr，长阶段每 15 秒继续提示；stdout 的最终结果结构不变。

| 字段 | 含义 |
| --- | --- |
| `operation`、`dryRun` | status/sync/pin/resume/cleanup 及是否仅预览 |
| `configurationRevision`、`configurationOrigin` | 本次读到的正式 commit 和来源；草稿标记为 local-draft |
| `target` | 本次受限产物仓库与分支 |
| `status`、`exitCode` | success/disabled/partial/failed/pending；success 与 disabled 为 0，disabled 表示未应用 |
| `results[]` | 每集的 `id`、结果、`changes`、`error`、`current`、`control`、`expectedSource` 和需要时的 `continueWith` |
| `observedHeads` | 能读到时返回日志与稳定分支的观察 head，不作为后续执行凭证 |
| `error` | 无法分配到单集的失败，或交付事实尚不能完成核实 |
| `cleanup` | cleanup 的阶段、固化计划、保留/移除数量、其他引用与继续入口；无法盘点时可缺省 |

逐集结果区分 delivered、unchanged、pinned-skipped、pinned、resumed、deleted、failed、pending、superseded、planned。正常固定跳过是成功；独立失败与成功并存为 partial；存在待核实提交或归属未知的隔离候选为 pending。`changes` 说明本次已完成或预览预计完成的变化。resume 后更新失败时，`automatic-updates-restored` 与 auto 控制说明解除固定已经持久化，不能把整次失败理解为仍被固定。

通过上游文件身份省略正文时，`verified` 包含 `source-identity`、`retained-candidate`、`subscription` 和 `stable-files`，`reliedOn` 包含 `historical-normalized-content`、`historical-native` 和 `historical-candidate-publication`。读取正文后确认规范化内容相同时，`verified` 包含 `source` 与 `normalized-content`，`reliedOn` 包含 `historical-native` 和 `historical-candidate-publication`。完整构建后确认无需切换时，`verified` 可以报告 `native`。

进度事件的 `source-identity` 阶段表示探测上游文件身份，`source` 表示读取和转换正文，`build` 表示开始构建及验证。

预览结果可以包含 `verified` 和 `unverified`，例如已验证来源、原生规则与订阅契约，但尚未验证远端发布及 HTTPS 回读。四种写操作的 dry-run 不持久保存任何状态，也不补做 pending 恢复。草稿仅允许 sync 预览；pin/resume/cleanup 始终按正式配置核对。

## 环境门禁与自动运行

默认宿主读取源码 main 的当前正式配置。可信隔离环境可设置 `RULE_TARGET=acceptance-*`，并通过 `RULE_CONFIG_BRANCH` 选择 main 或与目标同名的配置分支；不接受其他分支，也不允许非 main 配置授权生产写入。每次调用及关键写入重读当前配置，不把事件 SHA、checkout 或历史结果作为重放凭证。

main 的 sync/pin/resume 写入受 `RULE_UPDATE_ENABLED` 控制，cleanup 写入独立受 `RULE_CLEANUP_ENABLED` 控制；只有值为 `true` 时启用，缺省关闭。环境门禁属于共享应用服务，CLI、Node 默认宿主和 Actions 一致；它不改变单集 auto/pinned。门禁关闭时返回配置修订、目标、`status: disabled`、`exitCode: 0` 和未应用原因。status 与 dry-run 允许只读检查，不因此获得写权限。

配置 push 调用完整 sync。schedule 通常在预检后调用 sync 和 cleanup。两个生产门禁均关闭时，直接报告这两个操作未应用。自动编排保留各阶段结果，实际操作中的失败、部分失败、未解决的 pending 和共享状态异常均使整次运行失败。普通来源故障后仍可执行安全清理，先前成功的变更继续生效。手工 sync 与 cleanup 各自执行所选操作。

每日 Actions 的内部 `schedule-preflight` 报告从正式配置、journal 和当前稳定交付获得的观察结果。`verified` 列出本次完成的检查，`observedHeads` 记录观察时的 Git heads，`results` 可包含当前交付、更新控制和待恢复交付登记。`lastFailure` 来自 journal 已保存的失败。历史候选可选性由人工 status 审计。

活动维护先交给 cleanup，确认恢复可写后再调用 sync。仅关联已登记交付、且无整体或逐集共享异常的 pending 可以路由到 sync 恢复。sync 重新读取持久状态并核对原操作、回执、摘要、意图和 heads/CAS。sync 仍 pending、共享状态未明或更新门禁关闭导致登记交付仍待恢复时，停止后续 cleanup。缺少登记依据、损坏、不可读、目标不符及迁移归属未决状态继续阻断。

Actions 的 main 目标使用 `RULE_ARTIFACT_TOKEN`；acceptance-* 目标只使用独立 `RULE_ACCEPTANCE_TOKEN`，缺少时失败，不回落生产凭据。源码配置读取使用工作流 `GITHUB_TOKEN`。隔离 token 只授予产物仓库 Contents 读写权限，但权限范围仍是仓库；分支范围由可信目标校验约束。Secret 的设置位置与最小权限见[模块凭据说明](../README.md#actions-自动与手工运行)。

同一目标的工作流使用同一 concurrency 组，业务远端校验继续生效。Actions 摘要和 JSON artifact 保存实际结果；GitHub 原生失败通知依赖账号设置，不承载独立业务邮件契约。通知设置和手工参数对照见[模块操作说明](../README.md#actions-自动与手工运行)。

## 查询

`getRulesStatus({ id? })` 额外返回 `rules[]`、`maintenance` 和存在时的 `quarantinedCandidates`。后者列出迁移隔离候选及其已知归属；归属未知时整体 pending。每集包含：

- `deliveryState`：delivered 或 not-delivered，首次构建失败不能伪装成存在旧版本。
- `expectedSource` 与 `current.source`：分别表示当前正式期望和实际交付来源；换源失败时两者可以不同。
- `successfulInput`：可选的最近成功输入事实。其 `source` 可能比 `current.source` 新。pin 可改变当前交付，既有最近成功输入仍按原候选记录。
- `control`：已接受的 auto/pinned 控制及 revision。
- `acceptedConfigurationRevision`、`configurationDifference`：上次接受修订及 add/change/delete/none 差异。
- `lifecycle`：present/deleting/deleted；待删除或待核实不等于删除已完成。
- `stableUrls`：当前交付文件的稳定地址。
- `candidates[]`：保留候选的 ID、可用版本身份/时间、真实来源、current、selectable 和不可选原因。
- `candidateCount`：可选择候选数量；不完整候选仍在列表中说明原因。
- `error`、`pendingOperation`：最近失败和待核实操作。

status 只读取，不登记操作、更新检查时间、恢复维护或发送通知。可选性检查以保留证据和当前订阅为依据；正式 pin 仍重新进行原生与兼容验证。

## 上游文件身份与回退

真实更新在规则集有适用的 `successfulInput` 时，可以用上游证据确认文件未变。候选、订阅和稳定文件必须完整，当前工具与处理策略必须符合成功记录。先处理已登记的待恢复事项。涉及恢复、上次失败、换源或证据不足的规则集回到正文处理，固定的规则集跳过上游。

- **Git** 同一实际仓库、文件路径和完整 commit 可以直接确认。分支移动时，系统从 GitHub 的固定 commit 逐级核对树，在两个 commit 的同一路径查找普通文件。只有完整树中的 blob SHA 一致且大小与已成功处理的字节相符时才省略正文。分支名、大小、符号链接和截断的树本身不能证明文件未变。缺少可信 blob 时读取当前固定 commit 的正文。
- **Release** 先解析实际 Release、tag、源码 commit 和两个附件的身份。GitHub 上传完成的正文附件 SHA-256 与已验证正文相符时，继续核对校验附件。摘要绑定本次探测得到的实际附件 ID、名称与地址，附件 ID 变化时也要重新核对摘要。校验附件可通过 GitHub 的 SHA-256 或重新读取小校验附件来确认。正文摘要缺失或任一附件的摘要无法确认相同时，进入正文处理。首次、回退和固定输入恢复时仍按附件 ID 下载，并校验校验附件的格式、目标文件和正文 SHA-256。tag、名称、源码 commit、修改时间和大小都不足以替代附件证据。

- **ChatGPT Voice** 用已成功输入的强 ETag 发起条件 GET。可信的 304 可沿用成功事实；304 未回显相同强 ETag 时退回无条件 GET。200 的正文以实际 SHA-256 核对。缺少强 ETag 时读取正文，同一操作复用本次已下载字节。恢复从候选的原始快照核对长度和 SHA-256，快照缺失或损坏时报告候选失败。

规则源适配器决定如何读取已登记的固定输入，以及恢复是否需要保留候选原始文件。候选流程按该要求登记、核验和保留快照。来源记录和候选文件路径保持原样，现有候选继续按原身份恢复。

同源规则集合并最新身份探测和必要的正文下载。各集独立核对前提并保存成功事实。当前交付可以沿用时，新 Git commit 或新 Release 的成功记录只影响下次探测，保留候选的来源、版本和首次发布时间仍取自最初交付。正式配置修订、成功事实和正文均未变时，正常同步只读取必要证据，`compile`、JSON/SRS 原生加载及 Git 提交均为 0。上游证据足以确认字节一致时，规则正文下载也为 0。

## 远端事实与版本身份

`pipeline/state.json` 使用 schema 2。`rules` 保存每集已接受定义、输入绑定、定义修订、配置修订、规则代次、lifecycle、控制、最近失败及可选的 `successfulInput`。`candidates` 保存构建、固定来源、证据及发布身份。`pendingDelivery` 登记一次未完成稳定写入，包含操作身份、配置修订、预期 stable head、目标规则事实与具体文件摘要/删除路径。状态写入还保存 `writeId`，以核实响应丢失的同一次提交。

输入绑定依据规范化来源与所选列表计算。它不含 source 别名或上游随后出现的新版本；定义修订另包含稳定路径，以及 v3 的用途或 v4 的文件基名。控制只有 auto/pinned，不再由旧激活记录的双暂停布尔值与 resumes 叠加判定。

候选文件位于 `candidates/<id>/`，仍使用固定 commit 地址、Manifest、构建记录与 readback 证据。候选首次成功发布保存 UTC ISO 8601 `publishedAt`，并以时间和候选稳定短身份组成 `versionId`，例如 `2026-11-16T12:34:56.789Z~1234abcd`。时间相同的候选仍由完整身份区分，短身份冲突时延长；不覆盖旧候选。pin、resume、重试和再次交付不刷新原版本身份或时间。有效内容与构建条件未变时，完整的当前交付可继续使用。

`successfulInput` 保存已核实的 Git、Release、官方 ChatGPT Voice 或固定 HTTPS URL 的来源身份及输入摘要，绑定 `inputBindingRevision`、`definitionRevision`、`definitionGeneration`、`toolSha256`、`buildToolsSha256`、`validationPolicy`、`nativeBuildId`、`candidateId` 和 `buildId`。规范化内容身份与定义一起约束实际产物。版本来源仍取自生成候选的原输入。

同步和恢复只在稳定规则文件的固定 commit 正文回读通过，或本次从 Git 核实完整现有交付可复用后推进该集的成功记录。共享来源的失败项保留各自此前适用的记录。同一成功事实没有观测时间字段，重复处理无需提交。缺少记录、上次失败、工具或策略变化、当前候选不匹配或候选证据不足时走常规构建和验证。共享稳定文件缺失或摘要不符时仍停止写入。实质定义变化与删除会清除旧记录。同一来源的别名变更沿用有效定义判断。

正式配置状态先单独保存。每集正常首次交付采用以下 7 个持久阶段，沿用现有 schema、分支与稳定 URL，不重写历史：

1. 登记候选，固定来源及 buildId，状态为 building。从固定 HTTPS URL 获取的原始快照与登记写在同一次提交。初版 v4 使用 `candidates/<id>/input.source.json`，ChatGPT Voice 使用 `candidates/<id>/chatgpt-voice.json`。
2. 上传 JSON/SRS，同时保存 publishing 状态。
3. 上传 Manifest、构建记录及追溯文件，同时保存规则文件所在 commit。
4. 固定 commit 的 JSON 和 SRS 正文校验通过后保存回读记录，同时保存元数据 commit、地址和已确定的版本身份。
5. 候选验证及交付准备均成功后，合并保存 verified 与 pendingDelivery。同步登记中保存核实过的候选和构建工具关联。
6. 更新稳定文件、交付记录及操作回执。
7. 从 Git 核对回执、activation 和实际变更，再校验该次稳定交付 commit 的 JSON 和 SRS 正文。依据登记的证明保存完成与成功输入，清除 pendingDelivery。删除通过 Git 核对实际结果后完成。

阶段文件与当时的 journal 同一提交；返回的 commit 指针在下一阶段保存。若文件已提交但指针未保存，按原候选固定路径核实实际提交和字节，继续原 candidateId、source、buildId 和已登记版本。不能以缺失指针认定文件未提交，或盲目重试上传。候选合格但交付准备失败，或恢复后未被选中时，单独保存 verified；29 次只是四集正常成功路径目标，故障与恢复可以增加提交。

Git 对象读取优化只复用完整 Git SHA 指定的不可变内容，缓存有界且失败请求不复用；正式配置分支、目标分支和公开仓库权限仍实时读取。每次实际写入在对象创建前和 ref 更新前核对配置、journal head、维护门禁及由 journal 约束的规则身份，更新目标 ref 前再核对目标 head，保留预期 parent 与非强制更新。移除同一次提交之外的重复预检，不移除这些写入检查；响应不明仍由 writeId 或交付回执核实。

真实 sync 按规则及稳定候选身份遍历当前有效意图下的全部 building/publishing，核对输入绑定、定义修订、规则代次及控制修订，再作普通更新或 unchanged 判断。同源分组只优化普通输入获取，不能限制恢复范围。沿用原 candidateId/source/buildId 完成 building→publishing→verified，不新增终止状态，不以同内容直接宣告 verified。已有持久回读记录时，从 Git 核对业务事实、实际字节和阶段关联，并在本次操作复验原生产物。候选规则回读尚未完成时，使用原固定输入补齐阶段。已登记的 versionId/publishedAt 必须与证据一致；journal 缺失时只从核实后的原证据恢复，不可靠或冲突的事实明确失败并保留记录。

候选恢复与选择当前交付分别处理。已有 current 时，先完成所有匹配候选的证据，再通过正常最新上游输入与兼容检查决定一次交付；即使仅有一个在途候选也不直接切换。latest 检查失败时，已恢复证据仍保留，已有稳定交付不变，整体报告失败并以 sync 继续。完整证据复验本身不重新获取候选的固定上游输入，但不能据此承诺已有 current 时上游离线也能完成整次 sync。尚无 current 且单一有效在途候选可以直接复验并交付；原已登记 pendingDelivery 沿用原操作恢复，不受该选择限制。

历史候选可作为完整非当前版本保留；多候选的遍历顺序不选择版本，也不依次交付每个候选。unchanged 不跳过在途收尾；任一候选无法恢复时，结果包含该 candidateId、具体错误及 sync 继续入口，不能因当前字节相同返回整体 success。已删除定义、换源、新控制修订和 pin 仍约束迟到任务；查询、预览和 pinned 跳过不会恢复旧意图。本边界不新增选择状态或 schema；它以已有 current 时的最新输入检查，避免 A 当前、B 中断而上游已回到 A 时误交付残留 B。

Schema 2 交付记录保存逻辑 ID、candidateId、版本身份、真实来源、订阅和当前文件摘要。v3 将记录写到 `<stablePath>/activation.json`。v4 按产物写到 `<publishPath>/_delivery/<artifact>.json`，删除该集时只移除这一条记录及它登记的 JSON/SRS。v4 交付中的 `subscription.schemaVersion: 3` 通过 `formats.source.url` 和 `formats.binary.url` 描述稳定入口。更新控制记录在 journal。生产状态/候选位于 candidates 分支，稳定记录/文件位于 main；隔离目标共用同一 acceptance 分支。

稳定写入先登记操作，再核对配置、日志 head 和维护状态，按预期 parent 非强制更新目标 ref，并读回验证。响应丢失时先识别同一次操作；不明确时返回 pending。删除移除当前受管路径及候选，并保留最小代次记录防止旧任务复活。有稳定文件或候选被删除时，结案状态提交同时设置 `deletedHistoryPending: true`。该标记汇总仍需回收的受管历史，即使当前树和候选索引均已移除对应内容。

## 证据回读

构建记录（`buildRecord: 3`）保存通过的编译和加载、工具 SHA-256、`native-compile-load-v1` 及构建身份。`readback.json`（`schemaVersion: 3`）记录候选身份、版本、首次发布时间、文件和元数据 commit，以及固定 JSON/SRS 地址的两条正文长度、SHA-256 和逐字节校验记录。清理重写物理地址并记录复验工具。Artifact Manifest v2 描述 v3 产物格式、用途、能力和摘要，Compiler 继续消费该契约。v4 的 Artifact Manifest v3 直接描述成对文件的固定地址、格式、长度和摘要。从空目标启用的步骤见 [Pipeline README](../README.md#从空产物状态启用新验证策略)。

| 操作 | 产物仓库 Raw HTTP 正文核验 |
| --- | --- |
| 新候选发布 | 候选文件所在 commit 的 JSON 与 SRS |
| 稳定交付 | 写入回执所在 commit 的 JSON 与 SRS |
| 已完成候选复选、完整成功输入复用、人工 status、预览、无回收 cleanup | 0 次 |
| cleanup 重建 | 每个保留候选在新 commit 的 JSON 与 SRS，切换后每组当前稳定分支入口的 JSON 与 SRS |
| 恢复 | 按所处阶段补齐未完成的规则回读，已提交的稳定写入先核对原回执 |

Git 中的候选登记和回读完成记录约束规则归属、来源绑定、版本和发布阶段。固定地址的 commit 由该阶段的 Git 路径历史核对。Manifest 和实际 JSON/SRS 约束字节、格式及 v3 用途。构建记录约束工具、策略和构建身份。稳定交付、保留关系和写入控制取自实际 Git 状态。候选资格无需读取 `source.json` 或 `conversion-report.json` 的正文。人工 status 通过路径盘点报告已发现的 `missingTraceFiles`，候选可选性仍由核心事实和产物决定。现有稳定文件仍可核实时，查询会展示当前交付并用 `deliveryIssue` 报告缺失或损坏的候选关联。已存在的纯追溯文件在重建时原样复制。已知文件读取或复制失败时，维护计划保持可恢复状态。

每次操作单独建立 HTTPS 字节缓存。只复用可信产物仓库中由完整 commit SHA 与路径定位、已经通过校验的字节。该操作要求校验的新规则地址首次真实 GET，即使内容摘要相同。稳定分支地址在 cleanup 切换后直接 GET。缓存最多保留 128 个地址及 64 MiB 字节，达到任一上限时按写入顺序淘汰，超限单文件直接校验。失败可重试，返回字节与缓存相互隔离。

操作结果的 `readbackRequests` 记录该次调用在产物 Raw 传输边界实际发起的地址，包含失败尝试。`verified` 描述本次核验，`reliedOn` 描述所依赖的历史成功事实。固定地址校验通过后，同次缓存命中期间可以复用该观察。Git 检查和历史事实均有各自的证据范围。

每次调用 `sync`、`pin`、`resume` 或 `cleanup` 时，首次成功的原生验证建立内存证明。后续阶段重新探测工具身份。验证策略、文件名、产物布局和工具 SHA-256 相同，且阶段核对的 JSON/SRS 与通过验证的文件逐字节相同时，可以沿用这组实际命令。字节、工具或策略变化会触发新验证或拒绝。原生命令失败或执行中检测到工具变化时，本次验证不产生证明，后续仍可重试。

发布、复验和恢复仍按各自阶段检查正式配置、更新控制、候选证据、当前保留树、订阅兼容性和 Git 写入条件。每次调用各自建立证明，即使复用同一个 Node context，或继续此前中断的操作。远端证据用于核对已保存的操作事实；恢复到需要原生验证的阶段时，使用本次调用的证明。

## 清理计划与恢复

`cleanupRuleHistory({ dryRun? })` 对整份受管状态执行维护，不接受规则 ID、版本或内部阶段参数。共同结果的 `cleanup` 包含：

| 字段 | 含义 |
| --- | --- |
| `phase` | preview/unchanged/isolated/prepared/readback/cleanup/completed/blocked，说明当前完成或待处理的位置 |
| `maintenanceId` | 存在时标识本次维护；恢复沿用同一身份 |
| `plan.candidateRetentionDays`、`plan.cleanupObservedAt`、`plan.cutoff` | 本次采用的天数、UTC 观察时间和截止时间 |
| `plan.decisions[]` | 每个候选的身份、已知版本/时间、retain/discard 及原因 |
| `plan.retain.candidateIds`、`plan.retain.active` | 保留候选集合和按 candidateId 明确指向的实际当前交付 |
| `plan.discard.candidateIds` | 本次可移除候选集合 |
| `plan.deletedHistoryPending` | 值为 `true` 时，本轮规划时有已结案的删除历史待回收。完成结果仍显示原计划 |
| `plan.blockers`、`plan.retainedBytes`、`plan.hasCleanup` | 阻塞原因、保留候选核心文件与当前稳定文件的逻辑字节数及是否存在清理工作。字节数不含纯追溯文件或 Git 对象开销 |
| `plan.otherRefs`、`otherRefs` | 盘点时和结果中观察到的非受管引用；报告而不删除 |
| `retainedCandidateCount`、`removedCandidateCount` | 能确认时返回的保留/移除数量 |
| `continueWith` | 未完成时为 cleanup，CLI 显示 `pnpm rules cleanup` |

年龄按首次成功发布的 `publishedAt` 计算，UTC 连续 24 小时计一天。`publishedAt >= cutoff` 的完整候选保留；早于 cutoff 的候选仅在没有保护依赖时删除。当前交付、pin 目标、未决操作所需证据和最小控制/删除代次均受到保护。候选退出当前身份不更新时间或重新计时；未知历史时间不伪造、不按过期处理。

启动重建须有过期且不受保护的候选、已证明失效的残留，或删除历史待回收标记。控制、来源观测和成功输入记录的变动本身仅增加操作历史。没有回收对象、阻塞项或待续维护时，`cleanup` 返回 `unchanged`。归属未知或未决写入仍可阻塞维护。隔离写入登记维护身份、时间边界和完整集合，中断恢复沿用该计划。关键写入仍核对当前定义、控制、generation 和 Git heads，冲突时停止。新基线复制保留候选的必需产物、已核对摘要的 ChatGPT Voice 原始输入及已有追溯文件，并保留实际当前 candidate/version 指针。清理保留有效候选关联的成功输入，清除被回收候选的关联。物理 commit 和证据 URL 可重写，业务 `versionId`、`publishedAt`、来源、稳定 URL 与规则字节不变。

切换前重跑 cleanup 复用或核实已准备对象；切换后继续回读、清理本次拥有且 head 一致的临时引用、恢复写入，不回滚旧基线。无法判定时保留隔离并返回 pending/failed。dry-run 只盘点已保存的状态与文件；`cleanup.unverified` 明示尚未执行的原生候选复验、新基线 HTTPS 回读和原子切换。存在活动维护时展示已固化计划，不恢复阶段、不写引用或 generation。status 在维护隔离期间报告 pending，并在当前检查点有计划时提供 cleanup 阶段、身份、截止时间与继续入口。

历史重建覆盖 candidates 和 main，隔离目标支持单分支。稳定入口核验完成且本轮临时引用处理完毕后，恢复写入的状态提交清除待回收标记。其他分支和标签只报告，它们可能使旧历史继续可达。GitHub 决定物理对象的回收时间。

## 一次性转换

以下为早期操作契约的历史转换。原生验证策略切换按上文从空状态启用。

schema 1 旧状态不能直接交给新编排，也不以缺失状态覆盖已有文件。内部转换须先核实旧状态、稳定交付和候选证据，再生成新模型；未知 schema 或无法安全归属的状态必须明确拒绝。转换预览只读，生产执行另行授权。

转换保留稳定 URL、规则字节、摘要和真实来源。有效人工固定映射为 pinned；已发生实质换源时旧固定不能复活。

本轮内部入口为 `src/rules-migration.ts` 的 `migrateRulesState({ context?, dryRun? })`，不从包入口或 CLI 导出，不接受草稿。单分支布局一次受控提交转换；双分支布局先保存旧日志维护检查点，再转换稳定交付元数据和回执，最后保存 schema 2 日志。稳定 JSON/SRS 字节不重写。

历史发布时间只从原不可变 `readback.json.publishedAt` 的有效 UTC ISO 值恢复，并在 `migration.timeEvidence` 记录证据地址。无法恢复时标记 `migrationPending`，保留现有交付与证据，不编造时间，也不把该候选当作正常可按年龄清理或选择的版本。

`quarantinedCandidates` 保存不完整候选的最小归属索引和原因，不伪造 build/source；同集显式删除会删除其文件与索引，归属无法确定时整体保持 pending 并阻止删除误报成功。`migration.pending` 列出转换时的待处理项；未完成候选的原字节保留，并在 `migration.quarantinedCandidates` 和旧状态审计快照中登记，旧任务由 head/维护隔离失效。转换结果区分 planned、converted 和 already-converted，返回 migration 审计。

转换的隔离验收和剩余项记录在 #84 交付证据；生产没有因代码合并而自动完成转换。候选年龄保留、cleanup 与 push/schedule 按本页契约处理；生产更新和清理开关默认关闭，合并代码不会自动授权转换或启用。旧维护未决状态必须先核实，不能作为新 schema 的清理计划直接重放。
