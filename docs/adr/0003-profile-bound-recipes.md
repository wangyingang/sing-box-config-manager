---
status: accepted
---

# 每份 Recipe 固定一种 Client Profile

2026-11-02 的配置管理设计访谈确认，每份 Recipe 固定一种 Client Profile。同一配置使用者的桌面和手机分别维护 Recipe、兼容性诊断和发布版本，通过模板、预设与固定节点修订复用公共内容。

这取代初稿中同一 Recipe 由交付目标选择任意 Profile 的建议。首版不引入平台条件或策略覆盖语言；更换 Profile 通过创建或复制为另一份 Recipe 表达。解析适配器从 Recipe 取得 Profile，映射到核心接口的 `CompileInput`。
