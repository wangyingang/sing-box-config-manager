# Rule Set Pipeline

包名：`@sing-box-config-manager/rule-set-pipeline`。已实现 [#15](https://github.com/wangyingang/sing-box-config-manager/issues/15) 的固定来源转换，以及 [#16](https://github.com/wangyingang/sing-box-config-manager/issues/16) 的确定性 JSON／SRS、本地原生验证和用途投影。另已实现 [#18](https://github.com/wangyingang/sing-box-config-manager/issues/18) 的正常更新、不可变候选发布与 HTTPS 回读。另已实现 [#19](https://github.com/wangyingang/sing-box-config-manager/issues/19) 的显式激活与受控客户端自动更新。验收记录见 [#15](docs/verification/issue-15.md)、[#16](docs/verification/issue-16.md)、[#18](docs/verification/issue-18.md) 和 [#19](docs/verification/issue-19.md)。另已实现 [#20](https://github.com/wangyingang/sing-box-config-manager/issues/20) 的历史激活回滚，验收见 [#20](docs/verification/issue-20.md)。客户端故障保留与缓存离线恢复已由 [#21](docs/verification/issue-21.md) 验证。

## 本地构建

使用 Node.js ≥24、pnpm 10.33.2。仓库根目录执行：

```sh
pnpm --dir packages/rule-set-pipeline build:release --binary /absolute/path/to/sing-box-1.14.4 --release 20261102130044 --out /tmp/ai-rules-first
pnpm --dir packages/rule-set-pipeline build:release --binary /absolute/path/to/sing-box-1.14.4 --release 20261102130044 --out /tmp/ai-rules-repeat --expected-source /tmp/ai-rules-first/source.json
```

`--binary` 必须明确提供绝对路径。构建检查版本恰为 1.14.4，记录完整 version 输出、真实路径及 binary SHA-256；不调用 PATH 中的默认 sing-box，不切换全局版本。缺失、不可执行或版本错误均失败。

`--out` 必须是尚不存在的目录，其父目录必须已存在。已有目录直接拒绝，避免覆盖历史或把失败结果混入旧产物。`--expected-source` 可核对既有来源记录的 Release、commit、资产身份和实际输入摘要；变化时失败。本地 `build` 不查询 latest。公开 API 受 GitHub 限额约束，可通过已有 `GITHUB_TOKEN` 提供只读认证，凭据不进入产物。

构建从指定官方 Release 解析 tag，并递归解引用 annotated tag 至源码 commit。资产通过固定 ID 下载，核对官方摘要记录的文件名及完整 YAML 的实际字节 SHA-256。

成功目录包含：

- `domains.json`／`domains.srs`：Source Format v4 JSON 和真实 1.14.4 编译的非空 SRS。
- `source.json`：repository、Release ID、tag、源码 commit、两份资产的 ID／地址和实际输入摘要。
- `conversion-report.json`：输入、转换、不支持、无效、重复、输出、属性记录、类型和用途计数，以及诊断。
- `build.json`：`built-validated` 状态、来源、工具版本、binary 身份、构建身份、每份产物的实际 SHA-256／字节数／term 数／能力要求，以及用途映射和原生命令验证记录。域名及目标 IP 不要求额外 Profile 能力，`requiredCapabilities` 为 `[]`。

输入、转换或原生验证失败返回非零退出码，只保存诊断及已取得的来源，不生成通过状态。原生验证在临时目录完成，全部通过才写入产物；`build.json` 最后写入。写入中断可能留下不完整目录，没有完成记录就不能交付。此处的成功仅表示本地验证通过，不表示已发布 Rule Candidate、成功处理的 Release 或已激活版本。构建身份关联来源、转换工具版本、规范化 IR、原生策略 `native-projection-v2` 和 binary 摘要。运行时间、临时路径和验证日志不进入规则文件。

## 正常更新与候选发布

先通过 `gh auth login` 配置有产物仓库写权限的现有 GitHub 身份。产物仓库固定为公开的 `wangyingang/sing-box-rule-artifacts`，需要已存在且至少有一次初始提交。CLI 复用 `gh` 登录；来源读取优先使用 `GITHUB_TOKEN`，否则读取现有 `gh auth token`，凭据只在进程内使用。

```sh
pnpm --dir packages/rule-set-pipeline update --state /absolute/path/to/rule-state --binary /absolute/path/to/sing-box-1.14.4
pnpm --dir packages/rule-set-pipeline status --state /absolute/path/to/rule-state
```

每次 `update` 只在开始查询一次官方 latest。发现新 Release 后，固定该响应的 Release ID、tag 和资产身份，解析 tag 的源码 commit，复用本地完整来源校验、转换和原生构建路径。已成功处理的相同 Release 只检查 latest 元数据；资产身份改变时失败，否则跳过 YAML／摘要下载、转换和 binary 执行。跳过时不会重新下载同一资产来探测其内容变化；失败重试取得字节时会核对已保存的来源摘要。

`--state` 必须指向可保留的本地目录。`update-state.json` 用原子 rename 保存来源固定记录、各次候选状态和已成功处理的 Release。三者分别管理；`status` 可在后续进程恢复查看。最近一次本地激活回执从独立的 `active-version.json` 读取，缺失表示此目录没有回执；update 不写该文件。远端 `stable/activation.json` 才是当前规则版本的权威记录，本地回执可能落后于其他管理会话。不要把隔离验收目录的 `null` 理解成实际设备没有激活版本。

同一状态目录通过 `update.lock/` 拒绝并发更新。正常退出或失败会清理锁；进程被强制终止后，须确认没有存活的更新进程，再删除残留锁目录重试。保留状态目录以继续核对固定来源；不要删除来源记录来绕过来源变化错误。

候选在产物仓库的 `candidates` 分支追加，采用三个有序提交：

1. `candidates/<candidate-id>/domains.json` 和 `domains.srs`。
2. 引用第一步完整 commit URL 的 `manifest.json`，以及 `source.json`、`conversion-report.json`、`build.json`。
3. `readback.json` 引用前两步的完整 commit、实际 HTTPS 回读摘要／字节数，以及对下载字节重新执行的原生验证记录。

发布只允许追加新的候选路径，保留父 tree，拒绝历史路径覆盖或并发非快进更新。Manifest 使用既有 v1 契约，物理产物 ID 包含候选修订；Route／DNS 请求复用文件，DNS 响应为 `unavailable: empty`。所有文件使用完整 commit 的 HTTPS URL；时间、日志和 Manifest 不进入规则文件，避免摘要循环。

远程文件逐一核对字节数、SHA-256 和逐字节内容。下载的 JSON 重新编译、解码及加载，所得 SRS 必须与下载的 SRS 一致。随后回读元数据，并在第三步提交、回读证据文件后才记为 `verified` 和成功处理。任何失败返回非零，保存失败候选；重试创建新的候选并重新获取、验证，不把残留文件当作通过证据。发布的 `build.json` 仅表示本地验证，只有完整远程证据及成功候选状态才能供后续激活检查。

本命令不写稳定路径、不激活候选、不修改实际客户端配置，也不切换全局 binary。首次创建产物仓库、候选发布属于外部写入，须有覆盖它们的授权；命令不自动创建仓库。

## 显式激活

管理者选择已发布候选的完整 commit `readback.json` URL，提供可信宿主维护的规则订阅契约和预期旧分支 head。`activate` 复用已有候选，不查询 Release、不重做来源转换、不改写成功处理记录。

```sh
pnpm --dir packages/rule-set-pipeline activate \
  --state /absolute/path/to/rule-state \
  --candidate https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/<full-evidence-commit>/candidates/<candidate-id>/readback.json \
  --subscription /absolute/path/to/trusted-rule-subscription.json \
  --expected-head <full-old-branch-commit> \
  --binary /absolute/path/to/sing-box-1.14.4
```

默认目标为产物仓库 `main`。隔离验收可指定 `--branch acceptance-<name>`，分支须事先建立。创建隔离分支、执行 CLI 均不替代生产切换授权；当前 #19 验收只使用 `acceptance-issue-19`。本入口只覆盖首个 `category-ai-!cn` 纯域名交付切片；拒绝其他系统规则集、目标 IP 投影和未知能力，不猜测兼容。既有 Manifest 的 `v2fly:category-ai-!cn` 映射到订阅契约中的 `v2fly:domain-list-community:category-ai-!cn`。

激活重新下载候选的六份文件并核对回读链、来源、Conversion Report、构建身份、实际摘要／字节数／非空 term 数、用途映射及能力。重新用指定 1.14.4 编译、解码、加载实际 JSON，并逐字节比对 SRS。本地 `verified`、单独的 `passed` 或 `build.json` 不能放行。明确标识 `kind: synthetic`、description 和 revision 的合成候选只可进入 `acceptance-*` 分支。

规则订阅中的全部入口须指向目标分支的 `stable/`，默认 SRS，也可维护契约声明的 JSON。首次激活后，后续激活须保持完整订阅契约及入口不变。每次以预期旧 head 为唯一父提交，在一个 tree／commit 内更新所有稳定文件和 `stable/activation.json`；非强制 PATCH 拒绝并发覆盖。激活记录保存候选证据、来源、契约、原生验证身份和稳定文件摘要。旧激活记录通过预期旧 commit 的 Git tree／blob 读取；只有完整 tree 证明缺失才视为首次激活，不能凭 raw CDN 的临时 404 绕过契约保护。API 故障、tree 截断及坏记录均拒绝激活。

PATCH 回复丢失时，先读取远端 head 对照已知 attempted commit，不重复写入。远端不可达报告 `ACTIVATION_UNKNOWN`；远端仍是旧 head 报告 `ACTIVATION_NOT_APPLIED`；其他 head 报告冲突或已被后续操作替代。成功提交后，使用完整 commit HTTPS 地址逐字节回读；尚不能完成则报告 `ACTIVATION_APPLIED_READBACK_PENDING` 及 commit，不能称旧规则未变。CLI 本地回执写入失败同样保留已生效 commit。重试须先核对远端 head 和激活记录，再选择正确预期值；不要盲目覆盖。

Git 提交保持文件与记录一起更新，但 GitHub 缓存和客户端轮询存在传播延迟，不保证多文件在客户端同时切换。激活不修改 Recipe、配置发布或客户端设置。运行中的 sing-box 通过原生机制获取稳定 SRS；受控测试的 `1s` 更新周期和临时 CA 只存在于测试进程，不能用于承诺全设备更新时间。

公开 API 为 `activateRules({ candidateEvidenceUrl, subscription, binary, expectedHead, transport? })`；默认使用 `githubActivation()`。API 的成功结果和远端记录可跨进程追溯，CLI 另外保存本地回执。Compiler 仍只消费契约，不导入激活运行时代码。

## 历史回滚

从目标环境的历史 `stable/activation.json` 所在完整 commit 选择已激活版本。历史记录及其候选必须仍然保留；本命令不查询 Release、不重新转换来源，也不重新发布配置。

```sh
pnpm --dir packages/rule-set-pipeline rollback \
  --state /absolute/path/to/state \
  --activation <historical-full-commit> \
  --subscription /absolute/path/to/trusted-subscription.json \
  --expected-head <current-full-commit> \
  --binary /absolute/path/to/sing-box
```

隔离环境显式添加 `--branch acceptance-<name>`，契约入口须属于该分支。公开 API 为 `rollbackRules({ historicalActivationCommit, subscription, binary, expectedHead, transport? })`。

回滚读取历史激活记录，核对当前完整订阅契约，重新执行正常激活的所有候选门禁，并比对历史稳定文件的实际字节及记录摘要。缺失、损坏、空内容或不兼容均在写入前拒绝。成功时只新增一次稳定入口提交，记录 `operation: rollback`、`historicalActivationCommit` 和 `historicalActivationId`；候选、Manifest、原验证记录及 `update-state.json` 均不改写。

回滚沿用激活的预期旧 head、并发保护、不确定结果核实和本地回执行为，返回 `status: activated`；操作类型在 `activation.operation` 中区分。客户端按原生更新机制恢复历史规则，允许传播延迟。历史版本选择不支持跨环境迁移或同时修改订阅契约。

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

每个非空用途分别生成 JSON／SRS，内容相同的用途复用同一组物理文件。纯域名文件同时供 Route 和 DNS 请求复用。纯 IP 的 Route／DNS 响应同样复用，混合 IR 分别输出三组文件。DNS 响应用途为 `{ status: "unavailable", reason: "empty" }`，不生成空匹配文件。`build.json` 是本地构建记录，不能作为 Compiler 的 Artifact Manifest 使用。[固定产物 Manifest v1](contracts/README.md) 继续保持原有契约，Compiler 不导入 Pipeline 运行时代码。

## 自动化验证

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

该验收固定 Release `20261102130044`，状态目录需尚未成功处理此样本，证据输出文件需不存在；此入口不是同一 Release 的显式重建命令。正常更新 CLI 不接受固定 tag；重建使用下面的独立命令。受控集成测试不访问真实 GitHub 写接口，自动覆盖上传、远程回读、来源变化和重试边界。

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

原生客户端不额外校验 Artifact Manifest 摘要；缓存写入失败不会回滚已生效的内存规则。首次启动无有效缓存、缓存损坏或无法写入缓存时，不具有跨重启旧规则保证。合法空 SRS 可能被客户端接受，必须依靠发布端激活门禁拒绝；本测试不以客户端拒绝空规则为前提。具体证据与未覆盖边界见 [#21 验收记录](docs/verification/issue-21.md)。

## 显式重建固定 Release

使用已有状态目录中成功处理过的固定 Release tag：

```sh
pnpm --dir packages/rule-set-pipeline rebuild \
  --state /absolute/path/to/rule-state \
  --release 20261102130044 \
  --binary /absolute/path/to/sing-box-1.14.4
```

`rebuildRules({ stateDirectory, release, binary, ... })` 与 CLI 使用同一入口。拒绝 `latest`、未固定或尚未成功处理的 Release；通过持久记录中的 Release ID 获取元数据，并重新核对 tag、源码 commit、资产身份及实际输入摘要。来源变化明确失败，不覆盖固定记录。

重建复用正常更新的转换、原生验证、不可变发布和 HTTPS 回读门禁。每次尝试保存新候选 ID、操作类型、原成功候选 ID 和构建身份。`build.json` 记录输入、转换器实现摘要、Node／yaml 版本、目标 binary 的 SHA-256、契约版本和实际产物摘要。实现摘要覆盖当前运行的来源读取、解析、转换、投影与原生验证代码；TypeScript 源码和编译后 JavaScript 分别记录各自实际运行实现的摘要。

成功和失败均保留原成功处理记录、固定来源及历史候选；失败可按原命令重试。相同输入与工具的规则字节及构建身份保持一致，候选 ID 和验证运行记录独立保存。重建不写稳定入口或激活回执，正常更新仍在无新 Release 时跳过。后续激活使用既有 `activate --candidate <new-readback-url>` 流程；激活验证同时支持历史构建身份和显式记录契约版本的新身份，拒绝不支持的契约版本。

真实重建验收固定官方样本，使用专属状态目录与 `acceptance-issue-22-<suffix>` 远程分支。它发布原候选和重建候选、注入原生失败并重试、回读历史文件，并通过固定样本元数据适配器检验正常更新的 latest 跳过路径（不将旧样本声称为真实 latest）：

```sh
RULE_REBUILD_STATE=/tmp/issue-22-fresh-state \
RULE_REBUILD_EVIDENCE=/tmp/issue-22-fresh-evidence.json \
RULE_REBUILD_BRANCH=acceptance-issue-22-<unique-suffix> \
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
pnpm --dir packages/rule-set-pipeline test:rebuild
```
