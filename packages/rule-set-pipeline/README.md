# Rule Set Pipeline

包名：`@sing-box-config-manager/rule-set-pipeline`。管理者通过正式配置维护规则集的来源和用途，再用 `sync` 完成新增、更新与删除。合格规则通过稳定 URL 交付给订阅使用者；构建成功、候选发布、稳定入口切换和客户端加载完成是不同的状态。

[Spec #84](https://github.com/wangyingang/sing-box-config-manager/issues/84) 将日常操作收敛为 `status`、`sync`、`pin`、`resume`。候选保留和完整 cleanup 由 [#85](https://github.com/wangyingang/sing-box-config-manager/issues/85) 交付，配置 push、定时运行及 GitHub 失败通知由 [#86](https://github.com/wangyingang/sing-box-config-manager/issues/86) 接线。本次代码交付不包含生产状态转换或启用。决定及迁移成本见 [配置驱动操作 ADR](docs/adr/0001-configuration-driven-rule-operations.md)。

## 操作分别产生什么结果

在仓库根目录执行。所有操作支持 `--json`；三种写操作支持 `--dry-run`。

| 命令 | 可观察的结果 |
| --- | --- |
| `pnpm rules status [id]` | 读取正式配置与远端事实，显示期望来源、当前交付、auto/pinned、候选、配置差异与异常；不写入或恢复任务 |
| `pnpm rules sync` | 处理全部配置差异，并为允许自动更新的规则检查最新来源、构建、验证、发布及交付；不提供单集或来源筛选 |
| `pnpm rules pin <id> <version>` | 交付该集一个仍保留且兼容的版本，并停止该集全部上游自动处理；可以固定当前版本，重复同一操作幂等 |
| `pnpm rules resume <id>` | 对齐该集当前正式来源，保存 auto，然后立即检查并更新；失败仍保持 auto，保留原交付 |

例如，正式配置一次新增 A、将 B 从 X 换到 Y、删除 C。`sync` 可以交付 A、删除 C，并在 Y 获取失败时报告部分失败。此时 B 已撤销旧 pin，显示期望 Y、控制 auto、实际仍交付 X 的旧版本。修复来源后再次 `sync` 继续处理，无需撤销 A/C 的成功。

```sh
pnpm rules status
pnpm rules status openai --json
pnpm rules sync --dry-run --json
pnpm rules sync
pnpm rules pin openai '2026-11-16T12:34:56.789Z~1234abcd' --dry-run
pnpm rules resume openai --dry-run --json
```

pin 示例的版本仅说明格式。实际操作先从 `status openai` 中选择 `selectable: true` 的 `versionId`；不要把 Git head、Release tag 或证据 URL 当作版本参数。`--dry-run` 检查真实输入和必要的原生验证，但不发布候选、不登记控制或进度、不消费正式版本身份。输出区分已验证条件、预计变化和尚未验证的远端提交/HTTPS 回读；正式执行重新核对前提。

无效 pin 不改变控制、当前交付或尚未同步的配置。新 pin 可以选择当前规则代次内保留的旧源版本；再次实质换源会撤销该固定。`resume` 不补跑固定期间的中间版本，已经为 auto 时也立即检查。

整体结果为 `success`、`partial`、`failed` 或 `pending`。CLI 仅在完全成功、无变化或正常固定跳过时返回 0；部分失败、失败和待核实均返回 1。`pending` 表示提交、回读结果或历史候选归属仍待核实，先查看 status，再根据返回的继续入口处理，不能当作没有发生变更。具体 JSON 字段见 [操作与状态契约](contracts/rules-operations.md)。

旧 `update`、`rebuild`、`check-now`、`activate`、`rollback`、`initialize` 等业务命令和旧 Node API 已退出公开入口。必要的构建、验证和转换仍是内部能力，不提供旧命令兼容层。

## 正式配置与草稿

写操作从源码仓库 `wangyingang/sing-box-config-manager` 的 `main` 当前 commit 读取 [`config/rulesets.yml`](config/rulesets.yml)，并在关键提交前重新核对。旧 checkout、旧事件和 rerun 不能授权重放旧定义。正常操作不需要手填配置路径、binary、状态目录或 Git head。

草稿文件只用于 sync 预览，不能授权正式写入：

```sh
pnpm rules sync --config /path/to/rulesets-draft.yml --dry-run --json
```

草稿可从 [`config/rulesets.yml`](config/rulesets.yml) 复制并编辑。隔离样例 [`samples/rulesets.example.yml`](samples/rulesets.example.yml) 的目标是 `acceptance-example`，须使用匹配的已准备隔离环境，不能据此写生产目标。

配置使用 `schemaVersion: 3`，必须显式声明正整数 `candidateRetentionDays`。正式配置和样例采用已确定的 30 天策略；#84 只校验该字段，按天清理属于 #85。`ruleSets` 必须显式存在。`ruleSets: []` 与空 `sources: {}` 可以表达删除全部受管规则；配置缺失、无法读取、未知字段、无效引用、重复 ID 或重叠稳定路径均在写入前拒绝。

当前正式配置有三个域名集 `openai`、`anthropic`、`google-deepmind`，以及双栈 `china-ip`。同类来源可以更换仓库、资产、路径或列表，无需修改代码：

| 获取方式 | 必填输入 | 支持的解析语义 |
| --- | --- | --- |
| `latest-release` | GitHub `repository`、`input.asset`、`input.checksum` | `plain-yaml` 或 `cidr-text` |
| `git-branch` | GitHub `repository`、`branch`、`input.path` | `plain-yaml` 或 `cidr-text` |

`plain-yaml` 专指现有规则列表语义，不接受任意 YAML；`cidr-text` 为逐行 IPv4/IPv6 CIDR，`list` 固定为 `all`。未知获取方式和格式拒绝，新增能力须经开发接入。来源内容的分类和覆盖范围由上游维护，本模块不做多源合并、质量评分或 IP 地理归属验证。

输入绑定由实际仓库、获取方式、branch、路径/资产、摘要声明、格式和所选列表决定。实质变化表示换源，接受新定义时撤销旧 pin。source 别名、注释、排列和保留期调整不会解除固定；上游新 Release/commit 是正常更新。稳定路径与用途变化另做订阅兼容检查，不能借换源更改已交付契约。

## 环境与远端状态

环境须已配置 GitHub 身份，拥有源码读取与产物仓库所需权限。产物仓库固定为 `wangyingang/sing-box-rule-artifacts`，目标分支须已存在且有初始提交。工具不创建仓库、凭据或分支。GitHub 写入使用现有 `gh` 身份；来源读取可使用 `GITHUB_TOKEN` 或 `GH_TOKEN`。

原生构建固定使用 sing-box **1.14.4**、Source Format **4**。可在环境中配置绝对路径 `SING_BOX_BINARY`，也可使用本机 sbvm 已安装的 1.14.4 或 PATH 中的 binary；实际版本与能力仍由原生验证检查。

| 目标 | 状态与候选 | 稳定入口 |
| --- | --- | --- |
| `main` | 产物仓库 `candidates` 分支 | 产物仓库 `main` 分支 |
| `acceptance-*` | 专用隔离分支 | 同一隔离分支 |

`RULE_TARGET` 选择已准备的隔离目标；省略时为 `main`。生产写入另受 `RULE_UPDATE_ENABLED=true` 门禁控制。这个设置是环境准备的一部分，不属于日常命令参数，也不表示本 PR 已获生产操作授权。#86 完成前不把新编排接入生产自动触发。

`sync` 可以为没有受管内容的目标建立缺失状态；发现未知 schema 或未管理的已有内容时拒绝覆盖。正式状态完全保存在远端，换机器不依赖本地缓存。schema 1 历史状态须先通过内部一次性转换，保留稳定 URL、字节、来源和有效固定。转换的待处理条件及边界见 [状态契约](contracts/rules-operations.md#一次性转换)。

每次写入绑定配置修订、输入绑定、控制 revision、规则代次和预期 Git head。并发变更或新配置会使旧操作失效。未知提交先核实原操作；共享写入结果不明时停止相关写入，不用另发一次操作掩盖未知结果。

从配置删除一集后，sync 撤销稳定文件、交付记录、候选和可用索引，并保留防迟到任务的最小记录。相同 ID 再新增使用新代次。删除成功不保证旧 Git 历史、CDN 或客户端缓存同步消失；完整历史清理由 #85 处理。

## Actions 隔离操作

[`rule-maintenance.yml`](../../.github/workflows/rule-maintenance.yml) 现在只提供手动 `workflow_dispatch`，调用与 CLI 相同的四个应用服务。选择 operation，并提供已经准备的 `acceptance-*` target；status 可选 id，pin 需要 id/version，resume 需要 id，写操作可选 dry_run。工作流和运行时都拒绝 main，当前没有 schedule 或配置 push 触发。

隔离目标写入使用仓库 Secret `RULE_ARTIFACT_TOKEN`，来源读取使用工作流自身 GitHub token。每次运行把共同结果写入 Step Summary；partial/failed/pending 使 job 失败，摘要作为 artifact 保留。配置仍读取源码 main 当前正式定义，不能通过工作流运行 ref 重放旧定义。生产自动运行与通知接线留给 #86。

## Node API

公开包入口与 CLI 共用同一应用服务：

```ts
import {
  getRulesStatus, syncRules, pinRuleVersion, resumeRuleUpdates,
} from '@sing-box-config-manager/rule-set-pipeline';

const status = await getRulesStatus({ id: 'openai' });
const preview = await syncRules({ dryRun: true });
```

`pinRuleVersion({ id, version, dryRun? })` 和 `resumeRuleUpdates({ id, dryRun? })` 使用同一结果模型。宿主可通过可信 `context` 注入当前正式配置读取器、受限仓库、目标与 binary；它是集成/隔离测试边界，不是接受不可信调用者任意目标的 API。`draft` 只供 `syncRules({ draft, dryRun: true })`。

## 稳定订阅与客户端

Rule Subscription v2 保持逻辑 ID、稳定 URL、用途、格式、目标版本与能力约束。域名的 Route/DNS Query 复用 `domains.json` 和 `domains.srs`，DNS Response 不可用；CIDR 的 Route/DNS Response 复用 `route.json` 和 `route.srs`，DNS Query 不可用。每次交付前都复验候选、来源、实际规则字节和订阅兼容性。

Recipe／Template v2 跟随稳定入口，管理者 pin 会影响所有引用该集的订阅使用者，但不更改 Recipe。配置快照固定不表示规则字节固定。Compiler 只消费可信宿主提供的内存契约，不下载规则、不调用 Pipeline。详见 [Rule Subscription v2](contracts/rule-subscription-v2.md) 和 [Artifact Manifest v1](contracts/README.md)。

## 客户端更新失败与缓存恢复

已经成功加载 A 的 sing-box，在后续下载或加载 B 失败时继续使用原内存规则。仓库的受控测试实际注入断开连接、HTTP 503、截断 SRS 和非法 SRS，通过新的 Route／DNS 请求证明 A 仍有效；解除故障后，再证明 B 生效。这四类注入不代表已经动态验证所有故障。

跨进程恢复是另一件事。只有有效规则已成功写入持久缓存，新进程才可能在离线时恢复它。受控测试在成功持久化 B 后，关闭客户端和规则服务，再用相同配置与缓存路径启动新进程，并通过新请求证明 B 恢复。首次启动无有效缓存、缓存损坏或无法写入缓存时，不具有跨重启旧规则保证。

原生客户端不额外校验 Artifact Manifest 摘要，合法但错误的内容不能依靠客户端摘要检查阻止。合法空 SRS 也可能被接受，必须依靠发布端激活门禁拒绝。缓存写入失败不会回滚已经生效的内存规则，因此“运行中已经更新”不表示“重启后一定恢复”。缓存写入失败的边界来自固定版本源码核对，现有验收未注入真实磁盘写入失败。

更新周期和缓存由实际客户端配置决定，本项目不统一强制设置。受控测试中的临时 CA、`1s` 周期及持久缓存仅是测试条件。具体执行方式及原生边界见 [#21 验收记录](docs/verification/issue-21.md)。

## 2026-11-09 SFM TestFlight 复测

在一台 macOS 设备上使用 SFM TestFlight 1.14.1000（build 430），从原 `tun` 的本地副本加载隔离分支的 `openai` 稳定 SRS。以下时间为 UTC+8。[隔离分支激活记录](https://github.com/wangyingang/sing-box-rule-artifacts/blob/73a161087b8796623324f2430ef1eaaedfc11b9e/stable/openai/activation.json)

- 19:51:35，SFM 在同一连接 ID 下记录了 `api.openai.com`、试用规则 `openai-sfm-pilot` 的命中、路由到「海外AI」以及实际出站 `dmit-vps-reality`（VLESS）。探测返回 `HTTP 401`。
- 上次的 Codex 响应流故障在本轮未复现。试用窗口内未记录到模型响应流断开或重试。Codex 的远程控制 WebSocket 在切入后和切回后各有一次断开记录。
- 切回后，SFM 于 19:52:07 重新连上，运行配置与原 iCloud `tun` 一致。19:53 重新探测 `api.openai.com`，仍返回 `HTTP 401`。

## 输入与转换边界

以下为内部构建与验证能力，不能绕过四个公开业务入口直接执行运维写入。

`domain/full/keyword/regexp` 分别映射为 `domain_suffix/domain/domain_keyword/domain_regex`。每种谓词单独放在一条 Headless Rule 中，规则集合保持 OR 语义。只对同类型、同值去重，按上述类型顺序和字符串代码单元顺序排序。规范化会复制为固定 `{type, value}` 结构，调用方的对象字段顺序不影响验证或构建身份。

非正则值的 `:@attr1,@attr2` 尾部被分离；属性记录仍转换，不在本地筛选。regexp 保留表达式；字面 `:@` 导致失败。保留大小写、Unicode、尾点和正则转义，不执行 IDNA 或表达式改写。空值、非法字符、域名空 label／非法边界／超长 label 均失败。正则不使用 JavaScript 引擎预判，目标 Go 引擎由原生加载步骤检查。1.14.4 在 regexp 匹配前将请求域名转为小写，但不改写表达式；大写字面表达式不会因此变成大小写无关。

IP 语义比较使用固定 `ipaddr.js 2.5.0` 解析地址，按 IPv4／IPv6 地址区间集合比较，接受目标引擎对相邻或包含 CIDR 的等价表示；地址集合扩大或缺失均失败。该规范化只用于比较，不聚合或改写生成 JSON 的 CIDR。JSON 的 `termCount` 按投影 IR 计数，SRS 按实际解码 term 计数，两者可能因原生归并而不同。

YAML 解析使用固定版本的 [yaml](https://eemeli.org/yaml/)，拒绝语法错误、重复 key、未知 tag、多个文档和 alias。记录级诊断包含文件、列表、从零开始的记录 index，以及从一开始的 line／column。列表级诊断以文件与目标列表定位。

每个非空用途分别生成 JSON／SRS，内容相同的用途复用同一组物理文件。纯域名文件同时供 Route 和 DNS 请求复用。纯 IP 的 Route／DNS 响应同样复用，混合 IR 分别输出三组文件。当前官方纯域名列表的 DNS 响应用途为 `{ status: "unavailable", reason: "empty" }`，不生成空匹配文件。`build.json` 是本地构建记录，不能作为 Compiler 的 Artifact Manifest 使用。[固定产物 Manifest v1](contracts/README.md) 继续保持原有契约，Compiler 不导入 Pipeline 运行时代码。

## 自动化验证

常规检查与完整本地验证使用[根 README 的统一入口](../../README.md#开发检查分别证明什么)。原生集成测试使用真实 sing-box；Git/上游 fixture 只替换外部边界，不意味着执行了真实 GitHub 写入。

```sh
pnpm --dir packages/rule-set-pipeline test
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 pnpm --dir packages/rule-set-pipeline test:integration
```

#84 的验收范围包含新增、换源、删除、pin、resume、部分失败、查询/预览与一次性转换；真实 GitHub 生命周期在专用 `acceptance-*` 分支验证，不写生产分支。场景与远端证据见 [#84 验收记录](../../docs/verification/issue-84.md)，最终源码和交付状态以 [Spec #84](https://github.com/wangyingang/sing-box-config-manager/issues/84) 的 PR 交付证据为准。

已有验收是各自日期与提交的历史事实：[#15 转换](docs/verification/issue-15.md)、[#16 原生验证](docs/verification/issue-16.md)、[#18 候选回读](docs/verification/issue-18.md)、[#19 v1 激活](docs/verification/issue-19.md)、[#20 v1 回滚](docs/verification/issue-20.md)、[#21 客户端故障恢复](docs/verification/issue-21.md)、[#22 重建](docs/verification/issue-22.md)、[#67 四集配置及更名](docs/verification/issue-67.md)。其中旧命令不再是当前操作指南，历史通过不表示 #84 新入口已在生产运行。
