# Glossary Map

## Contexts

- [规则生产](packages/rule-set-pipeline/GLOSSARY.md)：系统规则源、转换、投影与规则产物。
- [配置编译](packages/config-compiler/GLOSSARY.md)：模板、Recipe、策略、客户端能力与配置编译。
- [配置管理](apps/web/GLOSSARY.md)：用户的配置草稿、发布版本与订阅。

## Relationships

- 规则生产向配置编译提供已发布的规则文件和元数据；配置编译不读取规则生产的内部数据。
- 配置管理保存用户的配置意图，解析固定版本的依赖后交给配置编译。
- 配置编译产生配置候选和诊断；配置管理通过可信校验流程发布配置并管理订阅。

跨上下文设计草案见 [M2 契约与实施计划](docs/architecture/m2-contract-plan.md)。全局 ADR 位于根 `docs/adr/`，已有 [共享节点与固定修订引用](docs/adr/0001-shared-node-revisions.md)；上下文 ADR 放在对应模块的 `docs/adr/`。

M2 已确认：[统一管理配置](docs/adr/0002-admin-managed-configurations.md)、[每份 Recipe 固定 Client Profile](docs/adr/0003-profile-bound-recipes.md)。

编辑与校验边界：[Recipe 管理预设引用与顺序](docs/adr/0004-recipe-controls-preset-order.md)、[草稿保存与可交付校验分别处理](docs/adr/0005-structurally-valid-drafts.md)。节点归档规则记录在共享节点 ADR 中。
