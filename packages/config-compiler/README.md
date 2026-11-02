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

### 固定修订 Recipe 入口（首个切片）

核心包导出 `RecipeDocument`、`TemplateDocument`、`NodeRevision` 和
`RecipeCompileInput`。`resolveRecipe(input)` 返回 `Result<CompileInput>`；
`compileRecipe(input)` 继续调用现有 Compiler，返回 `Result<CompiledConfig>`。
两者接受未知输入并先严格校验结构，Profile 只能来自 Recipe：

```ts
import { compileRecipe, type RecipeCompileInput } from '@sing-box-config-manager/config-compiler';

const input: RecipeCompileInput = {
  recipe: {
    schemaVersion: 1, id: 'alice', revision: '1', profile: 'macos-standalone',
    templateRef: { id: 'base', revision: '1' },
    resources: { outbounds: [{ kind: 'node', tag: 'proxy', nodeRef: { id: 'shared', revision: '1' } }] },
    dnsSteps: [], routeSteps: [],
  },
  dependencies: {
    templates: [{ schemaVersion: 1, id: 'base', revision: '1', targetVersion: '1.14.4',
      defaults: {}, resources: {}, platformDnsServers: {} }],
    nodes: [{ schemaVersion: 1, id: 'shared', revision: '1', connection: {
      type: 'shadowsocks', server: '192.0.2.1', server_port: 443,
      method: 'aes-256-gcm', password: 'synthetic-example',
    } }],
  },
  params: { ecs: null },
};
const result = compileRecipe(input);
```

依赖按 `id` 和 `revision` 精确匹配，缺失或重复返回结构化诊断，不选择最新版。
解析结果独立拥有资源，宿主负责修订不可变性、持久化和授权。
`recipeSchema`、`templateSchema`、`nodeRevisionSchema` 提供 `parse(value, path)`
结构检查入口，失败抛出带 `path` 的错误；公开类型从同一结构定义推导。

本切片支持节点绑定、Direct／Selector／URLTest 出站、mixed／TUN 入站、local／UDP／HTTPS resolver、
日志／DNS／Route 的有限默认值及四个既有 Recipe settings。
节点连接支持 VLESS（含 REALITY、uTLS、WebSocket）、Hysteria2（含内嵌证书）和
Shadowsocks。所有对象拒绝未声明字段，不接受文件路径、任意 options 或 JSON patch。
Route 策略支持预设与 Inline Rule，具体契约见下节。DNS steps 当前只接受空数组；
固定规则产物及节点生命周期约束由后续切片实现。
底层 D06 API 保持原契约，仍可供可信宿主直接使用。

### Recipe Route 策略

Recipe `resources.outbounds` 按声明顺序支持固定 Node Binding，以及显式的
`direct`、`selector`、`urltest` 对象。Selector 的默认成员和组引用沿用 D06 校验。
`resources.ruleSets` 只允许 `{ kind: 'inline', definition: { type: 'inline', tag, rules } }`；
其中 Headless Rule 只描述匹配条件，不允许动作或出站引用。

Template 可提供固定 `routePresets: Record<string, RouteRule[]>`。Recipe 的
`routeSteps` 是有序的 `{ id, preset }` 或 `{ id, rule }`，两者互斥，ID 必须唯一。
引用可自由添加、移除、移动和重复；内部规则随 Template revision 固定。
支持 route（含省略 action 的出站规则）、resolve、sniff、hijack-dns、reject，
以及递归 and／or 匹配。数组顺序不排序或去重，也不恢复已移除的预设。

`compileRecipe` 的 Route 语义诊断将 `path` 指向 Recipe step，附加 `source`
中的 `stepId`、`stepIndex`、`outputRuleIndex`、`outputPath`；预设规则还包含
`preset` 和 `presetRuleIndex`。D06 `compile` 的输出路径保持原样。
四项 settings 均为明确字段：logLevel、tunMtu、dnsFinal、routeFinal。
dnsFinal 是 DNS server tag；tunMtu 要求 Template 中有且仅有一个 TUN 入站。
DNS steps 的完整契约仍属于后续切片。
