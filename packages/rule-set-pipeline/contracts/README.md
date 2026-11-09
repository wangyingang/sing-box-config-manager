# 固定产物 Manifest v1

契约演进（2026-11-04）：本页保留 Spec #1 的不可变产物 Manifest v1 契约。
当前 Recipe／Template v2 使用 [Rule Subscription v2](rule-subscription-v2.md) 描述稳定入口及兼容性约束；
[Rule Subscription v1](rule-subscription.md) 已弃用，保留历史契约。不能用稳定可变 URL 冒充本页的固定内容地址。
两者分别管理，不改变 Manifest 字段含义。v1 的 #17 历史范围和证据见
[验收记录](../../config-compiler/docs/verification/issue-17.md)。

本目录由 Rule Set Pipeline 维护，是 Compiler 接入固定内存产物数据的边界。
`artifact-manifest.schema.json` 定义封闭的语言无关结构，
`artifact-manifest.example.json` 是跨模块契约测试使用的合成样本。
本页说明固定产物契约；包内的本地构建入口见 [Pipeline README](../README.md)，本地 `build` 输出已原生验证，但不能直接视为此契约的产物。`update` 另行发布完整 commit 固定的 Manifest 与规则文件，并完成 HTTPS 回读；见 [#18 验收](../docs/verification/issue-18.md)。

Manifest 的 `id` 标识系统规则集，`revision` 固定整个清单的不可变修订。
`schemaVersion: 1`、`targetVersion: "1.14.4"` 和 `sourceFormatVersion: 4`
是明确支持的版本。JSON 源文件和 sing-box 二进制规则文件（SRS）都使用此固定构建目标。
真实 binary 集成测试使用合成规则确认 v4 JSON 可编译为 SRS 并解码恢复。

`artifacts` 中每项 `id` 必须全局唯一且绑定版本，推荐
`<source>:<ruleSet>@<revision>:<format>`。同一 ID 不能在新修订中代表另一份内容。
固定引用使用 `{ id, revision, usage }`，精确匹配物理产物 ID 和 Manifest revision；
不会回退最新版本。重复清单或物理身份、映射到不存在的物理产物均拒绝解析。

物理产物声明 `format: source | binary`、`url`、文件字节 `sha256`、
`byteLength`、`termCount` 和 `requiredCapabilities`。
摘要是实际上传文件的字节摘要，不是 URL、语义内容或 Manifest 的摘要。
条目数、字节数必须为正整数；没有内容的用途不生成产物。
能力词汇仅开放 `processMatching`、`packageMatching`、`dhcpDns`，从实际投影计算。
未知格式、版本、字段或能力不能按兼容处理。

URL 必须为完整 HTTPS URL，不带凭据、query 或 fragment。
路径必须含完整的 revision 或 sha256 段，使清单可指向固定内容地址。
路径检查只是固定地址的结构约束；接入方仍须保证修订路径不可覆盖。
Compiler 不通过 URL 推断或核实实际内容。

`projections` 明确声明全部三种用途：

| 用途 | 可用消费位置 |
| --- | --- |
| `route` | Route 匹配，包括逻辑条件 |
| `dns-query` | DNS 请求匹配，不带启用的 `match_response` |
| `dns-response` | DNS 响应 IP 匹配，当前匹配对象以 `match_response` 引用此前已定义的 evaluate；不能改作 source IP 匹配 |

可用用途为 `{ artifactIds: [id, ...] }`，列表不能为空且不能重复；
没有内容时为 `{ unavailable: "empty" }`。多个用途可以映射到同一物理文件，
例如纯域名集合的 Route 和 DNS 请求用途。物理文件也可以分别有 source 和 binary 格式。
不通过文件名猜测用途，不把不可用用途转换成空 Headless Rule。
DNS 具名响应需要此前同名 evaluate，`match_response: true` 需要此前无 tag 的 evaluate。
逻辑子条件独立验证响应上下文，预设在 Recipe 的消费位置验证。

Recipe／Template 的 curated binding 仅接受：

```json
{
  "kind": "curated",
  "tag": "local-domains",
  "artifactRef": { "id": "synthetic:domains@1:source", "revision": "1", "usage": "dns-query" },
  "httpClient": "download"
}
```

用户不能在 binding 填写 URL、路径、摘要或能力。HTTP client 引用仅连接到
已经开放的 HTTP client 资源，沿用既有引用检查。
Compiler 接受宿主提供的 `dependencies.manifests`，检查结构、固定版本、用途及 Profile，
再显式映射到现有 `RuleArtifact`。用途和条目数等产物清单元数据由适配器处理，不传入 `CompileInput`。
Compiler 不导入 Pipeline 运行时代码，也不实时运行 Pipeline。

可信接入方负责清单来源、产物 ID 与修订不可变性、HTTPS 地址不可覆盖、远程内容下载、
格式／投影内容与能力声明一致性，以及字节数和 sha256 校验。
浏览器提交的“已验证”标志无效。本目录样本的摘要和地址是合成值，
不是远程文件验收证据。`sing-box check` 成功同样不代表远程内容已核验。
