# sing-box-config-manager

本项目帮助管理者维护 sing-box 配置，并让配置引用的系统规则持续更新。

例如，管理者为家人的电脑和手机分别准备配置。两份配置可以复用同一个代理节点，但平台限制、DNS 策略和路由策略各自保存。节点连接信息更新后，由管理者明确选择哪些配置升级；系统规则更新则经过验证和激活，通过稳定地址交给客户端获取。

## 模块如何协作

仓库采用三模块 pnpm monorepo：

| 模块 | 接收什么、完成什么 | 当前边界 |
| --- | --- | --- |
| [Rule Set Pipeline](packages/rule-set-pipeline/README.md) | 从官方规则来源构建 JSON／SRS，发布候选，经显式激活后更新稳定规则入口 | 已实现 V2Fly 官方 Release 的配置驱动多集构建、候选发布、单集激活／回滚及同进程客户端更新验证 |
| [Config Compiler](packages/config-compiler/README.md) | 将模板、配置选择、节点修订、规则元数据和客户端能力组合成完整配置，并检查错误 | 已实现纯内存编译、发布快照及 Node 本地发布适配器 |
| [Configuration Manager Web App](apps/web/README.md) | 计划负责编辑、存储、管理授权、配置交付和订阅服务 | 当前只有工作区骨架及 Compiler 依赖，没有页面、HTTP API 或数据库 |

管理者保存的一份配置选择称为 **Recipe**。它记录使用哪个模板和节点修订，以及 DNS、Route 策略的顺序。模板提供公共设置和可复用策略；节点修订保存某个代理服务在一个固定版本中的连接信息。

调用 Compiler 的应用或脚本称为**宿主**。宿主负责取得可信依赖、检查管理权限和保存数据。Compiler 只处理传入的内存对象，不查询数据库、不下载规则，也不自行执行 Pipeline。真实 `sing-box check` 由宿主提供的执行器完成；仓库已有 Node 本地执行器。

Pipeline 通过规则文件和元数据对接 Compiler，两者没有源码或运行时依赖。Web App 通过 Compiler 的公开包入口调用功能。各模块分别声明依赖；根目录管理工作区和统一命令。

## 配置发布与规则更新

项目中有两种不同的发布与更新：

- **配置发布**：固定 Recipe、模板、节点和校验结果，生成可交付的配置快照。继续编辑草稿不会改变已经发布的快照。
- **规则发布与激活**：先上传经过验证的规则候选，再由管理者选择候选更新稳定规则入口。使用该入口的客户端随后按自身更新机制加载规则。

当前 Recipe／Template v2 使用第二种机制跟随规则变化。因此，**配置快照固定，不代表客户端以后加载的规则内容固定**。模板和节点仍采用固定修订，不因规则自动更新而自动升级。该区别由 [ADR 0006](docs/adr/0006-follow-active-rule-subscriptions.md) 明确规定；旧 v1 固定产物路径保留兼容。

## 第一次阅读

