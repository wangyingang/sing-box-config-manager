# 三模块 monorepo 迁移验收

验收日期：2026-11-02。环境：Node.js 24.22.1、pnpm 10.33.2、sing-box 1.14.4。

## 迁移结果

| 模块 | 工作区 | 状态 |
| --- | --- | --- |
| Rule Set Pipeline | `packages/rule-set-pipeline` | manifest 和 README 骨架，尚未迁移旧 Pipeline |
| Config Compiler | `packages/config-compiler` | 原 D06 源码、Schema、许可证、脚本、测试、fixtures 和三份架构文档完整迁入 |
| Configuration Manager Web App | `apps/web` | manifest 和 README 骨架，使用 `workspace:*` 依赖 Compiler，尚未选择前端框架 |

三个包均为 private。根目录只保留工作区管理、统一命令、通用 TypeScript 配置和仓库文档。协作配置与 `docs/agents` 保持原位。

Compiler 的公开入口改为 `@sing-box-config-manager/config-compiler` 和 `@sing-box-config-manager/config-compiler/publisher`。根包不再导出业务 API，不保留旧包名兼容层。函数、类型及编译和发布行为保持不变。Pipeline 与 Compiler 之间没有源码或运行时依赖。

## 内容与依赖一致性

迁移前保存 SHA-256 基线，迁移后按新路径逐一比对：

- 11 个源码及生成声明／忽略配置文件、13 个测试及 fixture 文件全部一致。
- 固定 Schema、构建元数据和许可证全部一致，摘要如下。Schema README 仅将生成命令改为 pnpm。
- `AGENTS.md` 和三个 `docs/agents` 文件摘要全部一致。
- 直接运行依赖和开发依赖版本全部保持；从原 npm lock 导入后，58 个 package/version 组合与原解析结果一致。此后移除 `package-lock.json`，只维护根 `pnpm-lock.yaml`。

以下路径均相对于 `packages/config-compiler/`：

| 文件 | 迁移前后相同的 SHA-256 |
| --- | --- |
| `schemas/sing-box-1.14.4.json` | `32f7598b8428276c5d358fd385942fa54dbe099055974120912b93626accbfd9` |
| `schemas/build.json` | `7d685a15ea31a8dab519b67c5ee0510926cd07fba646b3c48e16b34129ca7a1e` |
| `schemas/LICENSE.sing-box` | `650d5e3b99a446fb38e820fa87a49562e0c79eab868fff58618ac487a58e554c` |
| `test/fixtures/legacy/user-a-tun.json` | `e157cf6712adf9ce11d55b98b319465e888122387428a9ec26df2ae26715be10` |
| `test/fixtures/legacy/user-b-tun.json` | `f87d908a6195d04c9a463ff6b3ff36f5aa31473d11ff2631669a231d0c0c3353` |
| `test/fixtures/legacy/user-b-android-tun.json` | `8d481513f5dfa756a3fca0284768dac304b3a27dc54e033943888101986adb67` |
| `test/fixtures/legacy/user-c-tun.json` | `d881faee1a826e0b622f50e7a159eec4a79c9915361cca988b27d8e4e0906150` |
| `test/fixtures/legacy/user-d-tun.json` | `b911fee58be02eb137a46725e607452371ed791627ba4ca90a0c180726b64327` |

## 执行验证

另建隔离副本，复制时排除所有 `node_modules/`、`dist/` 和生成的 `src/generated/validate.cjs`。副本不位于旧依赖目录之下。以下检查全部通过：

| 检查 | 结果 |
| --- | --- |
| 根目录 `pnpm install --frozen-lockfile` | 全新安装成功；esbuild 安装构建脚本通过 `onlyBuiltDependencies` 显式允许 |
| 根目录 `pnpm check` | 类型检查、29 项常规／golden 测试、完整构建和工作区 smoke check 成功 |
| Compiler 目录 `pnpm check` | 模块独立命令成功；29 项测试通过，无跳过 |
| Compiler 目录设置 `SING_BOX_TEST_BINARY` 后执行 `pnpm test:integration` | 12 项原生集成测试通过，无跳过，使用真实 1.14.4 binary |
| 根目录直接运行 Compiler 的 `scripts/build.mjs` | 正确定位模块源码与输出目录 |
| 调用生成的 `dist/publisher.js` 中的 `createSingBoxChecker` | 使用真实 binary 对配置执行 check 成功 |
| 安装、构建后的锁文件比对 | 字节完全一致 |

本地工作区同时执行了根目录 `pnpm check` 和设置 binary 的 `pnpm test:integration`，均通过。原生测试覆盖五份旧配置的真实 merge/check、两种 ECS 输出以及发布失败保留旧版本。Android 不支持的进程规则仍被正式 compile／发布拒绝；迁移审计候选与旧配置的比较行为不变。

`scripts/smoke-workspace.mjs` 在 Web App 工作区内创建临时消费者，通过包名导入两个公开入口并执行 compile；使用生成的 TypeScript 声明检查消费者，包含一个必须报错的错误版本类型断言；再对核心入口进行浏览器目标打包。三个检查全部成功，临时消费者在结束后清理。工具由 Compiler 的开发依赖提供，不依赖根目录提升的 TypeScript 或 esbuild。

各层 `node_modules/`、`dist/` 与生成 validator 均被 Git 忽略。没有引入骨架模块的占位构建或空测试。

## 交付边界

本次为本地代码组织与工具链重构。未实施 Web 功能、旧 Pipeline 迁移、M2 领域建模、Git 提交、远端发布或部署。上述验证不等于设备运行验收。

D06 当时的 npm 命令和测试结果保留在 [原始验收记录](../../packages/config-compiler/docs/architecture/d06-validation.md)；当前入口与命令见 [根 README](../../README.md)。
