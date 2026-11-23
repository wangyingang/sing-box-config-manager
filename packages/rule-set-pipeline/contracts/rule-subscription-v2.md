# Rule Subscription v2

交付范围：[工单 #35](https://github.com/wangyingang/sing-box-config-manager/issues/35)，依据 [Spec #34](https://github.com/wangyingang/sing-box-config-manager/issues/34) 和 [ADR 0006](../../../docs/adr/0006-follow-active-rule-subscriptions.md)。

[JSON Schema](rule-subscription-v2.schema.json) 定义封闭的公开结构；[单集示例](rule-subscription-v2.example.json) 展示字段形状。[三集可编译示例](../../config-compiler/examples/three-rule-subscriptions-v2.json) 展示一份 Recipe 同时绑定 `openai`、`anthropic` 和 `google-deepmind`。示例地址仅用于说明和测试，不代表已发布的入口。

`schemaVersion: 2` 是 Rule Subscription 契约版本，独立于 Recipe／Template 的 `schemaVersion: 2`。`systemRuleSetId` 是管理者定义的逻辑规则集 ID；上游仓库、列表和 Release 不参与该身份或稳定 URL。可信宿主负责装配和核验订阅，Compiler 不接受客户端提供的 URL 或订阅声明作为可信事实。

`targetVersion` 固定为 `1.14.4`，`sourceFormatVersion` 固定为 `4`。`projections` 必须声明 `route`、`dns-query`、`dns-response`。可用用途包含 SRS `binary` 入口和可选 JSON `source` 入口；不可用用途声明 `{ "unavailable": "empty" }`。每个入口包含完整 HTTPS `url` 和非重复的 `requiredCapabilities` 数组。能力词汇限于 `processMatching`、`packageMatching`、`dhcpDns`。未知版本、格式、字段或能力均拒绝。

可信宿主可为当前正式规则集声明用途。域名集的稳定文件为 `domains.json` 和 `domains.srs`，`china-ip` 和 `chatgpt-voice` 的文件为 `ips.json` 和 `ips.srs`。用途和能力由宿主在 v2 订阅中声明。[正式配置](../config/rulesets.yml)

一个本地绑定可选择多个可用用途，前提是这些用途指向同一 SRS URL。同一稳定 URL 在任意声明中的格式和能力必须一致。不同逻辑 ID 的稳定路径由可信宿主保证互斥。Compiler 检查结构、用途、共享入口声明和 Client Profile 能力。远程字节由可信宿主核验。

稳定 URL 交付该逻辑规则集当前激活的版本，由 `sync`、`pin` 或 `resume` 切换。Pipeline 核验候选完整性和实际远端内容，并在换源、自动交付和人工固定历史版本时保留规则集 ID 及两种格式的稳定 URL。客户端何时取得新内容取决于 sing-box 的原生更新机制。

Rule Subscription 不包含候选 revision、sha256、字节数或条目数。[Artifact Manifest v2](README.md) 仍描述不可变候选的实际产物。配置快照固定订阅契约和发布时的配置检查证据，不固定客户端此后加载的规则字节。

Compiler 的编译、配置发布和快照交付入口只接受 v2 订阅。Recipe／Template v1 的固定绑定使用当前 Artifact Manifest v2。Pipeline 自身的交付记录使用 `subscription.schemaVersion: 3`。管理者 pin 控制整集交付，Recipe 的绑定继续跟随稳定入口。[运维契约](rules-operations.md) · [Rule Subscription v1 历史契约](rule-subscription.md)
