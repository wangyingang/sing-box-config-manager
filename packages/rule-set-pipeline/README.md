# Rule Set Pipeline

包名：`@sing-box-config-manager/rule-set-pipeline`。管理者需要更新系统维护的规则集合时，本模块从官方来源生成 sing-box 可加载的规则文件，验证并上传为候选。管理者可显式激活候选，检查流程也可自动激活符合条件的规则。客户端随后通过稳定地址取得当前规则；构建成功、候选验证成功、稳定入口切换和客户端加载完成是不同的状态。

当前 `update` 可发布 V2Fly `domain-list-community` 官方 Release 中 `dlc.dat_plain.yml` 的 `category-ai-!cn`，也可按管理者的 YAML 配置从同一 Release 发布多个列表。本地 `build` 同样支持配置驱动的多集构建。`activate` 与 `rollback` 均可通过 `--config ... --id ...` 按逻辑 ID 独立操作。输出包括 JSON 源规则文件和 SRS 二进制规则文件，目标版本固定为 sing-box **1.14.4**，JSON Source Format 固定为 **4**。合成 IP／混合输入用于验证构建 API，不表示已经支持其他真实来源或其发布激活。

## 操作分别产生什么结果

管理者可通过本地 CLI 操作，也可使用[独立的 GitHub Actions 工作流](docs/verification/issue-55.md)检查规则或清理历史。生产更新和清理默认关闭。各命令产生的结果如下：

| 操作 | 输入与结果 | 是否改变稳定入口 |
| --- | --- | --- |
| `build:release` | 读取指定 Release，在新目录生成经过本地原生验证的规则文件及记录 | 否；不上传 |
| `update` | 先恢复远端未完成操作；无待恢复操作时查询一次 latest，逐集发布候选 | 否；候选仍待显式激活 |
| `rebuild` | 对远端已固定且成功处理、必要证据仍保留的 Release 重建候选 | 否；保留原候选与成功处理记录 |
| `check-now` | 检查固定的最新 Release，发布并激活允许自动更新的有效变化 | 有验证通过的有效变化时 |
| `resume` | 解除所选集的人工固定并立即检查最新 Release | 所选集有验证通过的有效变化时 |
| `activate` | 复验选定候选，更新稳定规则文件及激活记录 | 是；客户端何时加载由其更新机制决定 |
| `rollback` | 复验保留的历史激活版本，新增提交恢复其规则内容 | 是；同样存在传播与轮询延迟 |
| `initialize` | 在已存在的发布分支显式创建远端恢复状态；拒绝覆盖已有状态 | 否 |
| `status` | 读取远端当前版本、候选进度、待核实操作和仍可用的回滚目标 | 否；忽略本地回执 |

“规则候选”（Rule Candidate）是一组等待验证或激活的文件；“当前规则版本”是稳定入口当前交付的版本，均不表示所有客户端已经加载该内容。例如客户端正在使用 A 时，`update` 成功只会产生候选 B；`activate` 才将稳定入口切换到 B，客户端随后按自身周期获取它。

规则自动跟随已经激活的版本，是 [ADR 0006](../../docs/adr/0006-follow-active-rule-subscriptions.md) 确认的选择：已有配置不必为每次规则更新重新发布，代价是配置快照不再固定客户端此后加载的规则字节。不可变候选、来源和验证记录仍保留，用于追溯与回滚。代码能力和历史验收结果也不代表生产入口或实际设备的当前状态。

## 本地构建：固定输入并验证规则文件

本地构建适合检查指定 Release 会产生什么规则。它不查询 latest，也不上传文件或记录 Release 已成功处理。

构建先固定 Release、tag 对应源码 commit 和资产身份，核对完整 YAML 的实际字节 SHA-256，再提取目标列表。列表必须唯一、非空，声明 length 与 rules 数量一致。不带 `--config` 的单列表构建中，YAML 损坏、目标列表包含未知类型或非法记录时，整个构建失败，不返回部分成功规则。Include 展开、attribute 筛选、affiliation、官方排序与去冗余由 V2Fly 官方构建程序完成，本模块不重新解析原始来源。

转换得到的 Rule IR 是一组不带路由或 DNS 动作的匹配条件，例如“匹配完整域名”与“匹配域名及其子域”。任一条件命中即算集合命中。随后按使用场景选择条件，称为用途投影（Projection）：

| 用途 | 选择的条件 | 用在什么位置 |
| --- | --- | --- |
| `route` | 全部适用条件 | Route 路由匹配 |
| `dns-query` | 域名条件 | DNS 请求域名匹配 |
| `dns-response` | 目标 `ip_cidr` | 已取得 DNS 响应的 IP 匹配 |

