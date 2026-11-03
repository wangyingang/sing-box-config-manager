# sing-box-config-manager

面向 sing-box 的配置管理平台，采用三模块 pnpm monorepo。Config Compiler 已完成 D06 最小实现，Rule Set Pipeline 已支持官方更新检查、确定性 JSON／SRS 构建、原生验证与不可变候选发布，Web App 为骨架。

| 模块 | 目录 | 当前状态 |
| --- | --- | --- |
| Rule Set Pipeline | [packages/rule-set-pipeline](packages/rule-set-pipeline/README.md) | 固定 V2Fly Release 下载、摘要校验、JSON／SRS 构建、用途投影、原生验证及经 HTTPS 回读的不可变候选发布、显式激活、历史回滚及受控客户端自动更新 |
| Config Compiler | [packages/config-compiler](packages/config-compiler/README.md) | 固定修订 Recipe 解析、配置组合、校验、受限 ECS 修改和本地发布适配器 |
| Configuration Manager Web App | [apps/web](apps/web/README.md) | 骨架；通过 workspace 依赖调用 Compiler |

Pipeline 发布版本化规则文件和元数据，Compiler 不依赖其源码或运行时。Web App 通过 Compiler 的公开包入口调用功能。各模块分别声明依赖；根目录只管理工作区和统一命令。

## 开发与验证

需要 Node.js ≥24 和 **pnpm 10.33.2**。pnpm 版本固定在根 `package.json` 的 `packageManager` 字段，可由 Corepack 按该字段选择。常规测试不需要本机 sing-box。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm check
```

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | 执行已实现模块的类型检查 |
| `pnpm test` | 执行常规测试和 golden 回归 |
| `pnpm build` | 生成模块构建产物和 TypeScript 声明 |
| `pnpm smoke:workspace` | 构建后，从 Web App 工作区验证包引用、类型和浏览器打包 |
| `pnpm check` | 顺序执行 typecheck、test、build、smoke:workspace |
| `pnpm test:integration` | 原生 sing-box 集成测试，必须显式指定 binary |

原生集成测试要求 **1.14.4**，其 Schema 摘要必须与 Compiler 保存的构建信息一致。缺少 binary 时失败，不静默跳过。

```sh
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box pnpm test:integration
```

[CI](.github/workflows/ci.yml) 在 PR、推送到 `main` 和手动触发时运行：Linux job 执行 `pnpm check`；原生测试 job 下载配置指定的官方 sing-box linux-amd64 发布包，核对归档 SHA-256 后执行 `pnpm test:integration`，测试继续核对 Schema 摘要。两个 job 使用锁文件安装依赖，检查日志作为含提交 SHA 的 artifact 保留 14 天（失败时也尝试上传）。此 workflow 提供检查结果；是否强制阻止合并由 GitHub 分支保护另行配置。

CI 的 sing-box 版本读取自 [Schema 构建配置](packages/config-compiler/schemas/build.json) 的 `version`，Linux 发布包摘要读取自 `releaseAssets.linux-amd64.sha256`。下载地址和解压路径自动生成。升级时更新该配置，并同步核验 Schema、原生校验器和测试基线，无需修改 workflow。

测试在临时目录执行 Compiler merge/check，以及 Pipeline 编译、解码与真实规则匹配；不启动代理、不修改旧配置仓库。五份旧配置候选保持生成语义并通过原生 check；旧 Android 配置含不支持的进程规则，正式 compile 和发布会拒绝它。

当前测试和构建来自 Compiler 与 Pipeline；Web App 骨架没有占位构建或空测试。递归命令只执行模块实际声明的脚本。单独操作 Compiler：

```sh
pnpm --filter @sing-box-config-manager/config-compiler check
pnpm --dir packages/config-compiler build
```

## 调用入口

- `@sing-box-config-manager/config-compiler`：独立核心包，不依赖 Node、数据库、文件、网络或 binary。
- `compile(input)`：返回完整配置或结构化错误；有错误时不返回成功配置。
- `compileRecipe(input)`／`resolveRecipe(input)`：验证封闭 Recipe 契约并解析固定修订依赖。
- `prepareRecipePublication(input, check)`：沿新契约校验两种 ECS 输出，保留完整输入摘要和固定依赖记录；Node 入口提供 `publishRecipe`。
- `inspectRecipeComposition(input)`：新契约迁移审计，带错误候选不得交付。
- `inspectComposition(input)`：预览及迁移审计，可返回带错误的候选，不能将候选直接用于发布或下载。
- `preparePublication(input, check)`：校验启用／关闭 ECS 两种配置，并固定输入和输出摘要。`check` 是可信宿主提供的执行器；mock 只用于单元测试。
- `renderSubscription(publication, params)`：校验可信发布快照，只修改声明的 ECS 字段，不调用 binary。
- `@sing-box-config-manager/config-compiler/publisher`：Node 专用适配器，提供原生检查和本地原子发布；不从核心入口导入。

模块内部接口和使用方式见 [Compiler README](packages/config-compiler/README.md)。同时保留 D06 已解析输入与新 Recipe 数据契约；未实现数据库或 Web API。五份静态迁移映射及发布边界见该模块的“五份样本迁移与 Recipe 发布”说明。

`pnpm build` 生成浏览器兼容的核心 bundle 和 Node 发布适配器。Schema 校验代码由固定 Schema 预生成，运行时无需 `new Function`。尚未实现 Web 页面、HTTP 订阅端点或线上部署。

## 设计与证据

- [#20 历史规则回滚验收](packages/rule-set-pipeline/docs/verification/issue-20.md)
- [#19 显式激活与客户端自动更新验收](packages/rule-set-pipeline/docs/verification/issue-19.md)
- [#18 不可变候选发布与远程回读验收](packages/rule-set-pipeline/docs/verification/issue-18.md)
- [#16 JSON／SRS 原生构建验收](packages/rule-set-pipeline/docs/verification/issue-16.md)
- [1.14.4 merge 源码审计](packages/config-compiler/docs/architecture/sing-box-merge-analysis.md)
- [D06 组合、ECS 与发布契约](packages/config-compiler/docs/architecture/config-composition-design.md)
- [D06 原始验收与 M2 待办](packages/config-compiler/docs/architecture/d06-validation.md)
- [monorepo 迁移记录](docs/architecture/monorepo-migration.md)
- [M2 契约设计与实施计划（草案）](docs/architecture/m2-contract-plan.md)
- [领域术语索引](GLOSSARY-MAP.md)
- [初始交接文档](docs/history/2026-11-02-configuration-management-handoff.md)（历史参考，部分决策已被后续 ADR 和 spec 替代）

各层 `node_modules/`、`dist/` 和生成的 validator 均被 Git 忽略。依赖锁文件只维护根目录 `pnpm-lock.yaml`。
