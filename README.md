# sing-box-config-manager

面向 sing-box 的配置管理平台，采用三模块 pnpm monorepo。Config Compiler 已完成 D06 最小实现，另外两个模块为骨架。

| 模块 | 目录 | 当前状态 |
| --- | --- | --- |
| Rule Set Pipeline | [packages/rule-set-pipeline](packages/rule-set-pipeline/README.md) | 骨架；后续实现规则采集、转换、编译和发布 |
| Config Compiler | [packages/config-compiler](packages/config-compiler/README.md) | 配置组合、校验、受限 ECS 修改和本地发布适配器 |
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

测试仅在临时目录 merge/check，不启动代理、不修改旧配置仓库。五份旧配置候选保持生成语义并通过原生 check；旧 Android 配置含不支持的进程规则，正式 compile 和发布会拒绝它。

当前测试和构建来自 Compiler；两个骨架模块没有占位构建或空测试。递归命令只执行模块实际声明的脚本。单独操作 Compiler：

```sh
pnpm --filter @sing-box-config-manager/config-compiler check
pnpm --dir packages/config-compiler build
```

## 调用入口

- `@sing-box-config-manager/config-compiler`：独立核心包，不依赖 Node、数据库、文件、网络或 binary。
- `compile(input)`：返回完整配置或结构化错误；有错误时不返回成功配置。
- `inspectComposition(input)`：预览及迁移审计，可返回带错误的候选，不能将候选直接用于发布或下载。
- `preparePublication(input, check)`：校验启用／关闭 ECS 两种配置，并固定输入和输出摘要。`check` 是可信宿主提供的执行器；mock 只用于单元测试。
- `renderSubscription(publication, params)`：校验可信发布快照，只修改声明的 ECS 字段，不调用 binary。
- `@sing-box-config-manager/config-compiler/publisher`：Node 专用适配器，提供原生检查和本地原子发布；不从核心入口导入。

模块内部接口和使用方式见 [Compiler README](packages/config-compiler/README.md)。当前类型是 D06 的已解析输入契约，不是 M2 的完整数据库或 Web API Schema。

`pnpm build` 生成浏览器兼容的核心 bundle 和 Node 发布适配器。Schema 校验代码由固定 Schema 预生成，运行时无需 `new Function`。尚未实现 Web 页面、HTTP 订阅端点或线上部署。

## 设计与证据

- [1.14.4 merge 源码审计](packages/config-compiler/docs/architecture/sing-box-merge-analysis.md)
- [D06 组合、ECS 与发布契约](packages/config-compiler/docs/architecture/config-composition-design.md)
- [D06 原始验收与 M2 待办](packages/config-compiler/docs/architecture/d06-validation.md)
- [monorepo 迁移记录](docs/architecture/monorepo-migration.md)

各层 `node_modules/`、`dist/` 和生成的 validator 均被 Git 忽略。依赖锁文件只维护根目录 `pnpm-lock.yaml`。
