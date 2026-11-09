# Rule Set Pipeline：需求收敛与后续开发交接

> **状态：供 Codex 阅读与制定下一阶段 Spec 的交接资料；不是已批准的实施 Spec，也不是执行授权。**  
> **整理日期：** 2026-11-06  
> **实际 GitHub 仓库：** [`wangyingang/sing-box-config-manager`](https://github.com/wangyingang/sing-box-config-manager)  
> **核查基线：** `main`，提交 `62b4a0c9b5dc8794e890918d654fd46cf8fbb0b9`（核查时）；动工前必须重新核对最新代码、工单与 ADR。  
> **关联产物仓库：** [`wangyingang/sing-box-rule-artifacts`](https://github.com/wangyingang/sing-box-rule-artifacts)  
> **名称提示：** 本次会话中用户曾称项目为 `sing-box-configuration-manager`，GitHub 实际仓库名是 **`sing-box-config-manager`**。在本地以 `git remote -v` 确认路径与目标仓库，勿凭名称创建新仓库。

## 0. 给接手 Codex 的任务说明（必读）

本交接记录用户与 ChatGPT 对上游规则选择、Rule Set Pipeline 最小功能边界及现有实现的讨论结论。**先阅读本文件及仓库现有契约，以只读方式核对事实并收敛设计；不要直接按本文批量改代码。**

优先读：

1. `AGENTS.md`；`docs/agents/issue-tracker.md`、`docs/agents/domain.md`、`docs/agents/triage-labels.md`；有关 `GLOSSARY` 与 ADR 的指引。
2. `packages/rule-set-pipeline/README.md`、`GLOSSARY.md`、`src/`、测试、`contracts/`。
3. `docs/adr/0006-follow-active-rule-subscriptions.md`、`docs/architecture/rule-set-pipeline-first-delivery.md`、相关已完成 Issue、当前 GitHub Actions。
4. `packages/config-compiler/` 对 Rule Subscription v1、Profile/Capabilities 的消费契约，避免破坏消费者。
5. 本文件中的 **“已明确的产品边界”**、**“尚待决定的契约变更”**、**“阶段一验收”**。

请严格区分：**用户已明确决定**、**评审者推荐方案**、**仍待核实的技术事实**。既有 accepted ADR / 公开契约不可因本文提议而被隐式替换。涉及 agent-facing 文档编辑时按仓库 `AGENTS.md` 先展示最终文本并获批准。未经明确授权，不执行生产激活、部署、发布或合并 PR。

## 1. 为什么需要这次交接

之前讨论先从“优秀的 Global 规则”发展到“跨平台分流规则上游”，又列出七类目标；讨论一度有泛化风险，提出了多上游交叉核对、主动封锁探测、规则质量评分、智能分析等复杂功能。**用户明确否定将这些任务纳入 Pipeline。**

用户的真实场景是：个人、家人、朋友使用 sing-box；未来可能开源供其他人自行定制。优先选一个高质量上游来提供一个关注的分类，并只作必要的过滤、去重、语义保留和格式转换；无需建设规则研究或规则治理系统。

目标运行平台：**Windows、macOS、iOS、Android**；区分能够影响匹配类型的 **Standalone 与商店分发**（例如 macOS Standalone 与 App Store），不要假设所有平台的 Process / Package 能力相同。项目编译目标当前为 **sing-box 1.14.4**；如用户未另行决定，应尊重现有固定版本与 Source Format 契约。

## 2. 已明确的产品边界（最高优先级）

### 2.1 Pipeline 必须做

- 管理者以**声明式配置**指定规则上游（地址/格式）、要取的规则列表或分类、逻辑名称、DNS/Route 使用场景、目标平台与分发渠道、输出及稳定发布路径。
- 按周期检查上游，检测到**有效变化**后获取、解析、做必要的类型过滤/去重/拆分、编译 JSON/SRS 并验证。
- **只在需要时拆分**：纯域名规则可供 Route 和 DNS-query 共用同一产物；Route 可保留合法的域名+IP 混合规则；DNS-query 只使用域名匹配部分；确有需求时为 DNS-response IP 匹配输出相应投影，具体 DNS `evaluate` 等策略由 Config Compiler 处理。
- 依据平台/分发能力过滤或生成必要变体；实际内容相同的产物应复用，不强行给每个操作系统都创建一份。
- 发布到稳定订阅 URL；订阅者通过 sing-box 原生远程规则更新机制获取新版本。无需自建推送/客户端更新服务。
- 建立必要的安全门禁：下载或解析异常、无效/空规则集、格式或能力不兼容、SRS 编译或远程回读失败时**不以坏产物覆盖现有稳定版本**；已有候选/激活/回滚能力应优先复用。
- 保持 Pipeline 与 Config Compiler 的职责隔离：前者生成规则产物/兼容性元数据，后者编排 DNS/Route 策略、规则优先级与最终完整配置；Web App 管理用户配置和订阅。

### 2.2 Pipeline 不做（禁止范围泛化）

- 不跨多个“权威上游”做规则质量评分、事实校对、封锁/解封实测、IP 归属验证。
- 不主动挖掘新 AI 域名/GFW 封锁目标，不维护大型域名情报数据库或复杂 provenance 引擎。
- 不做自动纠错、复杂规则优化、跨源冲突管理系统、CIDR 智能精炼、语义猜测或正则重写。
- 不一次性支持任意格式或任意平台代理软件；只按已选上游适配所需格式，产物以 sing-box 为先。
- 不提前开发规则管理 Web UI、专用后台数据库、实时任务队列、Workers 端编译、完整配置生成能力。
- 不因“以后可能开源”引入公共 SaaS 所需的多租户、权限和计费系统。

**规则分类的正确性主要由管理者选择的上游负责。Pipeline 只负责 faithfully 适配与安全发布。**

## 3. 用户关心的七类上游规则

下面是**上游选择建议与待核实清单**，不是必须接入全部来源的实现指令。目标是**每个逻辑分类优先一个主源**，必要时换源，不默认做 A+B 合并或“B 校验 A”。

| 分类 | 候选主源（优先核查） | 关键边界/尚待核实事项 |
| --- | --- | --- |
| 国内域名 | [V2Fly Domain List Community](https://github.com/v2fly/domain-list-community) 的 `geolocation-cn` 相关类别 | 检查 Release 中的实际列表名；国内 CDN/加速域名不等同于严格国内归属 |
| 国内 IP | [gaoyifan/china-operator-ip](https://github.com/gaoyifan/china-operator-ip) 的 IPv4/IPv6 CIDR 列表 | 运营商/BGP 来源并非绝对的物理地理位置证明；按需选 IPv4+IPv6 |
| 海外域名 | V2Fly `geolocation-!cn` | 已收录的非 CN 类别，不是互联网所有境外域名的全集，也不等于 GFW 封锁 |
| 海外 IP | GeoLite2 Country 或适用的国家 IP 地理数据（可选/后置） | 需正确处理保留/未知地址；“非中国 IP”不能代替“需要代理” |
| GFW / 最小 Proxy | [GFWList](https://github.com/gfwlist/gfwlist)（候选） | GFWList 是维护型代理候选列表而非实时、完备的封锁真值；**不要将广义 Global 和 GFW 混为一谈**。GFW IP 缺少完整可靠的静态源，允许暂不发布 |
| 海外 AI 域名（最优先） | V2Fly `openai`、`anthropic`、`google-deepmind`、`xai` 等 | **OpenAI、Anthropic、Gemini 必须独立**；`google-deepmind` 比 Gemini 范围大，Meta AI 独立高质量原始源仍须确认。不要把整个 Google / Cloudflare / AWS 域名归入某个 AI 厂商 |
| 海外 AI IP（有则收） | OpenAI 官方 ChatGPT Voice IP 数据（有明确用途） | 不存在可被可靠认定为“全部 OpenAI/Anthropic/Gemini AI IP”的通用静态数据；只在明确专属范围与用途时发布，避免误导 |

其他研究过但**不必全部接入**的项目：`blackmatrix7/ios_rule_script`（分类覆盖广，部分 AI 专项规则更新滞后）、`SukkaW/Surge`（精细规则设计/聚合）、`MetaCubeX/meta-rules-dat`、`DustinWin/ruleset_geodata`、`Loyalsoldier`（多为转换/聚合成品）。选择上游时看**目标分类的准确性和维护状态**，不因 Star 数、文件规模或现成 SRS 就默认最优。

说明：早期关于“Global 最佳”的讨论有推荐价值，但**最新已确定目标是按分类选择一个主源，不建立跨上游数据校对流水线**。此后设计以第 2 节为准。

## 4. 已核查的现有代码与能力（截至基线提交）

项目是 Node.js ≥24、pnpm Monorepo、TypeScript。`@sing-box-config-manager/rule-set-pipeline` 当前为**一个固定来源、固定列表的完整验证与发布样本**：

- 生产输入固定为 V2Fly `domain-list-community` Release 的 `dlc.dat_plain.yml` 中 `category-ai-!cn`；不是全面 V2Fly 原始 DSL Parser；上游 Include 等关系由 V2Fly 官方构建链预处理。
- 已实现获取固定 Release/asset、摘要/来源校验、四种域名匹配映射、重复/无效检查、`route` / `dns-query` / `dns-response` 投影、sing-box 1.14.4 原生 JSON/SRS 编译、解码语义验证、加载验证。
- 已有 `build:release`、`update`、`rebuild`、`activate`、`rollback`、`status` CLI；`update` 形成远端不可变候选并进行 HTTPS 回读，**不会自动激活**；`activate` 将候选切换至稳定入口；提供回滚及客户端失败恢复验收。
- `Rule Subscription v1` 与 `Artifact Manifest v1` 分离：前者定义稳定订阅入口、用途、能力与版本，后者记录某次候选产物的不可变身份、哈希和验证记录。Config Compiler 只消费可信订阅契约/元数据，不依赖 Pipeline 运行时源码。
- `CI` 已有构建/测试/Native sing-box 验证；**没有用于生产的周期性来源检查、自动激活流程**。
- 自动更新所用 `--state` 目前为本地持久目录；GitHub Actions 新 runner 不能默认共享该目录，需要另定**可恢复的持久状态策略**，不能仅依赖易失的 Actions Cache。
- 现有 Manifest/激活验证中存在与首个样本绑定的常量，如 `TARGET_LIST = 'category-ai-!cn'`、`v2fly:category-ai-!cn`、`v2fly:domain-list-community:category-ai-!cn`、恰好两个产物、DNS-response 为 empty、无额外能力要求、固定记录路径 `stable/activation.json`。新增多规则集不能仅将读取列表名参数化。
- 产物仓库 `main` 在此前核查时尚未有生产 `stable/` 交付（仅 README）；**这个状态随时可能变化，开始实施/上线前须重新核实**。

主要阅读点：

- [`types.ts`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/src/types.ts)、[`release.ts`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/src/release.ts)、[`yaml-input.ts`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/src/yaml-input.ts)
- [`convert.ts`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/src/convert.ts)、[`projection.ts`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/src/projection.ts)、[`native.ts`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/src/native.ts)
- [`update.ts`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/src/update.ts)、[`activation.ts`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/src/activation.ts)、[`publication.ts`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/src/publication.ts)
- [`contracts/rule-subscription.md`](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/contracts/rule-subscription.md)、[`docs/adr/0006-follow-active-rule-subscriptions.md`](https://github.com/wangyingang/sing-box-config-manager/blob/main/docs/adr/0006-follow-active-rule-subscriptions.md)

**保留原则：** 不重写现有原生验证/不可变候选/回读/并发保护/回滚；仅将首个样本的“来源、规则 ID、产物数量与用途”从硬编码逐步改为基于配置与 Manifest 的一致性检查，同时**不放宽安全门禁**。

## 5. 两个需要先讨论、不能擅自实施的契约变化

### D1. 固定逻辑 ID 与来源命名 ID 的冲突

用户希望自己定义 `ai-openai`、`ai-anthropic`、`ip-cn` 等逻辑 ID；更换上游源时，尽可能不改变订阅者消费的身份与 URL。

但现有 Rule Subscription v1 **明确规定** `systemRuleSetId` 带来源命名空间，“同名不同来源不能合并”，当前 Compiler/Fixture 也依赖此契约。直接将公开 ID 改为 `ai-openai` 会触发兼容性变更。

**待决策：** 是否保持 v1 系统 ID 不变、增加配置层逻辑别名映射；或明确引入 v2 身份/迁移机制。优先低迁移成本且不破坏旧配置的方案。请先阅读当前消费者、Schema、测试、ADR，并向用户展示最小可行方案，不要直接替换 ID。

### D2. 候选“显式激活”与无人值守更新的冲突

用户希望定时检查上游，更新有效时自动使 stable 规则生效。但 ADR 0006 和当前 README 明确把构建候选、激活稳定规则区分，**当前激活必须显式操作**。

**待决策：** 保留候选与完整验证，新增通过门禁后自动激活的调度层；由用户批准何时启动生产自动激活、首次上线、回滚和失败处理策略。若改变现有 accepted ADR 的管理决策，需要新增/修订 ADR 和相应测试；**不得用“自动更新”四个字直接跳过现有激活校验**。

其他实现选择尽量在 Spec 中收敛，不发散成大量架构讨论。

## 6. 推荐的最小配置模型（仅供设计，未获审批）

配置可以采用一个 YAML 文本文件，无需数据库；**Source、逻辑 Ruleset、发布 Artifact 是三个概念，不必建三套服务/数据库**。

```yaml
version: 1

defaults:
  target: sing-box-1.14.4
  formats: [source, binary]
  profiles: [windows-standalone, macos-standalone, macos-appstore, ios-appstore, android-google-play]

sources:
  v2fly:
    format: v2fly-plain-release
    repository: v2fly/domain-list-community
    asset: dlc.dat_plain.yml

rulesets:
  - id: ai-openai        # 配置层逻辑别名；不等同于已批准的系统公开 ID
    source: v2fly
    list: openai         # 须实际核对上游 Release 的列表名
    usages: [route, dns-query]
    publish: ai/openai  # 相对稳定路径；公开 URL / v1 兼容性须先设计

  - id: ai-anthropic
    source: v2fly
    list: anthropic
    usages: [route, dns-query]
    publish: ai/anthropic

  - id: ai-gemini
    source: v2fly
    list: google-deepmind  # 候选范围可能大于 Gemini，须核对是否符合目标分类
    usages: [route, dns-query]
    publish: ai/gemini
```

上例是**讨论输入**，不宣称当前解析器、Schema、CLI 支持这些字段。实际字段、平台能力名称、发布 URL、Source Format 与 v1 迁移方案应以最新代码审查和 Spec 为准。

适配器只为真实来源实现（如 V2Fly Plain YAML、纯 CIDR 列表；以后确需接入再添加有限 Clash/GFWList 子集）。源格式结构化依赖必须忠实处理；支持官方已展开 Release 时不强制自建 DSL include 解析器。对复杂复合条件不能删除 AND 中一个条件而扩大匹配，应拒绝/跳过整个无法忠实表达的条件并提供诊断。

## 7. 推荐分阶段交付与验收

### 阶段 A（下一个实施 Spec 的建议范围）：配置驱动的 V2Fly 多规则集

**限定内容：** 仅复用现有 V2Fly 官方 Release 与已支持的域名规则格式，选择 **OpenAI、Anthropic、Google AI/Gemini 候选** 三个列表。不要同时添加 GFW、CIDR、新上游格式、GitHub Actions 生产调度或 Web UI。

必须能观察到的行为：

1. 管理者修改配置即可定义至少三个不同的逻辑规则集/上游列表；一次 Release 下载可供多个所选列表使用。
2. 单个规则集的转换、JSON/SRS 构建、校验、候选及稳定入口**彼此隔离**；其中一个异常不能覆盖其他规则集。
3. `route` 与 `dns-query` 对相同纯域名内容可以复用同一物理产物；`dns-response` 明确不可用，不发布伪空文件。
4. 激活仍必须通过 Manifest、字节摘要、native round-trip、能力/用途契约、可信稳定入口与并发保护；根据真实 Manifest 数量验证，不能再假设总是两个文件、一个列表。
5. 既有 `category-ai-!cn` 的订阅契约、候选、回滚和相关测试仍有效；若公开身份和 URL 策略改变，须有显式版本化或迁移验证。
6. 不能自动进入生产 `main` 稳定路径；生产激活仍需用户单独批准。

### 阶段 B：无人值守周期检查与自动激活（在 D2 通过后）

- 独立 GitHub Actions 定时执行（如每日一次，精确周期由用户确认）；原 CI 不承担生产发布职责。
- 上游没有有效变化不重复发布；发生变化则安全构建，验证通过才自动激活该规则集。
- 状态持久、可从远端记录恢复；单源或单规则失败保留旧稳定版本，其他规则不受影响。
- 首次生产自动激活必须有明确授权、凭据和回滚预案；测试行为不等于生产上线。

### 阶段 C：按需增加新源和能力（不整体打包实施）

- 根据真实七类需求先增加必要 CIDR 格式、GFWList 等 Adapter；上游及文件选型由用户确认。
- 仅当选中来源确实包含 Process/Package 匹配时才新增平台/分发渠道变体；优先借用 Config Compiler 已有 Profile/Capability 词汇与契约，但避免运行时代码耦合。
- IP 海外、GFW IP、AI 专属 IP 若没有可靠单一上游，可保持不实现/暂不发布，不得为了“七类凑齐”自行发明事实。

## 8. 现有文档、工作流与协作要求

现有 `AGENTS.md` 已定义：GitHub Issues 为 Tracker，三模块 Monorepo 的领域文档与 ADR、任务分支/worktree、PR 和云端 Codex review 的检查规则。**无需重新运行 `/setup-matt-pocock-skills`，除非 Codex 发现配置确实缺失或损坏。**

后续应按当前仓库约定：在任务 worktree 中开发，功能/公开契约更改使用独立分支和 PR；执行测试，报告证据；默认停在 PR 待审，不自行合并或生产发布。不要修改用户其他工作区。

仓库已有历史交接 `docs/history/2026-11-02-configuration-management-handoff.md`，顶部明确标注**历史归档，非当前规范**。不要从其中的过时结论推导当前代码状态。本文件同样是一次时点的交接资料；后续具有约束力的落地内容应由新 Spec、ADR 和订阅契约承载。

### Matt Pocock 的 Skills：本交接如何进入开发流程

已核对 [`mattpocock/skills`](https://github.com/mattpocock/skills) 的现行技能说明（以实际安装版本为准）：

- `/ask-matt`：仅作**路由建议**，不替你执行其他 Skills；已经知道下一步时可以跳过。
- `/grill-with-docs`：在仓库内澄清尚未定案的决策；依赖 `grilling` 与 `domain-modeling`，可能按批准结果写术语表/ADR，但**不会自动保存全部详细需求为 Spec**。只针对本文件 D1、D2、阶段 A 行为等真正未定项，不应重新发散已经收敛的功能边界。
- `/to-spec`：根据当前会话和代码核查形成 Spec，复核测试 seam，并发布到已配置的 GitHub Issues。**尽量在同一会话中承接 grilling，不要先清空上下文。**
- `/to-tickets`：由已批准的 Spec 拆成可单独验收的小任务，显示依赖，待用户认可后写入 GitHub Issues。
- `/implement`：每次在新的上下文按一个已确认 Issue 实施，调用 TDD、Code Review，并遵循 `AGENTS.md` 的 PR 交付边界；`/implement-spec` 可多工单编排，但首轮不推荐以它替代人工逐项验收。
- `/wayfinder`：仅当整个方向仍巨大而模糊时使用；本项目 Rule Set Pipeline 的短期范围已经清楚，一般不需要。
- `/handoff`：用于跨会话/代理/工作目录传递上下文。本文件已经是为此目的准备的交接资料，**不必为了“使用 workflow”而再生成一份重复 handoff**。

建议操作顺序：将本文加入工作仓库 → Codex **只读核对** → 讨论 D1/D2 的最小方案 → 适度 `/grill-with-docs` → `/to-spec`（用户确认）→ `/to-tickets`（用户确认）→ 按工单 `/implement` → PR Review。阶段 B、C 单独形成后续 Spec，不要混入阶段 A。

**最重要的人类检查点：** 设计/ADR 改动、Spec 及测试 seam、Tickets 粒度与依赖、是否允许生产发布/激活。无需为每个没有歧义的代码细节反复询问。

## 9. 给 Codex 的首轮只读指令（可直接粘贴）

> 请先阅读 `docs/handoffs/2026-11-06-ruleset-pipeline-scope-handoff.md`、本仓库 `AGENTS.md`、Rule Set Pipeline 的 README/Source/Contracts/Tests、ADR 0006，以及 Config Compiler 对 Rule Subscription v1 的实际消费代码。根据最新 main 核对交接文档的事实、现有约束与过期之处。**本轮不修改文件、不创建 Issue/PR、不调用生产激活。** 请只输出：① 已确认、可沿用的实现；② 与新的最小目标冲突的确切代码与契约；③ D1/D2 各一个最小修改方案及兼容性代价；④ 阶段 A 的严格范围和 4～6 条可验收行为；⑤ 必须由我决定的问题（只提真正阻塞的）。不要建议质量评分、跨上游校对、规则探测或大型通用 Parser。等我确认后再进入 `/grill-with-docs` 或 `/to-spec`。

## 10. 参考链接

- 代码：[`sing-box-config-manager`](https://github.com/wangyingang/sing-box-config-manager)；[Rule Set Pipeline README](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/README.md)；[Rule Subscription v1](https://github.com/wangyingang/sing-box-config-manager/blob/main/packages/rule-set-pipeline/contracts/rule-subscription.md)；[ADR 0006](https://github.com/wangyingang/sing-box-config-manager/blob/main/docs/adr/0006-follow-active-rule-subscriptions.md)。
- Matt 文档：[`ask-matt`](https://github.com/mattpocock/skills/blob/main/docs/engineering/ask-matt.md)、[`grill-with-docs`](https://github.com/mattpocock/skills/blob/main/docs/engineering/grill-with-docs.md)、[`to-spec`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md)、[`to-tickets`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md)、[`implement`](https://github.com/mattpocock/skills/blob/main/skills/engineering/implement/SKILL.md)。
- sing-box 官方：[Rule Set 配置](https://sing-box.sagernet.org/configuration/rule-set/)；[Source Rule Set](https://sing-box.sagernet.org/configuration/rule-set/source-format/)。

---

**交接完成标准：** Codex 能据此不再重复“需要一套规则精炼/校对平台”的错误方向，同时能识别现有订阅契约与新需求之间的真实冲突，并形成一个**只扩展 V2Fly 多规则集的首个小范围 Spec**；未经用户批准，不改生产状态。
