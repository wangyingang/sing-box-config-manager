# Rule Set Pipeline 交付契约

每个规则集版本交付一份逻辑产物。JSON（`source`）和 SRS（`binary`）提供相同的匹配内容。生产端记录候选版本和实际交付的文件，客户端从稳定地址获取当前版本。[正式配置与交付流程](../README.md)

| 要查什么 | 查看哪里 |
| --- | --- |
| 某个候选版本生成了哪些文件 | 候选的 `manifest.json` 使用 Artifact Manifest v3。`artifacts` 中两项分别记录 JSON、SRS 的固定地址、字节数和 SHA-256。[Manifest v3 Schema](artifact-manifest-v3.schema.json) |
| 当前交付哪个版本，稳定文件在哪里 | `<publishPath>/_delivery/<artifact>.json` 记录当前候选、交付版本及文件摘要。记录本身为 v2，其中的 `subscription` 为 v3，`formats.source.url` 和 `formats.binary.url` 是稳定地址。[操作与状态契约](rules-operations.md#远端事实与版本身份) |
| 如何在 Recipe 中使用规则集 | Recipe／Template v2 的可信宿主提供用途、能力与稳定地址；v1 的固定产物绑定使用带用途映射的 Manifest v2。[Compiler 的 Rule Subscription v2](../../config-compiler/contracts/rule-subscription-v2.md) · [固定产物 Manifest v2](artifact-manifest-v2.md) |