1. 阅读 [Compiler 的配置生成与发布流程](packages/config-compiler/README.md#从配置选择到完整配置)，理解一份配置如何产生。
2. 阅读 [Pipeline 的操作与结果](packages/rule-set-pipeline/README.md#操作分别产生什么结果)，理解规则如何发布、激活和更新。
3. 需要接入接口时，再查模块 README 中的字段、示例和契约链接。
4. 需要理解设计原因时查 [ADR](docs/adr/)；判断某项能力完成到什么程度时，查对应验收记录。

文档中的 **D06** 指配置组合机制的历史设计工作，已确定采用 TypeScript Composer；**M2** 是后续数据契约设计阶段的名称。它们不是运行模式或当前待办状态。

Recipe 编译契约和首个规则生产流程分别已有 [Spec #1 完成记录](https://github.com/wangyingang/sing-box-config-manager/issues/1#issuecomment-6583710546)与 [Spec #14 完成记录](https://github.com/wangyingang/sing-box-config-manager/issues/14#issuecomment-6613968065)。这些记录说明当次交付和验收范围，不代表管理平台已经上线，也不能用来判断实际设备当前加载了哪个版本。

## 开发检查分别证明什么

需要 Node.js ≥24 和 **pnpm 10.33.2**。pnpm 版本固定在根 `package.json` 的 `packageManager` 字段，可由 Corepack 按该字段选择。常规测试不需要本机 sing-box。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm check
```

本地完整验证使用 `node scripts/verify.mjs --out <新证据目录> --binary <1.14.4绝对路径>`。入口按根 `package.json` 核对 pnpm 版本，并让嵌套脚本使用同一启动器；版本不符时在执行检查前失败。可用 `--pnpm <启动器绝对路径>` 指定已安装的匹配版本。`--check-only` 只运行常规检查；`--release` 另运行固定官方 Release 的下载与重复构建验收，不执行远程写入。

每次运行保留工具身份、Git 状态、命令、退出码、测试统计、日志及文件摘要。证据目录必须不存在，已有证据不覆盖；用于阶段收尾的证据应在清理 worktree 前归档。Spec #14 的最终验收证据见 [docs/verification/spec-14-final/](docs/verification/spec-14-final/)。历史测试数量只属于记录中的提交和日期，不能表述为当前提交已经重新执行通过。

| 命令 | 作用 |
| --- | --- |
| `pnpm test:tools` | 执行根目录工具脚本测试 |
| `pnpm typecheck` | 执行已实现模块的类型检查 |
| `pnpm test` | 执行常规测试和 golden 回归 |
| `pnpm build` | 生成模块构建产物和 TypeScript 声明 |
| `pnpm smoke:workspace` | 构建后，从 Web App 工作区验证包引用、类型和浏览器打包 |
| `pnpm check` | 顺序执行 test:tools、typecheck、test、build、smoke:workspace |
| `pnpm test:integration` | 原生 sing-box 集成测试，必须显式指定 binary |

原生集成测试要求 **1.14.4**，其 Schema 摘要必须与 Compiler 保存的构建信息一致。缺少 binary 时失败，不静默跳过。

```sh
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box pnpm test:integration
```

[CI](.github/workflows/ci.yml) 在 PR、推送到 `main` 和手动触发时启动。它先检查变更范围：

- 完整差异非空，且所有变更路径都以 `.md` 结尾时，跳过两个完整检查 job。
- 手动触发、包含其他文件、差异为空或变更判断失败时，执行完整检查。

完整检查分别运行工作区 `pnpm check` 和真实 sing-box 集成测试。原生 job 下载配置指定的官方 linux-amd64 发布包，核对归档 SHA-256 后执行 `pnpm test:integration`，测试继续核对 Schema 摘要。两个 job 使用锁文件安装依赖，检查日志作为含提交 SHA 的 artifact 保留 14 天（失败时也尝试上传）。

因此，“CI workflow 已运行”不一定表示本次运行了原生测试。判断结果时，应查看具体 job 是否执行。是否强制阻止合并由 GitHub 分支保护另行配置。

CI 的 sing-box 版本读取自 [Schema 构建配置](packages/config-compiler/schemas/build.json) 的 `version`，Linux 发布包摘要读取自 `releaseAssets.linux-amd64.sha256`。下载地址和解压路径自动生成。升级时更新该配置，并同步核验 Schema、原生校验器和测试基线，无需修改 workflow。

测试在临时目录执行 Compiler 检查和 Pipeline 原生验证。自动更新、回滚及故障恢复测试会启动隔离的 sing-box 实例和本地服务，结束后清理；不修改生产规则入口、系统代理或旧配置仓库。

五份旧配置候选保持生成语义并通过原生 check；旧 Android 配置含不支持的进程规则，正式 compile 和发布会拒绝它。

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

- [#22 固定 Release 重建验收](packages/rule-set-pipeline/docs/verification/issue-22.md)
- [#21 客户端故障与缓存恢复验收](packages/rule-set-pipeline/docs/verification/issue-21.md)
- [#20 历史规则回滚验收](packages/rule-set-pipeline/docs/verification/issue-20.md)
- [#19 显式激活与客户端自动更新验收](packages/rule-set-pipeline/docs/verification/issue-19.md)
- [#18 不可变候选发布与远程回读验收](packages/rule-set-pipeline/docs/verification/issue-18.md)
- [#16 JSON／SRS 原生构建验收](packages/rule-set-pipeline/docs/verification/issue-16.md)
- [1.14.4 merge 源码审计](packages/config-compiler/docs/architecture/sing-box-merge-analysis.md)
- [D06 组合、ECS 与发布契约](packages/config-compiler/docs/architecture/config-composition-design.md)
- [2026-11-02 D06 原始验收与当时待办](packages/config-compiler/docs/architecture/d06-validation.md)
- [monorepo 迁移记录](docs/architecture/monorepo-migration.md)
- [M2 契约设计与实施计划（历史背景及后续事项）](docs/architecture/m2-contract-plan.md)
- [领域术语索引](GLOSSARY-MAP.md)
- [初始交接文档](docs/history/2026-11-02-configuration-management-handoff.md)（历史参考，部分决策已被后续 ADR 和 spec 替代）

各层 `node_modules/`、`dist/` 和生成的 validator 均被 Git 忽略。依赖锁文件只维护根目录 `pnpm-lock.yaml`。