当前官方列表只有域名，因此 Route 和 DNS 请求复用同一组文件，DNS 响应用途为 `unavailable: empty`。无内容的用途不生成空匹配文件，也不能被配置绑定。每组非空内容均编译成 SRS、解码比较匹配语义，并实际加载 JSON 与 SRS；配置 `sing-box check` 成功不能代替这些规则文件检查。具体类型映射、属性与正则限制见[输入与转换边界](#输入与转换边界)。

使用 Node.js ≥24、pnpm 10.33.2。仓库根目录执行：

```sh
pnpm --dir packages/rule-set-pipeline build:release --binary /absolute/path/to/sing-box-1.14.4 --release 20261102130044 --out /tmp/ai-rules-first
pnpm --dir packages/rule-set-pipeline build:release --binary /absolute/path/to/sing-box-1.14.4 --release 20261102130044 --out /tmp/ai-rules-repeat --expected-source /tmp/ai-rules-first/source.json
```

`--binary` 必须明确提供绝对路径。构建检查版本恰为 1.14.4，记录完整 version 输出、真实路径及 binary SHA-256；不调用 PATH 中的默认 sing-box，不切换全局版本。缺失、不可执行或版本错误均失败。

`--out` 必须是尚不存在的目录，其父目录必须已存在。已有目录直接拒绝，避免覆盖历史或把失败结果混入旧产物。`--expected-source` 可核对既有来源记录的 Release、commit、资产身份和实际输入摘要；变化时失败。本地 `build` 不查询 latest。公开 API 受 GitHub 限额约束，可通过已有 `GITHUB_TOKEN` 提供只读认证，凭据不进入产物。

构建从指定官方 Release 解析 tag，并递归解引用 annotated tag 至源码 commit。资产通过固定 ID 下载，核对官方摘要记录的文件名及完整 YAML 的实际字节 SHA-256。

不带 `--config` 的单列表成功目录包含：

- `domains.json`／`domains.srs`：Source Format v4 JSON 和真实 1.14.4 编译的非空 SRS。
- `source.json`：repository、Release ID、tag、源码 commit、两份资产的 ID／地址和实际输入摘要。
- `conversion-report.json`：输入、转换、不支持、无效、重复、输出、属性记录、类型和用途计数，以及诊断。
- `build.json`：`built-validated` 状态、来源、工具版本、binary 身份、构建身份、每份产物的实际 SHA-256／字节数／term 数／能力要求，以及用途映射和原生命令验证记录。域名及目标 IP 不要求额外 Profile 能力，`requiredCapabilities` 为 `[]`。

单列表输入、转换或原生验证失败返回非零退出码，只保存诊断及已取得的来源，不生成通过状态。原生验证在临时目录完成，全部通过才写入产物；`build.json` 最后写入。写入中断可能留下不完整目录，没有完成记录就不能交付。此处的成功仅表示本地验证通过，不表示已发布 Rule Candidate、成功处理的 Release 或已激活版本。构建身份关联来源、转换工具版本、规范化 IR、原生策略 `native-projection-v2` 和 binary 摘要。运行时间、临时路径和验证日志不进入规则文件。

### 配置驱动的多规则集构建

多规则集构建使用版本化 YAML。样本见 [`samples/three-ai-rule-sets.yml`](samples/three-ai-rule-sets.yml)，其中逻辑 ID 分别选择上游完整的 `openai`、`anthropic` 和 `google-deepmind` 列表。`target` 只能是可信产物仓库的 `main` 或 `acceptance-*` 分支；每个 `stablePath` 必须是互不重叠的 `stable/` 相对路径，不能占用 `stable/activation.json`。本地构建只记录这些发布意图，不写入目标分支。

```sh
pnpm --dir packages/rule-set-pipeline build:release --binary /absolute/path/to/sing-box-1.14.4 --release 20261104112839 --config samples/three-ai-rule-sets.yml --out /tmp/three-ai-rules
pnpm --dir packages/rule-set-pipeline build:release --binary /absolute/path/to/sing-box-1.14.4 --release 20261104112839 --config samples/three-ai-rule-sets.yml --id ai-anthropic --out /tmp/anthropic-only
```

一次调用只下载并校验一份完整 YAML 和一份摘要文件，解析一次 YAML；随后按所选逻辑 ID 分别转换和原生验证。共同摘要或 YAML 文档错误使整批失败，且不创建输出目录。单个列表缺失、非法或原生验证失败时，其他列表仍可完成，CLI 返回非零。输出根目录的 `source.json` 和 `batch.json` 记录共同来源、规范化配置和逐集结果；每个逻辑 ID 子目录保存转换报告，成功时还保存规则文件及包含目标分支的构建记录，失败时保存 `failure.json`。`buildId` 包含规则定义、目标仓库与分支、实际列表、固定来源及工具身份；相同列表内容也不会混同两个逻辑 ID。

## 按逻辑 ID 显式激活

管理者提供与候选一致的可信配置、一个逻辑 ID，以及由可信宿主装配的 Rule Subscription v2 JSON。订阅的 `systemRuleSetId` 必须匹配逻辑 ID；Route 与 DNS 请求复用相同文件，DNS 响应不可用，能力要求为空。稳定 URL 必须指向配置的目标分支及该集的 `stablePath/domains.srs`，可同时提供 `domains.json`。v2 订阅示例见 [`contracts/rule-subscription-v2.example.json`](contracts/rule-subscription-v2.example.json)，使用前将示例域名替换为可信产物仓库的实际地址。

```sh
pnpm --dir packages/rule-set-pipeline activate --state /absolute/path/to/rule-state --binary /absolute/path/to/sing-box-1.14.4 --config samples/three-ai-rule-sets.yml --id ai-openai --subscription /absolute/path/to/openai-subscription-v2.json --candidate https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/FULL_COMMIT/candidates/CANDIDATE_ID/readback.json --expected-head FULL_OLD_HEAD
```

隔离验收时同时使用目标为 `acceptance-*` 的配置、对应订阅和 `--branch`。配置化激活和回滚要求[显式初始化远端状态](#正常更新与候选发布)。`--expected-head` 使用 `status` 返回的 `stableHead`。一次成功切换只提交选中集的稳定规则文件及 `stablePath/activation.json`。该记录保存候选、来源、验证、订阅、历史激活引用和人工控制。其他集的字节、控制和历史保留。

`activation.control` 保存 `revision`、`reason`、`pauseAutomaticActivation` 和 `pauseAutomaticRetry`。人工指定的原因是 `manual-activation`，暂停自动激活。人工回滚的原因是 `manual-rollback`，同时暂停自动重试和自动激活。每次成功的人工操作都会生成新修订，即使所选候选已经是当前版本。候选发布和重建不会解除固定。旧激活记录仍可查询，其中没有 `control` 时表示尚未记录人工固定。

激活先复验候选的固定 HTTPS 字节、Manifest、来源、构建身份和原生结果，再核对预期旧 head 中的该集契约和实际稳定文件。候选的不可变 HTTPS 字节还须与当前保留的 Git 文件一致。检查通过后，先在远端 journal 登记操作 ID、所选候选、原稳定 head 和维护代次，登记同时绑定已验证的规则摘要和激活记录，再提交选中集的稳定文件。生产布局在 `candidates` 登记，在 `main` 切换。隔离分支同时承担这两种用途，切换提交以登记提交为 parent。切换前复查已捕获的 journal head、代次和维护状态，以预期 parent 非强制更新稳定分支。Git API 的完整 tree/blob 用于判定旧激活记录是否存在，CDN 的 404 不作为首次激活依据。

`status` 中的 `activeRuleVersions` 按逻辑 ID 返回远端 `stablePath/activation.json` 及其当前字节核验结果，`state.candidates`／`state.configuredProcessed` 来自远端候选记录。`rollbackTargets` 仅列出必要证据仍保留且与当前订阅兼容的目标；不可用原因单独列在 `unavailableRollbackTargets`。本地激活回执仍独立保存，供诊断使用，不能覆盖远端事实。

提交回复丢失、回读失败或本地回执保存失败时，可在新目录执行同一目标的 `status`，按错误里的 operation ID 查找 `manualOperations`。这个查询不会再次写入或切换：

| 状态 | 远端依据 |
| --- | --- |
| `committed` | 当前激活记录匹配本次操作，且稳定文件的固定 commit HTTPS 地址回读通过 |
| `not-committed` | 切换请求从未发出、被明确拒绝，或稳定分支已前进且仍保留原激活记录 |
| `pending` | 分支仍可能接受在途请求，或已知提交的回读尚未完成。有 `commit` 或 `containingCommit` 时，`activeRuleVersions` 仍显示 Git 记录的当前版本 |
| `superseded` | 后续人工操作或维护已替代本次操作。历史中仍有本次激活时，附上包含该记录的 commit |

登记和切换之间中断时，预期父提交仍为当前 head 只能说明结果待核实。该分支尚未隔离在途请求时，维护须延期。在生产双分支布局下，登记仍可能写入 `main` 时，协调仓库会拒绝改变维护状态或代次。维护流程可在旧请求结束或其稳定 head 失效后重试。

## 正常更新与候选发布

先通过 `gh auth login` 配置有产物仓库写权限的现有 GitHub 身份。产物仓库固定为公开的 `wangyingang/sing-box-rule-artifacts`，需要已存在的目标分支和至少一次初始提交。CLI 复用 `gh` 登录；来源读取优先使用 `GITHUB_TOKEN`，否则读取现有 `gh auth token`，凭据只在进程内使用。

首次使用先显式初始化对应环境。默认目标 `main` 的恢复状态和候选保存在 `candidates`；隔离环境的恢复状态、候选和稳定入口位于同一 `acceptance-*` 分支。初始化不创建分支、不导入旧本地状态、不启用定时更新。已有阶段 A 候选和稳定文件保留；旧本地操作不会自动变为远端成功记录。

```sh
pnpm --dir packages/rule-set-pipeline initialize --branch acceptance-issue-48
pnpm --dir packages/rule-set-pipeline status --branch acceptance-issue-48
# 默认环境需事先初始化 candidates 分支；以下为已初始化环境的调用方式。
pnpm --dir packages/rule-set-pipeline update --state /absolute/path/to/rule-state --binary /absolute/path/to/sing-box-1.14.4
pnpm --dir packages/rule-set-pipeline status
```

配置驱动的多集候选发布传入同一份版本化 YAML；`--id` 可只处理指定逻辑 ID。首次发布先使用目标为 `acceptance-*` 的配置初始化并验收。`--state` 是可重建的本地缓存目录：

```sh
pnpm --dir packages/rule-set-pipeline update --state /absolute/path/to/rule-state --binary /absolute/path/to/sing-box-1.14.4 --config samples/three-ai-rule-sets.yml
pnpm --dir packages/rule-set-pipeline update --state /absolute/path/to/rule-state --binary /absolute/path/to/sing-box-1.14.4 --config samples/three-ai-rule-sets.yml --id ai-anthropic
pnpm --dir packages/rule-set-pipeline update --state /absolute/path/to/rule-state --binary /absolute/path/to/sing-box-1.14.4 --config samples/three-ai-rule-sets.yml --id ai-anthropic --release 20261104112839
pnpm --dir packages/rule-set-pipeline status --config samples/three-ai-rule-sets.yml --binary /absolute/path/to/sing-box-1.14.4
```

一次批量调用共享一份已固定、校验的 YAML 和摘要，随后逐集构建、原生验证并发布。共同输入损坏停止整批；单集缺表、非法条目或回读失败保留兄弟集结果。`results` 分别报告 `processed`、`skipped`、`failed`，失败项携带候选进度和已知 commit；任一集失败时 CLI 退出码为 1。`update`／`rebuild` 只写候选和恢复记录，不修改 `stable/`。

远端 `pipeline/identity.json` 标识初始化，`pipeline/state.json` 保存固定来源、操作 ID、原配置和选择、维护代次 `generation`、预期起始 head、目标分支、各阶段进度及成功处理索引。操作在候选写入前登记。每个阶段把候选文件和进度放在同一 Git 提交中，使用捕获的旧 head 作为唯一 parent。维护状态关闭、代次变化或 head 冲突均停止旧操作，不换用新 head 重放。

重新运行时先恢复远端未完成操作。`latest` 前进不改变旧操作的 Release；使用原配置和原命令恢复，也可用 `--id`／`--release` 只重试原批次中的失败集。尚未完成的文件或元数据阶段重取固定来源并核对原构建身份，工具变化报告 `RECOVERY_BUILD_CHANGED`。已经具备完整证据的候选直接核验原 HTTPS 字节和原生结果，无须重新访问上游。所有阶段复用同一候选 ID，已提交文件不会再次发布。

无待恢复操作时，`update` 查询一次官方 latest。相同定义和 Release 的成功记录只有在候选仍被保留、七份必要文件仍存在且复验通过后，才能返回 `skipped` 及证据 URL。成功处理索引与候选可用性分别判断；已清理或缺失的候选报告 `CANDIDATE_UNAVAILABLE`，不会因旧 commit 暂时还能下载而返回失效的成功地址。

`--state` 中的 `update-state.json` 只是缓存。删除它、更换运行机器或保留旧缓存，都不会改变远端来源固定和成功记录。本地保存失败返回 `cacheWarning: REMOTE_STATE_SAVED_LOCAL_CACHE_PENDING`，远端成功仍有效。`readUpdateState(directory)` API 仅供本地缓存诊断；CLI `status` 始终查询远端，兼容接收旧 `--state` 参数但不读取该目录。

未初始化报告 `REMOTE_NOT_INITIALIZED`；已有初始化标识但缺少状态报告 `REMOTE_STATE_MISSING`；坏记录报告 `REMOTE_STATE_CORRUPT`。网络读取失败也会停止操作，均不会隐式初始化。普通更新不会修复或覆盖这些状态。

提交回复丢失时先核实远端。已确认提交的阶段复用其文件；确认未提交的阶段可在原保护条件仍成立时重试。无法核实，或提交之后 head 又发生变化，报告 `PUBLICATION_PENDING` 并停止后续写入；已知 attempted commit 保留在错误中。再次运行从远端进度恢复，不能把本地异常解释成远端未提交。

`status` 返回 `authority: remote`、维护状态、`candidateAvailability` 和 `pendingOperations`。默认执行证据结构、地址和字节摘要核验，标注 `verification: structural`；提供 `--binary` 时额外执行真实原生复验，标注 `native`。已提交的当前版本即使候选回读失败也仍报告为已激活，并单独标记待核实。旧单集的历史通过 `expectedHead` 追溯，在结果映射中使用 `v2fly:category-ai-!cn`；历史读取失败通过 `historyComplete`／`historyErrors` 报告，不能将空列表视为完整历史。初始化和查询 API 分别为 `initializeRemoteState(repository, targetBranch)`、`readRemoteStatus({ repository, publication?, binary? })`。

同一缓存目录的 `update.lock/` 仍拒绝本机并发；远端预期 head 保护跨机器写入。进程被强制终止后，可换新目录恢复；要复用旧目录，先确认没有存活进程再移除残留锁。不要删除远端来源记录来绕过来源变化错误。人工固定、立即检查和主动恢复使用同一远端 journal。[工作流运行说明](docs/verification/issue-55.md)包含调度、通知和恢复步骤。

Artifact Manifest（产物清单）记录某次不可变规则文件的固定地址、摘要和使用约束。原有单集及目标为 `main` 的配置驱动更新在产物仓库的 `candidates` 分支追加候选；配置目标为 `acceptance-*` 时在该隔离分支追加候选。两者均采用三个有序的候选提交阶段，并穿插远端操作检查点，使清单可以引用已固定的 commit 地址：

1. `candidates/<candidate-id>/domains.json` 和 `domains.srs`。
2. 引用第一步完整 commit URL 的 `manifest.json`，以及 `source.json`、`conversion-report.json`、`build.json`。
3. `readback.json` 引用前两步的完整 commit、实际 HTTPS 回读摘要／字节数，以及对下载字节重新执行的原生验证记录。

发布只允许追加新的候选路径，保留父 tree，拒绝历史路径覆盖或并发非快进更新。Manifest 使用既有 v1 契约，物理产物 ID 包含候选修订；Route／DNS 请求复用文件，DNS 响应为 `unavailable: empty`。所有文件使用完整 commit 的 HTTPS URL；时间、日志和 Manifest 不进入规则文件，避免摘要循环。

远程文件逐一核对字节数、SHA-256 和逐字节内容。下载的 JSON 重新编译、解码及加载，所得 SRS 必须与下载的 SRS 一致。随后回读元数据，并在第三步提交、回读证据文件后才记为 `verified` 和成功处理。失败返回非零并保留远端阶段；重试复用原候选，补齐未完成阶段并重新核验，残缺文件不能作为通过证据。发布的 `build.json` 仅表示本地验证，只有完整远程证据及成功候选状态才能供后续激活检查。

本命令不写稳定路径、不激活候选、不修改实际客户端配置，也不切换全局 binary。首次创建产物仓库、候选发布属于外部写入，须有覆盖它们的授权；命令不自动创建仓库。

## 预览清理与维护隔离

用 `maintenance-preview` 查看当前稳定入口、人工控制、候选证据、处理进度、拟清理范围和可能保留旧历史的其他 Git 引用。预览只读取远端。保留集合覆盖配置化规则集和仍受支持的 v1 入口，当前版本的使用时长不影响保留。非当前历史和已完成的未激活候选可进入清理范围，没有最低保留天数。

```sh
node --import tsx src/cli.ts maintenance-preview --branch acceptance-example \
  --period-days 14 --start-at 2026-11-01T00:00:00Z
node --import tsx src/cli.ts maintenance-enter --branch acceptance-example --manual
node --import tsx src/cli.ts maintenance-resume --branch acceptance-example
node --import tsx src/cli.ts maintenance-abort --branch acceptance-example --maintenance-id "$maintenance_id"
```

在 `packages/rule-set-pipeline` 下运行上述命令。分支需已存在并完成远端初始化。周期和 UTC 起算点必须一起提供。首次到期时间是起算点加周期，有成功清理记录时从记录时间与起算点中较晚的一项计算。未配置时自动清理关闭，显式 `--manual` 可立即评估。JSON 的 `schedule` 表示周期状态，`status` 表示实际结果，包括关闭、未到期、无须清理、延期、已隔离和已退出。

`maintenance-enter` 检查待恢复操作和当前证据，按预期 head 取得隔离并递增代次，随后从远端重新核实并记录保留集合。候选发布中断或激活结果待核实时，先使用对应的原操作恢复。仅取消 Actions 任务不会解除远端登记。隔离期间稳定规则继续可读，候选发布和新激活写入暂停。生产 `main` 的旧版激活与回滚也需要已初始化的协调状态和远端登记。

断线后用 `maintenance-resume` 读取远端维护 ID、旧 heads 和阶段，并续做未完成的保留核实。切换前可用输出中的 `run.id` 安全退出。退出会重新核实状态和 heads，并保留递增后的代次。无法确认时会延期并维持隔离。给预览、进入或恢复传入 `--binary`，可增加当前候选的原生复验。操作流程和验证边界见 [#52 验收记录](docs/verification/issue-52.md)。

## 准备新发布基线

进入维护并记录保留集合后，显式运行准备命令：

```sh
node --import tsx src/cli.ts maintenance-prepare --branch acceptance-example --binary "$sing_box_binary"
```

使用 sing-box 1.14.4 的绝对路径。命令从远端复制当前规则字节、原规则定义和构建记录，为新提交重写 Manifest 及内部证据地址，并对新地址执行 HTTPS 回读和原生验证。处理记录仍可说明某个 Release 已处理。只有保留的候选才有证据地址。稳定订阅继续使用原 URL，固定原因和控制修订保持。

准备命令以 `maintenance-<维护 ID>-<阶段>` 创建临时分支。准备成功后，`status: prepared` 的 `baseline.stages` 列出临时分支及不可变提交，`journal` 和 `stable` 是待切换的两个 heads，单分支目标共用同一个 head。记录包含验证时间与工具摘要。准备中断后，在任意新目录重跑 `maintenance-prepare`。成功后可带同一版本的 binary 运行 `maintenance-resume`，只用新产物地址复验。当前证据或 binary 缺失会延期；准备写入或回读失败会报告失败并保持隔离。

切换前仍可按维护 ID 安全退出。准备留下的临时分支保留供核验和后续处理。准备场景见 [#53 验收记录](docs/verification/issue-53.md)。

## 切换基线并恢复写入

准备成功后，在已授权的目标上运行切换。首次切换和切换后的证据复验均使用 sing-box 1.14.4 的绝对路径。

```sh
node --import tsx src/cli.ts maintenance-switch --branch acceptance-example --binary "$sing_box_binary"
node --import tsx src/cli.ts maintenance-resume --branch acceptance-example --binary "$sing_box_binary"
```

切换通过一次 Git 原子推送更新所有目标分支，并保留旧 heads 的临时引用。每条目标分支都使用远端记录中的预期旧 head。服务器拒绝原子推送或租约过期时，旧发布状态继续有效。若远端结果待核实，使用 `maintenance-resume` 从任意新目录读取实际状态。已切换时，恢复直接核验新 heads、稳定 URL 和当前版本证据。若仍处在已准备阶段，恢复只复验准备结果；确认可继续后可再次显式运行切换。

核验成功后，Pipeline 先持久记录核验结果，再用租约删除本次维护拥有且 head 仍匹配的临时引用。清理中断可再次恢复。核验已经持久化时，恢复清理无需 binary。最终 `status: completed` 表示普通写入已恢复，`otherRefs` 列出仍存在的其他引用。其他引用和 GitHub 对旧对象的保留可能延长旧 SHA 的可读时间。

稳定 URL、规则字节、版本身份和人工固定状态跨清理保留。清理保留的当前版本日后被替换时，可用 `status` 列出的历史提交回滚。后续清理移除该版本后，旧 SHA 和依赖已清理证据的重建会明确失败。使用原状态目录运行检查或更新时，Pipeline 从远端代次恢复候选状态。复现步骤见 [#54 验收记录](docs/verification/issue-54.md)。

## 立即检查并激活

`check-now` 使用版本化配置、目标分支已初始化的远端状态和可信宿主维护的 Rule Subscription v2。订阅 JSON 文件以逻辑 ID 为键，值是该集的[完整 v2 订阅对象](contracts/rule-subscription-v2.example.json)。其中的稳定 URL 必须指向配置的目标分支和对应的 `stablePath`。以下命令用于预先创建并初始化的 `acceptance-*` 目标：

```sh
pnpm --dir packages/rule-set-pipeline check-now \
  --config /absolute/path/to/acceptance-rule-sets.yml \
  --subscription /absolute/path/to/subscriptions-by-id.json \
  --binary /absolute/path/to/sing-box-1.14.4 \
  --state /absolute/path/to/rule-state
```

默认检查配置中全部逻辑 ID。可重复 `--id` 选择其中几集。定时工作流可复用同一个 `checkRules({ configuration, subscriptions, binary, stateDirectory, selectedIds? })` 入口。

- 新批次固定一个官方 V2Fly Release，共享校验后的输入。共同输入校验失败时整批停止。单集转换、校验或确定未提交的切换失败时，其他集仍可继续。
- 定义、构建工具和订阅契约一致时，比较实际 JSON、SRS、用途映射和当前稳定文件。内容未变只更新 `state.latestChecks`，保留实际检查的 Release。定义或工具变化时重新验证，已有订阅契约不兼容时拒绝切换。
- 人工回滚暂停自动重试和激活。人工指定暂停自动激活，仍允许检查和发布候选。正常暂停不改变当前版本或控制修订。
- 候选证据与稳定入口切换分开记录。中断后使用原配置、订阅和选择恢复；未完成的构建仍固定原 Release，完整证据可从远端复验并继续激活。普通失败可在下一次检查重试。待核实的提交会出现在 `status` 的 `automaticOperations`／`pendingOperations` 中。若仍无法确认一个双分支切换是否会提交，检查保留待核实状态并停止写入。
- 每次写入使用已捕获的分支 head 和维护代次。恢复时核对原控制修订，运行中发生人工切换、维护或并发写入会拒绝旧任务继续提交。
- 每集结果为 `activated`、`unchanged`、`paused`、`failed` 或 `verification-pending`。摘要附当前交付版本、人工控制和已核实的回滚目标。实际失败或待核实使 CLI 退出 1。已知提交即使仍待 HTTPS 回读，也会反映在当前交付版本中。可重建的本地缓存失败单列为 `cacheWarning`。

`update` 和 `rebuild` 仍只发布候选，显式激活和回滚仍保留人工固定语义。验收场景见 [Issue #50](docs/verification/issue-50.md)。

## 恢复单集跟随最新来源

`resume` 为已有当前规则版本的一集保存新的控制修订，解除人工固定，再使用与 `check-now` 相同的检查流程。命令需要且只接受一个逻辑 ID，并读取与 `check-now` 相同的配置和订阅映射。以下命令适用于已初始化的隔离目标：

```sh
pnpm --dir packages/rule-set-pipeline resume \
  --config /absolute/path/to/acceptance-rule-sets.yml \
  --subscription /absolute/path/to/subscriptions.json \
  --state /absolute/path/to/state \
  --binary /absolute/path/to/sing-box \
  --id ai-openai
```

- 首次检查直接读取最新官方 Release。暂停期间的中间 Release 不补跑。最新 Release 如果曾被回滚，仍可以在验证通过后采用。
- 验证失败时继续交付当前版本，恢复决定仍有效。下一次 `check-now` 可以重试。恢复决定提交后、检查开始前中断时，可在新目录运行同一条 `resume` 命令继续。普通 `check-now` 也会读取该决定。
- 恢复会保留其他操作已固定的 Release、候选进度和结果。其他操作可用原命令继续。如果单集恢复已固定 Release 后中断，包含该集的普通批次可用同一 Release 继续检查。若其他选中集仍有在途批次或已检查更新的 Release，按原选择继续恢复检查。双分支目标若有仍可能提交的稳定切换，须先核实切换结果，才能保存恢复决定。
- `status` 中的 `activeRuleVersions[逻辑 ID].control` 表示当前有效控制状态，`activation` 保存原激活记录。尚未完成的恢复检查在 `pendingOperations` 中显示为 `resume-check-pending`。后来人工指定或回滚会重新固定该集。
- 稳定 URL 和客户端配置沿用原值。客户端按原生更新周期加载后续规则。

包入口为 `resumeRules({ logicalId, configuration, subscriptions, stateDirectory, binary, ... })`。验收场景见 [Issue #51](docs/verification/issue-51.md)。

## 显式重建固定 Release

`update` 会跳过相同定义下已成功处理的 Release。同一 Release 增选另一集，或修改所选集的列表、稳定路径或发布目标时，会处理对应的新定义。管理者需要用当前转换器或验证流程重新处理已经成功的定义时，使用 `rebuild`，并指定远端已成功处理、必要来源与候选证据仍保留的固定 Release tag：

```sh
pnpm --dir packages/rule-set-pipeline rebuild \
  --state /absolute/path/to/rule-state \
  --release 20261102130044 \
  --binary /absolute/path/to/sing-box-1.14.4

# 配置驱动的重建必须同时指定配置和逻辑 ID；可重复 --id 选择多集。
pnpm --dir packages/rule-set-pipeline rebuild \
  --state /absolute/path/to/rule-state \
  --config samples/three-ai-rule-sets.yml --id ai-openai \
  --release 20261104112839 \
  --binary /absolute/path/to/sing-box-1.14.4
```

`rebuildRules({ stateDirectory, release, binary, ... })` 与 CLI 使用同一入口。拒绝 `latest`、未固定或尚未成功处理的 Release；通过持久记录中的 Release ID 获取元数据，并重新核对 tag、源码 commit、资产身份及实际输入摘要。来源变化明确失败，不覆盖固定记录。

配置驱动的 API 再传入 `configuration` 和非空 `selectedIds`。每个所选集都须在该 Release 下以相同定义及发布目标成功处理过；新增或变更定义先使用 `update`。重建结果使用与批量更新相同的逐集 `results`，任一集失败时 CLI 返回退出码 1。`status` 保留原 `configuredProcessed` 成功记录，并在 `candidates` 中列出带有 `logicalId`、`operation: rebuild` 和 `previousCandidateId` 的新尝试。

重建复用正常更新的转换、原生验证、不可变发布和 HTTPS 回读门禁。每个新重建操作保存新候选 ID、操作类型、原成功候选 ID 和构建身份；中断后恢复同一个重建操作时复用其候选 ID。`build.json` 记录输入、转换器实现摘要、Node／yaml 版本、目标 binary 的 SHA-256、契约版本和实际产物摘要。实现摘要覆盖当前运行的来源读取、解析、转换、投影与原生验证代码；TypeScript 源码和编译后 JavaScript 分别记录各自实际运行实现的摘要。

成功和失败均保留原成功处理记录、固定来源及历史候选；失败可按原命令重试。相同输入与工具的规则字节及构建身份保持一致，候选 ID 和验证运行记录独立保存。重建不写稳定入口或激活回执，正常更新仍在无新 Release 时跳过。后续激活使用既有 `activate --candidate <new-readback-url>` 流程；激活验证同时支持历史构建身份和显式记录契约版本的新身份，拒绝不支持的契约版本。

## 显式激活

激活把候选文件交给稳定入口，开始影响后续客户端下载。Rule Subscription（规则订阅）描述“哪些稳定地址可用于哪些用途、格式和客户端能力”；它不记录某次规则字节的固定摘要，也不承担面向使用者的配置订阅授权。当前 Compiler 消费契约见 [Rule Subscription v2](contracts/rule-subscription-v2.md)；按逻辑 ID 的激活使用 v2；不带配置的旧单集激活仍使用 [v1 历史契约](contracts/rule-subscription.md)。

管理者选择已发布候选的完整 commit `readback.json` URL，提供可信宿主维护的规则订阅契约和预期旧分支 head。head 是目标分支当前的完整 commit；提供预期值是为了在其他会话已经更新分支时拒绝覆盖。`activate` 复用已有候选，不查询 Release、不重做来源转换、不改写成功处理记录。

```sh
pnpm --dir packages/rule-set-pipeline activate \
  --state /absolute/path/to/rule-state \
  --candidate https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/<full-evidence-commit>/candidates/<candidate-id>/readback.json \
  --subscription /absolute/path/to/trusted-rule-subscription.json \
  --expected-head <full-old-branch-commit> \
  --binary /absolute/path/to/sing-box-1.14.4
```

默认目标为产物仓库 `main`。隔离验收可指定 `--branch acceptance-<name>`，分支须事先建立。创建隔离分支、执行 CLI 均不替代生产切换授权；[#19 历史验收](docs/verification/issue-19.md)只使用 `acceptance-issue-19`。本入口保留首个 `category-ai-!cn` 纯域名交付切片，受配置化规则集占用的稳定路径由对应逻辑 ID 管理；拒绝其他系统规则集、目标 IP 投影和未知能力，不猜测兼容。既有 Manifest 的 `v2fly:category-ai-!cn` 映射到订阅契约中的 `v2fly:domain-list-community:category-ai-!cn`。

激活重新下载候选的六份文件并核对回读链、来源、Conversion Report、构建身份、实际摘要／字节数／非空 term 数、用途映射及能力。重新用指定 1.14.4 编译、解码、加载实际 JSON，并逐字节比对 SRS。本地 `verified`、单独的 `passed` 或 `build.json` 不能放行。明确标识 `kind: synthetic`、description 和 revision 的合成候选只可进入 `acceptance-*` 分支。

规则订阅中的全部入口须指向目标分支的 `stable/`，默认 SRS，也可维护契约声明的 JSON。首次激活后，后续激活须保持完整订阅契约及入口不变。每次以预期旧 head 为唯一父提交，在一个 tree／commit 内更新所有稳定文件和 `stable/activation.json`；非强制 PATCH 拒绝并发覆盖。激活记录保存候选证据、来源、契约、原生验证身份和稳定文件摘要。旧激活记录通过预期旧 commit 的 Git tree／blob 读取；只有完整 tree 证明缺失才视为首次激活，不能凭 raw CDN 的临时 404 绕过契约保护。API 故障、tree 截断及坏记录均拒绝激活。

Git 提交保持文件与记录一起更新，但 GitHub 缓存和客户端轮询存在传播延迟，不保证多文件在客户端同时切换。激活不修改 Recipe、配置发布或客户端设置。运行中的 sing-box 通过原生机制获取稳定 SRS；受控测试的 `1s` 更新周期和临时 CA 只存在于测试进程，不能用于承诺全设备更新时间。

公开 API 为 `activateRules({ candidateEvidenceUrl, subscription, binary, expectedHead, transport?, configuration?, logicalId?, stateDirectory? })`；默认使用 `githubActivation()`。配置化激活同时传入 `configuration` 与 `logicalId`；提供 `stateDirectory` 时，由 API 保存该集本地回执。旧单集由 CLI 保存回执。API 的成功结果和远端记录可跨进程追溯。Compiler 仍只消费契约，不导入激活运行时代码。

## 激活失败后核实远端状态

候选检查失败时，稳定入口未被这次操作修改。提交阶段发生错误时，不能仅凭命令失败就断言旧版本未变。PATCH 回复丢失后，实现先读取远端 head，对照本次已创建的 attempted commit；确认该提交已成为 head 时继续回读，不重复写入。

| 结果 | 已知状态与后续处理 |
| --- | --- |
| `ACTIVATION_NOT_APPLIED` | 配置化切换在发出 ref 更新前终止，或 GitHub 明确拒绝了更新。对旧单集，远端仍为预期旧 head |
| `ACTIVATION_UNKNOWN` | 无法确认是否已切换，先用 `status` 核实远端状态 |
| `ACTIVATION_CONFLICT_OR_SUPERSEDED` | 远端是其他提交；可能发生冲突或本次提交已被后续操作替代，须核对当前激活记录 |
| `ACTIVATION_APPLIED_READBACK_PENDING` | 提交已生效，但完整 commit HTTPS 地址的逐字节回读尚未完成；错误保留该 commit，不能声称旧规则未变 |
| `ACTIVATION_APPLIED_LOCAL_RECEIPT_PENDING` | 远端已经激活，本地回执目录创建、写入或 rename 失败；错误保留已生效 commit，不应重复激活 |

需要重试时，先核实本次操作的结果。确认未提交后，用最新的 `stableHead` 发起新的人工操作。`status` 从远端稳定记录和字节报告当前版本及待核实状态；仍须核对本次 attempted commit，不能只凭本地回执重试。

## 历史回滚

配置化回滚从所选集历史 `<stablePath>/activation.json` 所在完整 commit 选择已激活版本；旧单集使用 `stable/activation.json`。历史记录及其候选必须仍然保留；本命令不查询 Release、不重新转换来源，也不重新发布配置。

```sh
pnpm --dir packages/rule-set-pipeline rollback \
  --state /absolute/path/to/state \
  --activation <historical-full-commit> \
  --subscription /absolute/path/to/trusted-subscription.json \
  --expected-head <current-full-commit> \
  --binary /absolute/path/to/sing-box
```

配置化回滚同时添加 `--config /absolute/path/to/rule-sets.yml --id ai-openai`，一次只回滚一集。历史记录的逻辑 ID、候选归属及 v2 订阅必须与所选集一致。来源列表可以与当前配置不同；历史构建按原定义复核，稳定路径与目标分支仍须匹配当前配置。该集恢复历史规则字节、追加回滚记录并暂停自动重试和自动激活。其他集的稳定文件、控制、当前版本及历史保持不变。

隔离环境显式添加 `--branch acceptance-<name>`，契约入口须属于该分支。公开 API 为 `rollbackRules({ historicalActivationCommit, subscription, binary, expectedHead, transport?, configuration?, logicalId?, stateDirectory? })`。配置化回滚同时提供 `configuration` 与 `logicalId`；提供 `stateDirectory` 时保存该集本地回执。

回滚读取历史激活记录，核对当前完整订阅契约，重新执行正常激活的所有候选门禁，并比对历史稳定文件的实际字节及记录摘要。缺失、损坏、空内容或不兼容均在写入前拒绝。成功时只新增一次稳定入口提交，记录 `operation: rollback`、`historicalActivationCommit` 和 `historicalActivationId`；候选、Manifest、原验证记录及 `update-state.json` 均不改写。

回滚沿用激活的预期旧 head、并发保护、不确定结果核实和本地回执行为，返回 `status: activated`；操作类型在 `activation.operation` 中区分。客户端按原生更新机制恢复历史规则，允许传播延迟。历史版本选择不支持跨环境迁移或同时修改订阅契约。

## 客户端更新失败与缓存恢复

已经成功加载 A 的 sing-box，在后续下载或加载 B 失败时继续使用原内存规则。仓库的受控测试实际注入断开连接、HTTP 503、截断 SRS 和非法 SRS，通过新的 Route／DNS 请求证明 A 仍有效；解除故障后，再证明 B 生效。这四类注入不代表已经动态验证所有故障。

跨进程恢复是另一件事。只有有效规则已成功写入持久缓存，新进程才可能在离线时恢复它。受控测试在成功持久化 B 后，关闭客户端和规则服务，再用相同配置与缓存路径启动新进程，并通过新请求证明 B 恢复。首次启动无有效缓存、缓存损坏或无法写入缓存时，不具有跨重启旧规则保证。

原生客户端不额外校验 Artifact Manifest 摘要，合法但错误的内容不能依靠客户端摘要检查阻止。合法空 SRS 也可能被接受，必须依靠发布端激活门禁拒绝。缓存写入失败不会回滚已经生效的内存规则，因此“运行中已经更新”不表示“重启后一定恢复”。缓存写入失败的边界来自固定版本源码核对，现有验收未注入真实磁盘写入失败。

更新周期和缓存由实际客户端配置决定，本项目不统一强制设置。受控测试中的临时 CA、`1s` 周期及持久缓存仅是测试条件。具体执行方式见[客户端故障与缓存离线恢复（#21）](#客户端故障与缓存离线恢复21)，原生边界与已执行证据见 [#21 验收记录](docs/verification/issue-21.md)。

## 输入与转换边界

公开 Node API 由包入口导出：

- `readRelease(options)`：获取并核验固定来源；失败抛出异常。
- `readTargetList(bytes)`：解码一次 YAML，只提取唯一、非空且声明长度正确的 `category-ai-!cn`；返回带位置的来源记录或诊断。
- `convertRules(records)`：与 YAML 无关的 Rule IR 转换、相等去重和排序；失败不返回部分 Rule IR。
- `renderDomainJson(terms)`：将成功转换的 Rule IR 写成 v4 JSON；拒绝空集合。
- `buildRelease(options)`：保留 #15 的输入／转换接口，返回 `built-unvalidated` JSON 或失败报告，不执行原生验证或发布。
- `projectTerms(terms)`／`renderRuleJson(terms)`：固定排序、相等去重及 Route／DNS 请求／DNS 响应投影，拒绝零有效内容。`BuildTerm` 另允许合成目标 `ip_cidr`；不增加 V2Fly IP 语法或输入源。
- `buildNative(terms, absoluteBinary)`：编译、解码、规范化语义比较及真实加载；返回已验证的内存字节、元数据和验证记录，失败抛出异常。CLI 组合 `buildRelease` 与 `buildNative`。
- `decodedTerms(value)`：将支持的平铺 OR 规则还原为排序、去重的 term；容忍解码器的 Source Format 版本和单值表示差异，拒绝逻辑规则、混合 AND 字段及未知字段。

`domain/full/keyword/regexp` 分别映射为 `domain_suffix/domain/domain_keyword/domain_regex`。每种谓词单独放在一条 Headless Rule 中，规则集合保持 OR 语义。只对同类型、同值去重，按上述类型顺序和字符串代码单元顺序排序。规范化会复制为固定 `{type, value}` 结构，调用方的对象字段顺序不影响验证或构建身份。

非正则值的 `:@attr1,@attr2` 尾部被分离；属性记录仍转换，不在本地筛选。regexp 保留表达式；字面 `:@` 导致失败。保留大小写、Unicode、尾点和正则转义，不执行 IDNA 或表达式改写。空值、非法字符、域名空 label／非法边界／超长 label 均失败。正则不使用 JavaScript 引擎预判，目标 Go 引擎由原生加载步骤检查。1.14.4 在 regexp 匹配前将请求域名转为小写，但不改写表达式；大写字面表达式不会因此变成大小写无关。

IP 语义比较使用固定 `ipaddr.js 2.5.0` 解析地址，按 IPv4／IPv6 地址区间集合比较，接受目标引擎对相邻或包含 CIDR 的等价表示；地址集合扩大或缺失均失败。该规范化只用于比较，不聚合或改写生成 JSON 的 CIDR。JSON 的 `termCount` 按投影 IR 计数，SRS 按实际解码 term 计数，两者可能因原生归并而不同。

YAML 解析使用固定版本的 [yaml](https://eemeli.org/yaml/)，拒绝语法错误、重复 key、未知 tag、多个文档和 alias。记录级诊断包含文件、列表、从零开始的记录 index，以及从一开始的 line／column。列表级诊断以文件与目标列表定位。

每个非空用途分别生成 JSON／SRS，内容相同的用途复用同一组物理文件。纯域名文件同时供 Route 和 DNS 请求复用。纯 IP 的 Route／DNS 响应同样复用，混合 IR 分别输出三组文件。当前官方纯域名列表的 DNS 响应用途为 `{ status: "unavailable", reason: "empty" }`，不生成空匹配文件。`build.json` 是本地构建记录，不能作为 Compiler 的 Artifact Manifest 使用。[固定产物 Manifest v1](contracts/README.md) 继续保持原有契约，Compiler 不导入 Pipeline 运行时代码。

## 自动化验证

已有交付的执行证据分别见 [#15 固定来源转换](docs/verification/issue-15.md)、[#16 JSON／SRS 与原生验证](docs/verification/issue-16.md)、[#18 候选发布与回读](docs/verification/issue-18.md)、[#19 激活与自动更新](docs/verification/issue-19.md)、[#20 历史回滚](docs/verification/issue-20.md)、[#21 故障与缓存恢复](docs/verification/issue-21.md)及 [#22 固定 Release 重建](docs/verification/issue-22.md)。这些记录说明各次验收的范围与结果，不证明生产当前版本或全部设备状态。

```sh
pnpm --dir packages/rule-set-pipeline test
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 pnpm --dir packages/rule-set-pipeline test:integration
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 pnpm --dir packages/rule-set-pipeline test:release
pnpm check
```

常规测试离线运行，纳入现有 `pnpm check` 和 CI。固定样本包含官方目标列表原文摘录、完整资产的来源身份及预期 JSON；摘录不能代替完整资产摘要校验。`test:release` 需联网，通过真实 CLI 两次下载完整固定 Release，核对完整来源、两种文件的实际字节摘要及确定性，并验证原生失败没有完成记录，不随 latest 漂移。网络错误、限额或来源变化会使验收失败。

`test:integration` 使用固定真实样本和合成 IR，通过 `rule-set match` 实际读取、初始化并匹配 JSON／SRS。非法 Go regexp 会在此被拒绝，不能以编译或配置 `check` 代替加载。测试覆盖域名边界、regexp 大小写、IPv4／IPv6 投影、相邻 CIDR 归并等价性及扩大／缺失反例、term 字段顺序、独立构建确定性及编译／解码／加载／语义错配故障；现有 native CI 自动执行此脚本。

`pnpm build` 输出 Node ESM 和 TypeScript 声明至 `dist/`。本包不提供浏览器运行时，运行时代码不导入 Compiler。集成验收通过 devDependency 声明 Compiler 的准备顺序；`test:integration`、`test:activation` 和 `test:release` 在加载跨模块测试前生成 Compiler validator，干净 checkout 不依赖已有构建文件。

固定官方样本的真实公开发布验收需要显式提供以下环境变量；它会在产物仓库追加候选，请仅在获得发布授权后执行：

```sh
RULE_PUBLICATION_STATE=/tmp/fresh-isolated-rule-state \
RULE_PUBLICATION_EVIDENCE=/tmp/fresh-publication-evidence.json \
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
pnpm --dir packages/rule-set-pipeline test:publication
```

该验收固定 Release `20261102130044`，状态目录需尚未成功处理此样本，证据输出文件需不存在；此入口不是同一 Release 的显式重建命令。正常更新 CLI 不接受固定 tag；重建使用[独立的 rebuild 命令](#显式重建固定-release)。受控集成测试不访问真实 GitHub 写接口，自动覆盖上传、远程回读、来源变化和重试边界。

固定官方候选的真实激活验收（候选需已通过 #18 发布，证据文件需不存在）：

```sh
RULE_ACTIVATION_BRANCH=acceptance-<existing-name> \
RULE_ACTIVATION_CANDIDATE=https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/<full-commit>/candidates/<id>/readback.json \
RULE_ACTIVATION_EXPECTED_HEAD=<full-old-head> \
RULE_ACTIVATION_EVIDENCE=/tmp/fresh-activation-evidence.json \
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
pnpm --dir packages/rule-set-pipeline test:activation
```

该命令真实更新隔离分支，分别回读不可变提交和稳定 HTTPS URL，再通过公开 Recipe／Compiler 接口生成稳定 SRS 配置并执行原生检查。受控 A／B 自动更新测试随 `test:integration` 运行，需本机 `openssl`；通过 loopback HTTPS、临时 CA 和配置内的 HTTP 隧道隔离网络，不改 hosts 或系统信任。它使用内存 Git transport，提交身份不代表真实 GitHub commit；与真实发布证据分别保存。

### 客户端故障与缓存离线恢复（#21）

`test/integration/client-failure-recovery.test.ts` 随 `test:integration` 和 native CI 自动运行，复用 Compiler 订阅入口与 #19 的 loopback HTTPS 验收方式。测试使用独立临时目录、缓存文件、动态端口和测试专用 `acceptance-issue-21` URL；不写远程分支，也不依赖 #20 的状态。单独运行并保存机器证据：

```sh
pnpm --filter @sing-box-config-manager/config-compiler generate:validator
cd packages/rule-set-pipeline
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
RULE_CLIENT_FAILURE_EVIDENCE=/absolute/path/to/issue-21.evidence.json \
node --import tsx --test test/integration/client-failure-recovery.test.ts
```

测试通过 A／B 域名的正反 Route／DNS 新请求，分别证明四类更新故障后 A 仍有效、故障解除后 B 生效，以及停止客户端和规则服务后从持久缓存重启恢复 B。运行期间保持同一配置；重启前后的证据分开保存。临时 CA、DNS 缓存禁用、`1s` 更新周期与持久缓存仅属于受控测试，不是实际客户端的统一要求。测试结束清理进程、监听器及临时目录，结果保留在指定证据文件和 CI 日志中。

具体执行证据与未覆盖边界见 [#21 验收记录](docs/verification/issue-21.md)；行为限制见[客户端更新失败与缓存恢复](#客户端更新失败与缓存恢复)。

### 固定 Release 重建验收（#22）

真实重建验收固定官方样本，使用专属状态目录与 `acceptance-issue-22-<suffix>` 远程分支。它发布原候选和重建候选、注入原生失败并重试、回读历史文件，并通过固定样本元数据适配器检验正常更新的 latest 跳过路径（不将旧样本声称为真实 latest）：

```sh
RULE_REBUILD_STATE=/tmp/issue-22-fresh-state \
RULE_REBUILD_EVIDENCE=/tmp/issue-22-fresh-evidence.json \
RULE_REBUILD_BRANCH=acceptance-issue-22-<unique-suffix> \
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
pnpm --dir packages/rule-set-pipeline test:rebuild
```

### 多集增选与单集重建验收（#38）

固定官方 Release `20261104112839`，先仅发布 OpenAI，再增选 Anthropic，随后重建 OpenAI。使用新的本地状态目录及专属隔离分支，回读原候选、兄弟候选及重建候选，并注入缺失 binary 的失败以验证重试。验收不执行激活。执行证据见 [#38 验收记录](docs/verification/issue-38.md)。

```sh
cd packages/rule-set-pipeline
RULE_CONFIGURED_REBUILD_STATE=/tmp/issue-38-fresh-state \
RULE_CONFIGURED_REBUILD_EVIDENCE=/tmp/issue-38-fresh-evidence.json \
RULE_CONFIGURED_REBUILD_BRANCH=acceptance-issue-38-<unique-suffix> \
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
node --import tsx --test test/acceptance/configured-rebuild.test.ts
```

单集 v2 回滚与同进程客户端换源验收见 [Issue #40](docs/verification/issue-40.md)。
