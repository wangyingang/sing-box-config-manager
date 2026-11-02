# Config Compiler

包名：`@sing-box-config-manager/config-compiler`。这是 D06 的最小 sing-box 1.14.4 配置组合、校验和发布实现。

## 公开入口

```ts
import { compile, inspectComposition, preparePublication, renderSubscription } from '@sing-box-config-manager/config-compiler';
import { createSingBoxChecker, publish } from '@sing-box-config-manager/config-compiler/publisher';
```

核心入口 `.` 对应浏览器兼容的 `dist/index.js`，不读取数据库、文件、网络或调用 binary。`/publisher` 对应 `dist/publisher.js`，仅供 Node 环境使用，不能放入浏览器或普通 Worker bundle。

两个入口同时导出 TypeScript 声明。包只在工作区使用，未发布到 npm；其他模块通过 `workspace:*` 声明依赖，不直接引用这里的源码路径。

| API | 行为 |
| --- | --- |
| `compile(input)` | 返回符合 Schema、引用及 Profile 约束的配置，或结构化错误 |
| `inspectComposition(input)` | 预览及迁移审计；候选可能含错误，不能直接交付 |
| `preparePublication(input, check)` | 校验启用／关闭 ECS 两种配置并固定快照；checker 由可信宿主提供 |
| `renderSubscription(publication, params)` | 从可信发布快照生成配置，只调整声明的 ECS 参数 |
| `createSingBoxChecker(binary)` | Node 适配器，使用指定 1.14.4 binary 做真实 check |
| `publish(input, options)` | 本地校验及原子发布，失败保留旧版本 |

输入类型见 `src/types.ts`，真实脱敏输入映射见 `test/fixtures.ts`。这些是已解析输入契约，不是 M2 的完整领域或 HTTP Schema。Compiler 只消费系统提供的规则元数据，不依赖 Rule Set Pipeline 包。

## 本模块命令

先在仓库根目录完成 `pnpm install --frozen-lockfile`。进入本目录后：

```sh
pnpm check
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box pnpm test:integration
```

也可从仓库根使用 `pnpm --filter @sing-box-config-manager/config-compiler <命令>`。本模块的 check 包含类型检查、常规测试和构建；跨包 smoke check 由根 `pnpm check` 执行。

Schema 校验代码从固定 Schema 在构建或测试前生成，运行时不使用 `new Function`。构建脚本以模块路径定位文件，也可以从根目录直接调用：

```sh
node packages/config-compiler/scripts/build-validator.mjs
node packages/config-compiler/scripts/build.mjs
```

第二条只生成 bundle；完整构建和类型声明使用 `pnpm build`。

刷新脱敏 fixtures 需要显式指定两个旧仓库及 binary。在本模块目录执行：

```sh
python3 scripts/import-legacy-fixtures.py \
  --config-repo /absolute/path/to/sing-box-config \
  --rule-repo /absolute/path/to/sing-box-geosite \
  --sing-box /absolute/path/to/sing-box
```

这是有意更新样本的操作；日常测试不读取旧仓库。

## 兼容性与证据

五份旧配置候选保持生成语义并通过原生 check。旧 Android 样本仍含不支持的进程规则，正式 compile/发布会拒绝它；不为通过测试而静默删除规则。设备运行和线上订阅尚未验收。

- [1.14.4 merge 源码审计](docs/architecture/sing-box-merge-analysis.md)
- [D06 组合、ECS 与发布契约](docs/architecture/config-composition-design.md)
- [原始验收与 M2 输入](docs/architecture/d06-validation.md)
- [固定 Schema 来源与许可证](schemas/README.md)
