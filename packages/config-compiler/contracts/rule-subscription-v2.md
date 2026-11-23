# Rule Subscription v2

可信宿主通过 `dependencies.subscriptions` 向 Config Compiler 提供规则订阅。Recipe／Template v2 用 `subscriptionRef` 选择系统规则集和用途。Compiler 校验绑定，为 sing-box 生成带稳定 SRS 地址的远程规则集，并把选中的订阅契约保存在配置发布快照中。[编译与发布接口](../README.md#稳定规则订阅recipetemplate-v2)

## 宿主提供的数据

- `schemaVersion: 2` 标识 Rule Subscription 的结构版本。`systemRuleSetId` 是规则集的逻辑 ID。`targetVersion` 为 `1.14.4`，`sourceFormatVersion` 为 `4`。
- `projections` 分别声明 `route`、`dns-query` 和 `dns-response`。可用用途必含 `formats.binary`（SRS），还可提供 `formats.source`（JSON）。不可用用途写作 `{ "unavailable": "empty" }`。
- 每个格式入口包含完整 HTTPS 地址和无重复项的 `requiredCapabilities` 数组。地址不得带凭据、查询参数或片段。支持的能力为 `processMatching`、`packageMatching` 和 `dhcpDns`。同一地址在选中订阅中的格式及能力声明必须一致。
- 宿主核验实际文件、稳定地址及其声明的用途和能力，并确认不同规则集的稳定文件路径互不冲突。Compiler 拒绝未知版本、字段、格式及能力，校验绑定的使用位置和 Client Profile，并要求同一 tag 的多个用途共用一个 SRS 地址。[JSON Schema](rule-subscription-v2.schema.json) · [单集示例](rule-subscription-v2.example.json) · [三集编译示例](../examples/three-rule-subscriptions-v2.json)

例如，宿主可为 `china-ip` 的 `route` 和 `dns-response` 声明同一 `stable/china-ip/ips.srs` 地址，并将 `dns-query` 标为不可用。这样，一份 Recipe 可以用同一 tag 在路由和 DNS 响应条件中匹配 IP。将这个 tag 用于 DNS 请求会得到编译诊断。[客户端集成用例](../../rule-set-pipeline/test/integration/rules-cidr-client.test.ts)

## 与规则交付的关系

Pipeline 在交付记录的 `subscription.schemaVersion: 3` 下保存 JSON/SRS 两个稳定地址。宿主可以取用这些地址，并为 Compiler 明确声明用途。v3 记录不能直接作为 v2 编译输入。快照固定宿主提供的契约，sing-box 后续仍可从同一地址加载新交付的内容。[Pipeline 交付记录](../../rule-set-pipeline/contracts/rules-operations.md#远端事实与版本身份)

Recipe／Template v1 的固定产物绑定使用 Artifact Manifest v2。Rule Subscription v1 已废止，历史说明与当时的 Schema、示例一并归档。[固定产物绑定](../../rule-set-pipeline/contracts/artifact-manifest-v2.md) · [v1 归档](../../../docs/history/rule-subscription-v1/rule-subscription.md) · [v2 原始验收](../docs/verification/issue-35.md)
