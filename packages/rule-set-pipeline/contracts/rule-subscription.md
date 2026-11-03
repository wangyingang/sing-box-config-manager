# Rule Subscription v1

交付范围：[工单 #17](https://github.com/wangyingang/sing-box-config-manager/issues/17)，承接 [Spec #14](https://github.com/wangyingang/sing-box-config-manager/issues/14) 和 [ADR 0006](../../../docs/adr/0006-follow-active-rule-subscriptions.md)。

本契约由 Pipeline 拥有，Compiler 只消费可信宿主提供的已验证内存数据。
[JSON Schema](rule-subscription.schema.json) 是语言无关的封闭结构；
[示例](rule-subscription.example.json) 是跨模块测试 fixture，地址形状不表示已上线。
Compiler 的结构解析器及 JSON Schema 通过共同正反例校验，不导入 Pipeline 运行时代码。

## 稳定身份与入口

`schemaVersion: 1` 是订阅契约版本，与 Recipe／Template 的版本分别管理。
`systemRuleSetId` 是带来源命名空间的系统规则集身份；同名但不同来源的集合不能合并。
`targetVersion: "1.14.4"` 和 `sourceFormatVersion: 4` 固定消费目标及源规则格式。
未知版本、格式或能力必须拒绝，不能猜测兼容或回退固定产物。

`projections` 必须明确列出 `route`、`dns-query`、`dns-response`：

- 可用用途为 `{ formats: { binary: { url, requiredCapabilities }, source?: { url, requiredCapabilities } } }`。
- `binary` 为 SRS，是本版 Compiler 的默认消费格式；`source` 为可选 JSON 入口，不是用户的格式或版本选项。
- 无内容用途为 `{ unavailable: "empty" }`；不能以空规则文件、空对象或缺失声明代替。

`url` 是完整 HTTPS 稳定入口，不含凭据、query 或 fragment。
宿主负责保证其为系统批准的稳定发布路径。仅凭 URL 字符串不能证明入口稳定、可信或已上线。
纯域名集合的 Route 与 DNS 请求可复用物理文件；DNS 响应用途不可用。
不同用途需要不同内容时，使用各自入口，不能把多个文件合为一个本地 tag。
同一 URL 的格式及能力声明必须一致，能力从相应用途内容计算。

`requiredCapabilities` 使用封闭词汇 `processMatching`、`packageMatching`、`dhcpDns`，
非重复数组；它是稳定入口在本契约下允许交付内容的能力上限。
Compiler 按选中用途检查固定 Client Profile 能否支持声明的所有能力。
未选择的用途不限制该配置的 Profile。

本契约没有产物 revision、sha256、字节数或 term 数。这些属于不可变
[Artifact Manifest](README.md)，用于描述某次已验证规则文件的实际内容和追溯身份。
稳定入口未来可以交付另一版本，不能把某次不可变产物摘要当作其未来内容摘要。
规则订阅和面向配置使用者的配置订阅授权也分别处理。

## 后续每次激活必须遵守的兼容性约束

这些是后续候选发布／激活实现的门禁要求，#17 不执行这些操作。

1. 核验候选完整性、实际字节摘要、字节数、非空 term 数、真实目标版本的编译／解码／加载及用途语义。配置 `check` 不能替代这些证据。
2. 候选目标版本和 Source Format 必须与订阅契约一致；所有可用用途的每种声明格式均须有对应的已验证非空产物。不能删除既有入口或改变其格式。
3. Route 保留适用谓词；DNS 请求只能使用域名谓词；DNS 响应只能使用目标 `ip_cidr`。不能以改变文件内容绕过消费位置限制。
4. 各产物实际需要的能力必须是对应入口 `requiredCapabilities` 的子集。需要新增能力时不能静默扩大既有契约；应另行版本化契约和兼容入口，并重新验证受影响配置。
5. 保持系统规则集身份、稳定 URL、用途可用性和复用文件关系。不可用用途不能偷偷上线为可绑定用途；改变公开兼容性约束需要显式契约演进，不能使旧快照指向不兼容内容。
6. 仅通过门禁的候选才可更新稳定文件。后续激活实现还须遵守 Spec #14 的并发保护、状态核实和回滚要求。

## Recipe／Compiler 接入

Recipe 与 Template 使用 `schemaVersion: 2`，固定 Recipe／Template 修订和 Profile，
系统规则绑定为：

```json
{
  "kind": "subscription",
  "tag": "ai",
  "subscriptionRef": {
    "systemRuleSetId": "v2fly:domain-list-community:category-ai-!cn",
    "usages": ["route", "dns-query"]
  },
  "httpClient": "download"
}
```

单用途可以写 `usage: "route"`；不能与 `usages` 混用。用途数组非空、无重复。
一个本地 tag 的多个用途必须复用同一 SRS URL，否则显式拒绝并要求分别绑定。
用户不传规则版本、URL、摘要、格式或能力覆盖；可信宿主单独装配 `dependencies.subscriptions`。
宿主不能从浏览器请求直接接受该字段作为可信事实；结构通过不是信任证明。

Recipe 与选中的 Template 必须使用相同 schemaVersion，不能在 v2 文档混入固定产物绑定。
迁移需显式创建新的 Recipe 和 Template 修订，保留节点固定修订、HTTP client 及策略顺序，
以订阅绑定替换固定产物绑定并重新校验／发布，不自动升级原有文档。
`schemaVersion: 1` 的固定 Manifest 路径和 Spec #1 历史验收继续保留，不重新解释为自动跟随。

Compiler 对每个 Route／DNS 消费位置检查用途，包括预设及逻辑子条件。
DNS 响应必须引用此前已 evaluate 的响应上下文，目标 IP 投影不能改作 source IP。
HTTP client、节点、模板、Profile 及现有资源引用检查继续生效。

生成配置使用 `type: "remote"`、`format: "binary"` 和契约稳定 URL。
不注入统一 `update_interval` 或缓存设置；已有 Template 显式缓存选择保持有效。
激活规则无需改 Recipe 或重新发布配置；传播时间和失败保留遵循客户端原生能力边界。

发布快照保存配置、选中订阅的完整契约、输入摘要及现有两种 ECS 原生配置检查摘要。
`recipeSource.subscriptions` 和 `compiled.subscriptions` 与发布 ID 绑定；
`recipeSource.artifacts` 仅记录旧版不可变产物，新订阅不会生成伪造的固定摘要。
原生检查回执证明发布时配置通过指定 checker；真实远程内容和来源验证仍由可信宿主负责。
快照不固定客户端此后加载的规则字节，#17 不提供下载、候选上传、激活或客户端更新实现。
