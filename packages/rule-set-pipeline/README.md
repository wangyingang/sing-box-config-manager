# Rule Set Pipeline

包名：`@sing-box-config-manager/rule-set-pipeline`。管理者通过正式配置维护规则集的来源、筛选条件与发布路径，再用 `sync` 完成新增、更新与删除。合格规则通过稳定 URL 交付给订阅使用者；构建成功、候选发布、稳定入口切换和客户端加载完成是不同的状态。

[Spec #84](https://github.com/wangyingang/sing-box-config-manager/issues/84) 将日常操作收敛为 `status`、`sync`、`pin`、`resume`。[Spec #85](https://github.com/wangyingang/sing-box-config-manager/issues/85) 增加一个 `cleanup` 入口，按保留期重建受管历史并保留可选版本。[Spec #86](https://github.com/wangyingang/sing-box-config-manager/issues/86) 将配置 push、定时运行和手工 Actions 接到同一应用服务，并使用 GitHub 原生失败通知。首次切换见下文的[空产物状态](#从空产物状态启用新验证策略)。操作决定见 [配置驱动操作 ADR](docs/adr/0001-configuration-driven-rule-operations.md)。

## 操作分别产生什么结果

在仓库根目录执行。所有操作支持 `--json`；四种写操作支持 `--dry-run`。

CLI 在 stderr 显示当前阶段、规则集和累计耗时；同一阶段超过 15 秒仍持续提示。stdout 保留最终文本或单个 JSON 结果，例如 `pnpm rules sync --json > result.json` 可保存结果并在终端查看进度。进度仅说明当前正在处理什么，成功与否以最终结果及退出码为准。

| 命令 | 可观察的结果 |
| --- | --- |
| `pnpm rules status [id]` | 读取正式配置与远端事实，显示期望来源、当前交付、auto/pinned、候选、配置差异与异常；不写入或恢复任务 |
| `pnpm rules sync` | 处理全部配置差异，并为允许自动更新的规则检查最新来源、构建、验证、发布及交付；不提供单集或来源筛选 |
| `pnpm rules pin <id> <version>` | 交付该集一个仍保留且兼容的版本，并停止该集全部上游自动处理；可以固定当前版本，重复同一操作幂等 |
| `pnpm rules resume <id>` | 对齐该集当前正式来源，保存 auto，然后立即检查并更新；失败仍保持 auto，保留原交付 |
| `pnpm rules cleanup` | 按正式保留期清理非当前候选并重建受管 Git 历史；保护当前交付和 pin，不检查新上游；中断后重跑同一命令继续 |

例如，正式配置一次新增 A、将 B 从 X 换到 Y、删除 C。`sync` 可以交付 A、删除 C，并在 Y 获取失败时报告部分失败。此时 B 已撤销旧 pin，显示期望 Y、控制 auto、实际仍交付 X 的旧版本。修复来源后再次 `sync` 继续处理，无需撤销 A/C 的成功。

```sh
pnpm rules status
pnpm rules status openai --json
pnpm rules sync --dry-run --json
pnpm rules sync
pnpm rules pin openai '2026-11-16T12:34:56.789Z~1234abcd' --dry-run
pnpm rules resume openai --dry-run --json
pnpm rules cleanup --dry-run --json
```

pin 示例的版本仅说明格式。实际操作先从 `status openai` 中选择 `selectable: true` 的 `versionId`；不要把 Git head、Release tag 或证据 URL 当作版本参数。人工 `status` 从 Git 审计所查询规则集的全部相关保留候选。核心事实或规则字节损坏时报告不可选原因，缺失的纯追溯文件通过 `missingTraceFiles` 提示。该审计的产物 Raw 请求、原生执行和写入均为零。

sync/pin/resume 的 `--dry-run` 检查真实输入和必要的原生验证；cleanup 的预览只盘点保留集合，不执行原生复验或引用切换。所有预览均不发布候选、不登记控制或进度、不消费正式版本身份，输出区分已验证条件、预计变化和尚未验证的内容；正式执行重新核对前提。

无效 pin 不改变控制、当前交付或尚未同步的配置。新 pin 可以选择当前规则代次内保留的旧源版本；再次实质换源会撤销该固定。`resume` 不补跑固定期间的中间版本，已经为 auto 时也立即检查。

整体结果为 `success`、`disabled`、`partial`、`failed` 或 `pending`。完全成功、无变化、正常固定跳过及环境门禁关闭时返回 0；`disabled` 明确表示未应用，不能当作配置已经生效。部分失败、失败和待核实均返回 1。`pending` 表示提交、回读结果、历史候选归属仍待核实，或维护隔离尚未结束。先查看 status，再根据返回的继续入口处理，不能当作没有发生变更。具体 JSON 字段见 [操作与状态契约](contracts/rules-operations.md)。

真实 `sync` 先处理当前定义、规则代次和控制修订下的全部 building/publishing 候选，再判断普通更新或 `unchanged`。恢复沿用原候选身份、固定来源和构建身份；完整发布证据可直接复验，缺失阶段从原固定输入继续。同源多个规则、同一规则多个在途记录都逐项核实，不由分组首项或遍历顺序决定交付。`unchanged` 只说明当前内容无需切换，不表示可以跳过旧候选收尾。无法获取固定输入、构建身份变化或证据冲突时保留候选，返回具体候选诊断及 `sync` 继续入口；cleanup 不替代构建恢复。

正常 `sync` 和 `resume` 对 Git 来源先探测文件身份，可信的固定 commit 或文件 blob 可以省略正文下载。固定 HTTPS 来源每次下载正文和已配置的摘要。共享来源只需获取一次，各集独立验证和登记成功。[上游文件身份与回退规则](contracts/rules-operations.md#上游文件身份与回退)

内容等价且旧交付完整时，沿用原候选、版本、来源、首次发布时间和稳定文件。比如 DLC 正文只修改了其他列表，`current.source` 仍记录构建当前产物时的输入摘要，`successfulInput.source` 更新为本次已验证的摘要。配置、输入和交付均未变时，可复用原生证明，无需重新编译、原生加载或提交 Git。

首次交付、失败重试、规则内容或处理条件变化、当前交付与成功记录不匹配时走常规构建和验证。共享稳定文件缺失或摘要不符时停止写入。待恢复交付和候选优先核实，涉及恢复的规则集退出本轮正文短路。固定期间跳过该集的全部上游处理。清理保留仍关联到保留候选的成功记录，并清除被回收候选的关联。

已有当前交付时，恢复后的候选先作为完整历史版本保留，再由正常最新上游检查决定一次交付。即使只有一个在途候选、且它的完整证据已经复验，也不能仅凭该事实切换当前版本；latest 不可用时整次 sync 失败并保留当前交付，稍后重跑 sync 继续。例如 A 当前交付、B 构建中断后上游又回到 A，恢复只补齐 B 的证据，当前 A 保持不变。这是避免旧候选回切的代价；完整证据恢复本身不要求重新获取 B 的固定上游输入。尚无当前交付且只有一个有效在途候选时，仍可直接复验并交付；已登记 pendingDelivery 的原操作恢复也不改为重新选择 latest。

候选已有的业务版本和首次发布时间保持不变。有效不可变证据已登记这些事实、但 journal 检查点缺失时，先核对原候选、来源、构建和产物，再补回登记；没有可靠历史时间时明确失败，不使用恢复时间补造。status 和四个写入口的 dry-run 只展示实际状态，不推进上述恢复。

首次交付将候选检查点与各阶段文件合并保存。原有五集的首次交付验收记录了 20 次产物 Raw GET，分别核对候选和稳定交付 commit 上各 10 个规则文件。候选合格但交付准备失败、恢复后未被选中或其他故障可增加检查点。相同 Git SHA 的内容可在内存复用，但正式配置修订、分支 head 和写入门禁仍重新核对；分支指向继续实时核对。同一次操作可复用已校验的固定 HTTPS 字节，摘要与当前保留树仍按阶段核对。已完成候选的复选和人工 status 通过 Git 核对核心业务事实与规则字节。阶段与恢复边界见[持久事实契约](contracts/rules-operations.md#远端事实与版本身份)，内存容量和固定地址的可用性观察见[证据回读](contracts/rules-operations.md#证据回读)。

旧 `update`、`rebuild`、`check-now`、`activate`、`rollback`、`initialize` 及 `maintenance-enter/prepare/switch/resume/abort` 等旧命令和 Node API 已退出公开入口。必要的构建、验证和转换仍是内部能力，不提供旧命令兼容层。

## 正式配置与草稿

写操作从源码仓库 `wangyingang/sing-box-config-manager` 的 `main` 当前 commit 读取 [`config/rulesets.yml`](config/rulesets.yml)，并在关键提交前重新核对。旧 checkout、旧事件和 rerun 不能授权重放旧定义。正常操作不需要手填配置路径、binary、状态目录或 Git head。

草稿文件只用于 sync 预览，不能授权正式写入：

```sh
pnpm rules sync --config /path/to/rulesets-draft.yml --dry-run --json
```

草稿可从 [`config/rulesets.yml`](config/rulesets.yml) 复制并编辑。隔离样例 [`samples/rulesets.example.yml`](samples/rulesets.example.yml) 的目标是 `acceptance-example`，须使用匹配的已准备隔离环境，不能据此写生产目标。

正式配置和样例使用 `schemaVersion: 4` 并关联[通用 Schema](config/rulesets.schema.json)。`candidateRetentionDays` 必须为正整数，正式值为 30 天。`ruleSets` 按规则集 ID 声明，显式的 `ruleSets: {}` 表示删除全部受管规则。旧配置、未知字段、重复键、无效来源引用及重叠的最终文件路径会在上游获取和写入前被拒绝。错误包含 YAML 行列号和字段路径。

每集从一个来源选择整份文件或命名列表，可按格式筛选。构建将结果写到 `publishPath/artifact.json` 和 `publishPath/artifact.srs`，基名最多 250 个字符，可使用小写 ASCII 字母、数字、连字符和下划线。更新已有交付时，Pipeline 核对这两个稳定地址与当前交付记录一致。

正式配置保留 16 个独立的 `stable/<id>` 目录。`china-ip` 与 `chatgpt-voice` 的基名为 `ips`，其余 14 集为 `domains`。`china-domains` 选择 V2Fly 的 `geolocation-cn`，`global` 选择 `geolocation-!cn`，其余 V2Fly 集选择同名列表。客户端配置决定规则的用途和匹配顺序。

- `gfw` 从 GitHub 分支读取逐行域名后缀。[Loyalsoldier 的 `release:gfw.txt`](https://github.com/Loyalsoldier/v2ray-rules-dat/blob/release/gfw.txt)
- `onedrive` 从 Clash 清单选择 `DOMAIN-SUFFIX` 和 `DOMAIN-KEYWORD`。[blackmatrix7 的 `master:rule/Clash/OneDrive/OneDrive.list`](https://github.com/blackmatrix7/ios_rule_script/blob/master/rule/Clash/OneDrive/OneDrive.list)
- `stream` 从 GitHub 分支读取 sing-box Source Format v2，保留精确域名、后缀和关键词的原生匹配结构。[Sukka 的 `master:sing-box/non_ip/stream.json`](https://github.com/SukkaLab/ruleset.skk.moe/blob/master/sing-box/non_ip/stream.json)
- `china-ip` 从 GitHub 分支读取逐行 IPv4/IPv6 CIDR。[gaoyifan 的 `ip-lists:china46.txt`](https://github.com/gaoyifan/china-operator-ip/blob/ip-lists/china46.txt)
- `chatgpt-voice` 从固定 URL 读取 IPv4/IPv6 CIDR。客户端策略可另按 OpenAI 网络说明约束 UDP 3478 或 TCP 443。[OpenAI 官方输入](https://openai.com/chatgpt-voice.json) · [OpenAI 网络说明](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps#chatgpt-voice-firewall-settings)

输入绑定取决于获取方式、来源地址、文件路径、格式、命名列表和过滤条件。实质换源会在接受新定义时撤销旧 pin。别名、注释、排列和保留期调整保持控制状态，Git 分支或固定 URL 内容变化按常规同步处理。稳定路径另做交付兼容检查。

### 在隔离目标同步混合规则集

将下面的编辑器指令与 [v4 Schema](config/rulesets.schema.json) 一起使用。示例适用于配置与 Schema 同目录的情况。支持 YAML Language Server 的编辑器会补全固定字段和枚举，并提示结构错误。`sync` 使用同一份 Schema，同步前继续检查 source 引用、实际输入格式和最终文件路径。诊断包含 YAML 行列号和字段路径。

`sync` 支持最小 v4 配置。使用 `fetch.method: url` 从固定 HTTPS 地址读取整份 `sing-box-source-json`，在 `publishPath` 下发布以 `artifact` 命名的 JSON 和 SRS。将下例中的 URL 换成实际端点，并按下节配置同名的隔离目标。

```yaml
# yaml-language-server: $schema=./rulesets.schema.json
schemaVersion: 4
candidateRetentionDays: 30
target:
  repository: wangyingang/sing-box-rule-artifacts
  branch: acceptance-mixed
sources:
  example:
    fetch:
      method: url
      url: https://rules.example.test/mixed.json
    format: sing-box-source-json
ruleSets:
  example-mixed:
    data:
      source: example
    publishPath: stable/example-mixed
    artifact: mixed
```

规则集可以共用 `publishPath`，各集使用不同的 `artifact`。例如将 `domains` 和 `ips` 发布到 `stable/shared`，订阅地址分别以 `domains.json`、`domains.srs`、`ips.json` 和 `ips.srs` 结尾。移除一集只撤销该集的文件和交付记录。

reader 接受 UTF-8 JSON 格式的 sing-box Source Format v2 和 v4。顶层须包含整数 `version` 和 `rules` 数组，所有对象的键必须唯一。交付统一生成 Source Format v4。规则可使用 v4 的原生匹配字段，包括域名、源与目标 IP、端口、DNS query type、网络、进程、包名和接口条件。默认规则保留原有字段分组和顶层条目边界。逻辑规则保留嵌套的 `and`、`or` 和 `invert`。例如，以下规则要求后缀和关键词同时匹配。

```json
{
  "version": 4,
  "rules": [
    {
      "type": "logical",
      "mode": "and",
      "rules": [
        { "domain_suffix": "example.test" },
        { "domain_keyword": "api" }
      ]
    },
    { "ip_cidr": ["192.0.2.0/24", "2001:db8::/32"] }
  ]
}
```

遇到不支持的字段、无效的条件结构，或原生解析器能定位到的无效值时，reader 跳过该顶层规则。原本有多条规则时，跳过后剩下的单条默认规则维持原有匹配范围，避免新触发 sing-box 对外层条件的分组合并。转换报告给出源文件、从 0 开始的规则下标、出错子条件路径及按字段汇总的数量。同步重新读取上游并发现跳过项时，`sync --json` 返回本次转换报告，即使当前交付版本可复用。候选的转换报告随其构建证据保留。空 `rules` 数组可发布为空规则集。非空输入若全部跳过，或通过结构检查的内容未能通过原生编译及任一格式的加载，构建失败并保留已有交付。[`sing-box` 1.14.4 的 SRS 字段定义](https://github.com/SagerNet/sing-box/blob/v1.14.4/common/srs/binary.go)

固定 URL 输入上限为 8 MiB。候选保留原始输入字节，重试按记录的摘要和长度核对快照。GitHub 分支输入通过固定 commit 重读。

新候选的 [Artifact Manifest v3](contracts/artifact-manifest-v3.schema.json) 直接列出两种格式的固定 URL、字节数和 SHA-256。交付记录的 `subscription.formats` 列出两种格式的稳定 URL，`files` 记录实际发布文件的摘要和长度。正式配置与空目标验收见 [#174](https://github.com/wangyingang/sing-box-config-manager/issues/174)。

### 从固定 HTTPS URL 读取 DLC 和 ChatGPT Voice

在 v4 的 `sources` 中给每个固定 URL 声明 `fetch.method: url` 和 `format`。GitHub Release 附件可以使用 `releases/latest/download/...` 地址，获取过程允许有限次数的 HTTPS 跳转。配置了 `fetch.sha256Url` 时，摘要必须是单个 SHA-256 十六进制值或一行 `sha256sum` 记录。摘要不可获取、格式错误或与正文不符时，依赖该来源的规则集保留旧交付，其他来源继续同步。

```yaml
sources:
  dlc:
    fetch:
      method: url
      url: https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat_plain.yml
      sha256Url: https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat_plain.yml.sha256sum
    format: v2fly-dlc-yaml
  voice:
    fetch:
      method: url
      url: https://openai.com/chatgpt-voice.json
    format: openai-voice-json
ruleSets:
  openai:
    data: { source: dlc, list: openai }
    filter:
      exclude:
        tags:
          anyOf: [cn]
    publishPath: stable/openai
    artifact: domains
  voice:
    data: { source: voice }
    publishPath: stable/voice
    artifact: ips
```

`v2fly-dlc-yaml` 必须用 `data.list` 选择真实列表。`all` 也按名称查找。各规则集可独立设置 `filter.include` 或 `filter.exclude`。同一条目上 `tags.allOf` 要求所有指定标签，`tags.anyOf` 要求任一指定标签。标签精确匹配，配置中省略 `@`，`'!cn'` 是完整标签名。两种发布格式均移除属性标签。存在空列表或过滤结果为空时发布空规则集。指定列表缺失时只阻止该规则集更新。ChatGPT Voice 按整份文件读取 IPv4 和 IPv6 CIDR，省略 `data.list`。

DLC 的 [YAML 导出程序](https://github.com/v2fly/domain-list-community/blob/master/cmd/datdump/main.go) 直接在正则值后拼接属性。无法从文本区分的尾部沿用现有解析约定。符合标签语法且未转义的小写尾部按属性处理。

### 在同一 GitHub 分支选择不同文件

在 v4 配置中，`fetch.method: github-branch` 声明上游仓库及分支。每个规则集用 `data.file` 指定一个仓库内文件，用 `data.format` 选择 `clash-rule-list`、`cidr-text` 或 `domain-suffix-text`。这些格式均读取整份文件，省略 `list`。一次同步为同一仓库和分支固定一个 commit，各规则集按该 commit 读取各自的文件。

例如，下列配置片段从同一分支选择一份 Clash 清单和一份 CIDR 文本。仓库和文件路径为示例值。

```yaml
sources:
  example:
    fetch:
      method: github-branch
      repository: example/rule-lists
      branch: main
ruleSets:
  example-domains:
    data:
      source: example
      file: rules/services.list
      format: clash-rule-list
    filter:
      include:
        type:
          anyOf: [DOMAIN-SUFFIX, DOMAIN-KEYWORD]
    publishPath: stable/example-domains
    artifact: domains
  example-networks:
    data:
      source: example
      file: rules/networks.txt
      format: cidr-text
    publishPath: stable/example-networks
    artifact: ips
```

`clash-rule-list` 读取 UTF-8 Classical 文本清单，转换 `DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、`IP-CIDR`、`IP-CIDR6`、`SRC-IP-CIDR`、`SRC-PORT` 和 `DST-PORT`。地址规则按原类型匹配传入的源或目标 IP，客户端配置负责域名解析。可省略 `filter`，也可使用 `include.type.anyOf` 或 `exclude.type.anyOf` 选择上游类型。类型名称区分大小写，`IP-CIDR` 和 `IP-CIDR6` 分别筛选。其他类型和无法表达的修饰项按上游类型计入 `unsupportedTypeCounts`。 [Mihomo Classical 文本示例](https://wiki.metacubex.one/en/config/rule-providers/content/) · [Mihomo 匹配类型与修饰项](https://wiki.metacubex.one/en/config/rules/)

三种格式均可发布空文件对应的空规则集。Clash 过滤结果为空时同样发布空规则集。选中项全部因不受支持被跳过时，本次构建失败。已有的两种订阅仍提供上一版，首次构建则等待后续成功，一次同步中的独立文件可继续交付。

## 环境与远端状态

环境须已配置 GitHub 身份，拥有源码读取与产物仓库所需权限。产物仓库固定为 `wangyingang/sing-box-rule-artifacts`，目标分支须已存在且有初始提交。工具不创建仓库、凭据或目标分支；`cleanup` 仅创建、核验并清理本次维护拥有的临时分支。GitHub 写入使用现有 `gh` 身份；来源读取可使用 `GITHUB_TOKEN` 或 `GH_TOKEN`。

原生构建固定使用 sing-box **1.14.4**、Source Format **4**。可在环境中配置绝对路径 `SING_BOX_BINARY`，也可使用本机 sbvm 已安装的 1.14.4 或 PATH 中的 binary；实际版本与能力仍由原生验证检查。

| 目标 | 状态与候选 | 稳定入口 |
| --- | --- | --- |
| `main` | 产物仓库 `candidates` 分支 | 产物仓库 `main` 分支 |
| `acceptance-*` | 专用隔离分支 | 同一隔离分支 |

`RULE_TARGET` 选择已准备的目标，省略时为 `main`。生产更新类写入（sync/pin/resume）只在 `RULE_UPDATE_ENABLED=true` 时允许；历史清理只在 `RULE_CLEANUP_ENABLED=true` 时允许，两个开关默认关闭。CLI、默认 Node 宿主和 Actions 共用这两个门禁，不能改用另一入口绕过。关闭时返回 `disabled`、本次配置修订和未应用原因；它不改变单集 auto/pinned 控制。status 与 dry-run 保持只读，可在写入开关关闭时使用。

隔离目标仅限 `acceptance-*`，不会写产物 main/candidates。默认 CLI/API 仍读取源码 main 当前配置；可信隔离宿主可通过 `RULE_CONFIG_BRANCH` 选择与目标同名的 acceptance 分支，不能用隔离配置授权生产写入。Actions 的隔离运行固定使用同名配置分支。源码配置分支和产物目标须事先准备，配置修订每次从当前 head 解析。环境变量和凭据属于宿主部署配置，不是日常命令参数；启用生产开关、转换生产旧状态及实际运行都需要对应授权。

`sync` 可以为没有受管内容的目标建立缺失状态；发现未知 schema 或未管理的已有内容时拒绝覆盖。正式状态完全保存在远端，换机器不依赖本地缓存。v4 从空状态开始，早期状态转换见[历史记录](contracts/rules-operations.md#一次性转换)。

每次写入绑定配置修订、输入绑定、控制 revision、规则代次和预期 Git head。并发变更或新配置会使旧操作失效。未知提交先核实原操作；共享写入结果不明时停止相关写入，不用另发一次操作掩盖未知结果。

从配置删除一集后，sync 撤销稳定文件、交付记录、候选和可用索引，并保留防迟到任务的最小记录。有受管内容被移除时，结案提交同时记录待回收历史。相同 ID 再新增使用新代次。已删除的内容仍可能留在旧 Git 历史、CDN 或客户端缓存中。

## 候选保留与历史清理

`cleanup` 以候选首次成功发布的 `publishedAt` 判断年龄。一天为 UTC 连续 24 小时；截止时间为本次 `cleanupObservedAt` 减正式配置的 `candidateRetentionDays`。发布时间等于或晚于 cutoff 的完整候选保留，早于 cutoff 且无保护依赖的候选可删除。

每日仍评估保留期。只有过期且不受保护的候选、已确认失效的残留或已登记的删除历史会触发重建。控制、来源观测和成功输入记录的变动本身仅增加操作历史。没有回收对象、阻塞项或待续维护时，`cleanup` 返回 `unchanged`，原生复验、产物 Raw HTTP、基线写入和引用切换均为零。

当前交付和 pin 目标不受年龄限制。换源失败时仍在交付的旧源版本也属于当前版本。例如 A 已发布 60 天但仍被固定，30 天保留期不会删除它；B 替代 A 后，A 仍按原始发布时间判断，下次清理即可移除，不从替换当天重新计时。

```sh
pnpm rules cleanup --dry-run --json
pnpm rules cleanup --json
# 中断后使用同一入口；不需要选择内部阶段
pnpm rules cleanup --json
pnpm rules status openai
```

预览列出观察时间、截止时间、保留/删除候选及原因、保留候选核心文件与当前稳定文件的逻辑字节数、阻塞项和其他引用，不进入维护或执行恢复。实际执行先隔离写入，再固化本次计划，复制保留候选的核心文件和已有追溯文件，回读新候选固定地址的 JSON/SRS 并切换受管基线，最后回读稳定分支的 JSON/SRS 入口、清理自己的临时引用并恢复写入。恢复沿用原计划；跨日重跑或调整保留期不能扩大该次删除范围。切换后中断会继续核验和收尾，不回滚到旧基线。

清理保留 `versionId`、`publishedAt`、原始来源以及稳定字节/URL，可重写内部 Git commit 和证据地址。完成后 `status` 仍列出保留候选，兼容版本仍可 `pin`。cleanup 不获取最新上游、不生成新候选、不解除固定；sync 不暗中清理。未完整发布、历史时间不明或仍需核实的操作不能按年龄删除，结果列出阻塞原因，无法证明安全时保持 pending。

受管历史回收同时覆盖 candidates 与 main；单分支隔离目标使用同一流程。工具只删除本次维护拥有且 head 匹配的临时/旧引用，其他分支和标签保留并报告；它们可能继续引用旧历史。不承诺固定仓库体积、GitHub 立即回收对象或旧 SHA 立即不可访问。稳定入口核验完成且本轮临时引用处理完毕后，恢复写入的状态提交清除待回收标记。

## Actions 自动与手工运行

[`rule-maintenance.yml`](../../.github/workflows/rule-maintenance.yml) 使用三种触发方式，业务写入均调用相同应用服务：

| 触发 | 配置与执行行为 |
| --- | --- |
| main 的正式配置 `config/rulesets.yml` push | 读取 main 当前配置，执行一次完整 sync，统一识别新增、换源和删除 |
| `acceptance-*` 的同一路径 push | 读取该分支当前配置，只向产物仓库同名隔离目标执行 sync |
| 每日 `23 20 * * *`（UTC 每日 20:23，北京时间每日 04:23） | 先做轻量预检，再按观察结果调用 sync 和 cleanup；已有未完成维护时先续做 cleanup，恢复可写后再 sync 和必要清理 |
| 手工 `workflow_dispatch` | 选择五个 operation 之一、target 和该操作需要的参数；target 默认 main，也可选择已准备的 acceptance 分支 |

例如在同一次正式配置提交中新增 A、将 B 换源、删除 C，push 会完成一次完整 sync，无需另发逐集命令。若 B 的来源失败，A/C 的成功保留，摘要列出 B 仍实际交付的版本，运行整体失败。修复后再次 push，或下一次每日 sync，会按当前配置继续处理。pinned 集跳过上游处理；手工 resume 后恢复 auto 并立即检查当前来源。生产更新开关关闭时，此次 push 显示未应用，而不会假装已经完成配置变更。

每日预检读取当前正式配置、维护和交付登记，以及当前稳定交付的 Git 记录和规则字节。Summary 和 JSON artifact 中的 `schedule-preflight` 记录观察范围、当前交付和下一步恢复入口；历史候选的资格由人工 `status` 审计，后续实际操作按需核验候选。两个生产门禁均关闭时，只报告 sync 与 cleanup 未应用。

日常编排分别保留 sync 和 cleanup 的结果；清理成功不能覆盖更新失败。单集普通来源失败不必阻止可安全执行的清理，共享状态或写入结果尚不明确时停止受影响写入。两类生产开关分别控制各自阶段；未完成维护无法恢复时不能继续更新。每日频率不改变候选保留年龄；不再使用 `RULE_CLEANUP_PERIOD_DAYS` 或 `RULE_CLEANUP_START_AT`。GitHub 的 [schedule 事件可能延迟或丢弃](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)，本模块不承诺准时触发。

稳定文件已提交而 HTTPS 回读暂时失败时，下次 schedule 可将仅关联已登记交付的 pending 交给同一个受保护的 sync 恢复；不重复提交已经核实的稳定交付。损坏、不可读、目标不符、归属未明或混合共享冲突仍阻止后续写入。恢复未完成，或更新门禁关闭而返回 disabled 时，不继续 cleanup，也不把 disabled 当作 pending 已解决。活动维护仍优先由 cleanup 沿用已固化计划恢复。

五个入口的参数保持一致：

| CLI | Node API | workflow_dispatch |
| --- | --- | --- |
| `status [id]` | `getRulesStatus({ id? })` | operation=status，可选 id；不接受 version/dry_run |
| `sync [--dry-run]` | `syncRules({ dryRun? })` | operation=sync，可选 dry_run；不接受 id/version |
| `pin <id> <version> [--dry-run]` | `pinRuleVersion({ id, version, dryRun? })` | operation=pin，必填 id/version，可选 dry_run |
| `resume <id> [--dry-run]` | `resumeRuleUpdates({ id, dryRun? })` | operation=resume，必填 id，可选 dry_run；不接受 version |
| `cleanup [--dry-run]` | `cleanupRuleHistory({ dryRun? })` | operation=cleanup，可选 dry_run；不接受 id/version |

手工运行的 target 为 main 时，工作流运行分支也必须是 main；从开发分支运行只能选择隔离目标。手工工作流不接受内部维护阶段、证据 URL、expected-head、binary 或状态目录。Actions 对 main 使用仓库 Secret `RULE_ARTIFACT_TOKEN`；对 acceptance-* 只使用独立 Secret `RULE_ACCEPTANCE_TOKEN`，缺少时失败，不回落到生产凭据。源码配置与上游来源读取使用工作流自身 `GITHUB_TOKEN`；Actions variables `RULE_UPDATE_ENABLED` 和 `RULE_CLEANUP_ENABLED` 继续分别控制生产写入。工作流按目标串行排队，业务服务仍检查配置修订、head 与 generation；排队不能代替这些检查。

隔离验收的最小凭据设置：在源码仓库 `wangyingang/sing-box-config-manager` 的 **Settings → Secrets and variables → Actions → Repository secrets** 中保存 `RULE_ACCEPTANCE_TOKEN`。使用独立的 Fine-grained PAT，仅选择产物仓库 `wangyingang/sing-box-rule-artifacts`，仓库权限设为 **Contents: Read and write**，有效期只覆盖测试所需时间。创建步骤见 [GitHub Fine-grained PAT 文档](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)。该 token 授权范围是仓库，不是 acceptance 分支；分支隔离由工作流和应用服务的目标校验约束。不要复制本机 `gh` 登录 token，也不要替换或修改生产 `RULE_ARTIFACT_TOKEN`。

旧事件或 rerun 重新读取对应配置分支的当前 head，并记录实际配置修订，不能重放已删除的旧定义。运行摘要与可下载 JSON 结果保留操作、目标、配置修订、各集实际交付与控制状态、失败原因及继续入口。未解决的 pending、共享状态异常及实际执行的 sync 或 cleanup 失败均使工作流失败。已观察到的维护或待恢复交付在后续操作处理成功后，整次运行可以成功。disabled 表示对应阶段未应用，仍待恢复的交付继续报告为失败。

## GitHub 原生失败通知

维护者在自己的 GitHub 账号中设置通知：

1. 打开 [Notification settings](https://github.com/settings/notifications)，找到 **System → Actions**。
2. 选择 **Email**，同时选择 **Only notify for failed workflows**，保存设置；使用账号已验证的通知邮箱。
3. 从通知或仓库 Actions 打开失败运行，阅读 Summary，下载结果 artifact，按实际当前版本和继续入口处理。

具体选项见 [GitHub Actions 通知设置](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)。GitHub 管理邮件内容和收件行为；定时任务通知对象与最初创建工作流、修改 cron 或重新启用工作流的人有关，不能据此承诺固定收件人。详见 [工作流通知规则](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)。

本项目不配置收件人列表、SMTP、邮件 API 或发送队列，也不承诺每次失败必定送达。手工实际运行及 dry-run 失败也可能按账号设置触发原生通知；dry-run 本身不执行任何邮件发送。代码交付和 Actions 显示失败不等于邮箱已实收；生产启用、账号通知配置核验、原生 schedule 触发与邮箱实收应按部署时的实际证据记录。选择原因见 [自动运行与通知 ADR](docs/adr/0003-automated-operations-and-native-notifications.md)。

## Node API

公开包入口与 CLI 共用同一应用服务：

```ts
import {
  getRulesStatus, syncRules, pinRuleVersion, resumeRuleUpdates, cleanupRuleHistory,
} from '@sing-box-config-manager/rule-set-pipeline';

const status = await getRulesStatus({ id: 'openai' });
const preview = await syncRules({ dryRun: true });
const cleanupPreview = await cleanupRuleHistory({ dryRun: true });
```

`pinRuleVersion({ id, version, dryRun? })`、`resumeRuleUpdates({ id, dryRun? })` 和 `cleanupRuleHistory({ dryRun? })` 使用同一结果模型。宿主可通过可信 `context` 注入当前正式配置读取器、受限仓库、目标与 binary；它是集成/隔离测试边界，不是接受不可信调用者任意目标的 API。`draft` 只供 `syncRules({ draft, dryRun: true })`。

## 稳定订阅与客户端

Pipeline 的交付记录通过 `subscription.formats` 提供当前版本的两个稳定地址，记录路径为 `<publishPath>/_delivery/<artifact>.json`。每次交付前核对候选、稳定地址和实际规则字节。

客户端按配置中的稳定地址获取 JSON 或 SRS。v4 切换后，14 个域名集沿用原地址。`china-ip` 和 `chatgpt-voice` 的旧 `route.json`、`route.srs` 已退役，引用这两个集时使用各自目录下的 `ips.json`、`ips.srs`。[两个 IP 集的订阅文件改名](#两个-ip-集的订阅文件改名)

Recipe／Template v2 通过宿主提供的 Rule Subscription v2 选择规则集及用途。配置快照保存选中的订阅声明，客户端按自身更新机制获取稳定地址上的版本，包括管理者通过 `pin` 选定的版本。[Compiler 订阅输入](../config-compiler/contracts/rule-subscription-v2.md)

## 客户端更新失败与缓存恢复

已经成功加载 A 的 sing-box，在后续下载或加载 B 失败时继续使用原内存规则。仓库的受控测试实际注入断开连接、HTTP 503、截断 SRS 和非法 SRS，通过新的 Route／DNS 请求证明 A 仍有效；解除故障后，再证明 B 生效。这四类注入不代表已经动态验证所有故障。

跨进程恢复是另一件事。只有有效规则已成功写入持久缓存，新进程才可能在离线时恢复它。受控测试在成功持久化 B 后，关闭客户端和规则服务，再用相同配置与缓存路径启动新进程，并通过新请求证明 B 恢复。首次启动无有效缓存、缓存损坏或无法写入缓存时，不具有跨重启旧规则保证。

原生客户端不额外校验 Artifact Manifest 摘要，合法但错误的内容不能依靠客户端摘要检查阻止。合法空 SRS 可以被接受。发布端拒绝原本非空、但所有规则均因无法转换而被跳过的输入。缓存写入失败不会回滚已经生效的内存规则，因此“运行中已经更新”不表示“重启后一定恢复”。缓存写入失败的边界来自固定版本源码核对，现有验收未注入真实磁盘写入失败。

更新周期和缓存由实际客户端配置决定，本项目不统一强制设置。受控测试中的临时 CA、`1s` 周期及持久缓存仅是测试条件。具体执行方式及原生边界见 [#21 验收记录](docs/verification/issue-21.md)。

## 2026-11-09 SFM TestFlight 复测

在一台 macOS 设备上使用 SFM TestFlight 1.14.1000（build 430），从原 `tun` 的本地副本加载隔离分支的 `openai` 稳定 SRS。以下时间为 UTC+8。[隔离分支激活记录](https://github.com/wangyingang/sing-box-rule-artifacts/blob/73a161087b8796623324f2430ef1eaaedfc11b9e/stable/openai/activation.json)

- 19:51:35，SFM 在同一连接 ID 下记录了 `api.openai.com`、试用规则 `openai-sfm-pilot` 的命中、路由到「海外AI」以及实际出站 `dmit-vps-reality`（VLESS）。探测返回 `HTTP 401`。
- 上次的 Codex 响应流故障在本轮未复现。试用窗口内未记录到模型响应流断开或重试。Codex 的远程控制 WebSocket 在切入后和切回后各有一次断开记录。
- 切回后，SFM 于 19:52:07 重新连上，运行配置与原 iCloud `tun` 一致。19:53 重新探测 `api.openai.com`，仍返回 `HTTP 401`。

## 输入与转换边界

以下为内部构建与验证能力，不能绕过五个公开业务入口直接执行运维写入。

`domain/full/keyword/regexp` 分别映射为 `domain_suffix/domain/domain_keyword/domain_regex`。每种谓词单独放在一条 Headless Rule 中，规则集合保持 OR 语义。只对同类型、同值去重，按上述类型顺序和字符串代码单元顺序排序。规范化会复制为固定 `{type, value}` 结构，调用方的对象字段顺序不影响验证或构建身份。

展开列表的 `:@attr1,@attr2` 尾部作为元数据记录。所有条目仍按各自的匹配类型转换。正则末尾的未转义 `:@attr1,@attr2` 按属性语法读取，属性名由小写 ASCII 字母、数字或 `!` 组成。正文保留大小写、Unicode、尾点和转义。若要匹配同形字面量，可转义冒号，例如用 `\:@cn` 匹配 `:@cn`。空值、非法字符、域名空 label／非法边界／超长 label 均失败。正则不使用 JavaScript 引擎预判，目标 Go 引擎由原生加载步骤检查。1.14.4 在 regexp 匹配前将请求域名转为小写，但不改写表达式；大写字面表达式不会因此变成大小写无关。

CIDR 输入使用固定 `ipaddr.js 2.5.0` 解析 IPv4／IPv6 并规范化地址。生成 JSON 保留去重后的独立 CIDR 条目。原生验证依赖指定的官方 1.14.4 编译器生成 SRS，再分别使用 `rule-set match` 实际加载 JSON 和 SRS。真实集成测试用域名、正则和双栈边界验证匹配表现。

同一次 `sync`、`pin`、`resume` 或 `cleanup` 中，后续阶段可以复用与实际 JSON/SRS 字节、工具 SHA-256、验证策略、文件名和产物布局相符的成功证明。各阶段仍核对当前配置、规则更新控制、保留证据、订阅和写入条件。失败可重试，每次调用及重启后的恢复都重新建立操作内证明。详见[配置驱动操作契约](contracts/rules-operations.md#远端事实与版本身份)。

YAML 解析使用固定版本的 [yaml](https://eemeli.org/yaml/)，拒绝语法错误、重复 key、未知 tag、多个文档和 alias。记录级诊断包含文件、列表、从零开始的记录 index，以及从一开始的 line／column。列表级诊断以文件与目标列表定位。

每集构建一份逻辑产物。`build.json` 记录工具内容摘要、验证策略、实际命令和两个文件的摘要。Artifact Manifest v3 记录文件格式、固定地址、字节数和 SHA-256。空列表或筛选后为空的输入可以生成空产物，所有条目因不支持而被跳过的输入使本次构建失败。

## 从空产物状态启用新验证策略

[#174](https://github.com/wangyingang/sing-box-config-manager/issues/174) 在隔离目标从空状态启用 v4。`main` 和 `candidates` 的开发期候选、订阅、证据、版本编号、pin 和未完成操作可以一并清除，旧订阅在切换期间可能不可用。切换是独立操作。先停用生产更新和清理门禁，再准备两个没有 `pipeline/`、`candidates/`、`stable/` 内容的受管分支。必要时可重新初始化产物仓库。

新版从正式配置运行首次 `sync`，初始化远端状态并构建正式配置声明的规则集。在更新门禁授权的环境执行后，用 `status --json` 核对每集已交付且有可选候选。按回读记录核对候选和稳定交付 commit 上 JSON/SRS 正文的长度及 SHA-256。新策略建立的候选可继续 pin、恢复和 cleanup。首次建立状态后，在没有回收对象时，cleanup 只评估保留期并返回 `unchanged`。此后删除产生的待回收历史随删除结案登记。清理重写物理证据地址时保留业务版本、构建身份、首次发布时间、来源和稳定订阅字节。

### 发布后只读核对订阅文件

在仓库根目录运行。先保存 `pnpm --silent rules status --json` 的完整 JSON 输出，或直接使用生产 Actions 的 `status` 运行归档中的 `rule-result.json`。

```bash
pnpm --silent rules:verify-delivery --status rule-result.json \
  --retired https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/main/stable/china-ip/route.json \
  --retired https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/main/stable/china-ip/route.srs \
  > delivery-readback.json
```

每个 `--retired` 指定一个预期已退役的生产订阅 URL。核对当前文件时可以省略此参数。命令以状态记录中的生产提交为基线，实际 GET 固定候选、固定交付和公开稳定地址，核对文件长度与 SHA-256，并检查退役地址返回 HTTP 404。标准输出是可归档的 JSON，退出码 0 表示核对通过。执行使用只读 GitHub 访问，生产更新和清理门禁可以保持关闭。

### 两个 IP 集的订阅文件改名

[#164](https://github.com/wangyingang/sing-box-config-manager/issues/164) 的源码交付以空隔离目标的 16 集验收为准。获生产切换授权后，先记录原有生产 refs 及更新、清理门禁状态，再在暂停自动写入后准备空的生产 `main` 与 `candidates`。用已核对的正式配置执行首次 `sync`。逐集核对 `status`、当前可选候选、Manifest 与固定候选和交付地址回读。单集失败时保留已成功的交付，按 `status` 的诊断恢复并重跑 `sync`。

空状态重建会重新登记候选和版本。旧候选、pin、在途操作和稳定订阅结束使用。重建期间规则随各集交付成功逐步恢复。两个 IP 集的稳定目录保持原路径，`route.json` 和 `route.srs` 退役后，仍引用它们的客户端配置需在后续切换中改用 `ips.json` 和 `ips.srs`。14 个域名集继续使用原稳定地址。产物仓库重置、门禁调整、首次发布和客户端切换分别依实际授权执行。

## 自动化验证

常规检查与完整本地验证使用[根 README 的统一入口](../../README.md#开发检查分别证明什么)。原生集成测试使用真实 sing-box；Git/上游 fixture 只替换外部边界，不意味着执行了真实 GitHub 写入。固定的历史样本用于验证 v4 拒绝覆盖或继续处理旧产物状态。原转换验收的样本和范围见 [#99 历史记录](../../docs/verification/issue-99.md)。

版本选择和保留历史集成测试按测试文件、配置与分支布局共享真实构建的基础状态。每个场景恢复独立的 Git 与上游环境，再通过公开操作验证保存、选择、回收和故障恢复。同一场景内的竞争者仍访问相同环境。运行时操作计数、准备次数和完整测试耗时见 [#132 联合验收](../../docs/verification/issue-132.md)。

```sh
pnpm --dir packages/rule-set-pipeline test
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 pnpm --dir packages/rule-set-pipeline test:integration
```

候选完整性、只读查询、版本重选及并发 pin 的当前覆盖集中在 `test/integration/rules-selection.test.ts`：纯结构错误在候选证据边界集中验证，pin 拒绝交付的断言同时检查当前与兄弟集稳定字节。摘要自洽但内容无效的 SRS 仍由真实原生复验拒绝；status 的候选检查是结构验证，不能替代 pin 的原生复验。旧测试逐项去向、保留给后续工单的段落和整理前基线见 [#94 迁移记录](../../docs/verification/issue-94.md)。

四集双来源同步覆盖位于 `test/integration/rules-inputs.test.ts`：共享来源读取、CIDR 独立变化、同语义不新增版本、共同来源和单列表故障、独立成功保留，以及合法 ID `constructor`。订阅对象的字段顺序语义复用 `rules-selection.test.ts` 的当前 pin 覆盖。[#96 映射与验收证据](../../docs/verification/issue-96.md)说明各旧断言的迁移落点；cleanup 的四集保留、中断恢复及交付交错覆盖见 [#98 映射与验收证据](../../docs/verification/issue-98.md)。

真实客户端覆盖位于 `test/integration/rules-domain-client.test.ts` 与 `rules-cidr-client.test.ts`：当前 sync/pin/resume 驱动同一进程从原稳定 URL 更新域名 DNS/Route 与双栈 CIDR，Recipe、发布快照和配置文件不变。CIDR 场景保留 503、无效 SRS 和有效缓存断网重启；独立 `client-failure-recovery.test.ts` 继续覆盖域名下载／加载故障及持久缓存恢复。它们均由原生集成通配入口执行，隔离 harness 的轮询和缓存设置不修改生产客户端。[#97 映射及证据](../../docs/verification/issue-97.md)记录迁移与退役依据。

正式 16 集的真实 GitHub 验收使用尚不存在的隔离分支、具有该分支写权限的 `gh` 登录、原生编译器和新证据路径。

```sh
RULE_FORMAL_V4_PROBE=1 \
RULE_FORMAL_V4_EVIDENCE=/absolute/path/to/new-evidence.json \
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
pnpm --dir packages/rule-set-pipeline test:acceptance:rules
```

探针用正式 v4 配置和实时上游首次同步，逐集核对固定上游内容和全部匹配谓词，再验证当前候选、Git 中的交付记录及固定候选、固定交付和稳定分支地址。两种格式均通过真实加载和正反例匹配。探针在隔离目标执行 pin、resume 及清理预览，结束时删除隔离分支并核对生产 refs 与门禁。旧验收的来源和范围保留在 [#96](../../docs/verification/issue-96.md) 与 [#164](../../docs/verification/issue-164/README.md) 的历史记录。

若同步中断且原探针已清理分支，可通过 `RULE_FORMAL_V4_RESUME_EVIDENCE` 指向该次证据，并为续跑另设证据路径。探针会核对配置摘要、初始空提交及上一轮记录的隔离 head，再从同一提交链继续。已交付候选需要保留原身份。

cleanup 的真实隔离验收使用单独入口，四集包含域名与 CIDR，验证首次发布时间窗口、当前/pin 豁免、切换中断、HTTPS 回读失败恢复及两轮清理后版本选择：

```sh
RULE_CLEANUP_PROBE=1 \
RULE_CLEANUP_EVIDENCE=/absolute/new-cleanup-evidence.json \
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box \
pnpm --dir packages/rule-set-pipeline test:acceptance:cleanup
```

必须提供尚不存在的证据文件，探针在首次远端写入前保留源码身份。只创建随机 `acceptance-issue-98-*` 目标及其维护临时引用，真实来源/Git/HTTPS 与原生验证继续执行。证据记录成功或失败、运行/回读、生产 main/candidates 与 Actions variables 前后对照，以及临时引用清理结果。默认 CI 和完整本地验证不打开门禁。

原子引用与租约是独立 transport 能力；使用 `RULE_MAINTENANCE_REF_PROBE=1 pnpm --dir packages/rule-set-pipeline test:acceptance:transport` 显式验收。该入口保留随机隔离引用、原子更新与陈旧租约拒绝，不调用旧人工维护阶段。常规 transport 保护在 `test/maintenance-transport.test.ts`；候选清理与交错保护在 `test/integration/rules-cleanup*.test.ts`。

push／dispatch 自动化验收使用显式入口，必须指定已经推送的受审查分支和它的完整 40 位 commit SHA，以及尚不存在的证据目录：

```sh
RULE_AUTOMATION_PROBE=1 \
RULE_AUTOMATION_BRANCH=codex/reviewed-implementation \
RULE_AUTOMATION_COMMIT='<完整的受审查commit-SHA>' \
RULE_AUTOMATION_EVIDENCE=/absolute/path/to/new-automation-evidence \
pnpm --dir packages/rule-set-pipeline test:acceptance:automation
```

该入口要求本机 `gh` 登录可创建源码和产物仓库的隔离分支、触发/读取 Actions；远端继续要求独立 `RULE_ACCEPTANCE_TOKEN`，工作流自行安装并校验真实 sing-box。只创建随机 `acceptance-automation-*` 源码配置分支和同名产物目标。探针在运行前、后续 push/dispatch、运行轮询及旧事件重跑前核对受审查分支 head，不会自动接受新 head；实际事件、工作流 SHA 或 checkout 提交不符立即失败。重跑保持旧事件/工作流身份，但必须 checkout 当前隔离配置分支并读取当前配置。

证据目录保存本地探针源码身份、受审查 branch/SHA、每次配置内容与 commit、运行及 attempt、实际工作流/checkout SHA、摘要与业务结果、生产 refs/Actions variables 前后对照及隔离清理结果。门禁未打开时跳过，不能作为验收通过。默认 CI 与完整本地验证不会启用此远端写入入口；本地拒绝测试使用外部 `gh` 故障模拟，不能代替真实 push/dispatch，也不能把手工通过表述为 schedule 已观察或邮件已实收。当前覆盖、旧 suite 退役及实际执行证据见 [#100 记录](../../docs/verification/issue-100.md)。

旧 `test:publication`、`test:activation`、`test:rollback`、`test:rebuild` 命令已在独有断言迁移通过后移除，不保留兼容别名。`test:release` 运行固定官方 Release 的只读验收，覆盖单列表基线、三个既有 V2Fly 域名集的回归，以及八个新增域名集的构建与原生加载，并核对代表性匹配。范围与统一验证的 `--release` 一致。单独运行时，设置 `SING_BOX_TEST_BINARY` 为 sing-box 1.14.4 的绝对路径，再运行 `pnpm --dir packages/rule-set-pipeline test:release`。规则、清理、自动化和 transport 的远端写入验收均使用上文的独立入口。迁移去向和执行证据见 [#101 记录](../../docs/verification/issue-101.md)。

#84 的验收范围包含新增、换源、删除、pin、resume、部分失败、查询/预览与一次性转换；真实 GitHub 生命周期在专用 `acceptance-*` 分支验证，不写生产分支。场景与远端证据见 [#84 验收记录](../../docs/verification/issue-84.md)，最终源码和交付状态以 [Spec #84](https://github.com/wangyingang/sing-box-config-manager/issues/84) 的 PR 交付证据为准。

#85 的验收聚焦保留范围、当前版本保护、清理后 status/pin、跨机器恢复、只读预览及受管 refs/可达历史。#86 聚焦真实配置 push、手工入口一致性、日常编排、失败映射与生产门禁；定时行为的本地测试不冒充原生 schedule 事件，未验证邮箱实收不报告为收到。最终执行结果以各 PR 和工单的验收证据为准。

已有验收是各自日期与提交的历史事实：[#15 转换](docs/verification/issue-15.md)、[#16 原生验证](docs/verification/issue-16.md)、[#18 候选回读](docs/verification/issue-18.md)、[#19 v1 激活](docs/verification/issue-19.md)、[#20 v1 回滚](docs/verification/issue-20.md)、[#21 客户端故障恢复](docs/verification/issue-21.md)、[#22 重建](docs/verification/issue-22.md)、[#67 四集配置及更名](docs/verification/issue-67.md)。其中旧命令不再是当前操作指南，历史通过不表示 #84 新入口已在生产运行。
