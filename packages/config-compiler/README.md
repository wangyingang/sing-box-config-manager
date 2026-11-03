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

### 固定修订 Recipe 入口

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
DNS／Route 策略支持预设与 Inline Rule，具体契约见下节。
固定规则产物绑定见下节。
底层 D06 API 保持原契约，仍可供可信宿主直接使用。

### Recipe Route 策略

Recipe `resources.outbounds` 按声明顺序支持固定 Node Binding，以及显式的
`direct`、`selector`、`urltest` 对象。Selector 的默认成员和组引用沿用 D06 校验。
`resources.ruleSets` 支持固定 curated binding，以及 `{ kind: 'inline', definition: { type: 'inline', tag, rules } }`；
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

### Recipe DNS 策略

Template 可提供 `dnsPresets` 和 `ecsResponseTags`。Recipe 的 `dnsSteps` 与
`routeSteps` 分别有序，均使用 `{ id, preset }` 或 `{ id, rule }`，ID 在各自列表中唯一。
DNS 同样支持预设原位展开、独立重复和稳定步骤诊断映射。
支持 route（可省略 action）、evaluate、respond、reject、predefined，以及递归
and／or、查询类型、响应码、具名响应、域名、地址、进程／应用和 Rule Set 匹配。
具名响应必须由此前的 evaluate 定义；重复定义、先引用后定义和逻辑条件内的
缺失响应均阻止编译。删除或移动预设不会修复响应依赖。

Template 和 Recipe 的 `resources.dnsServers` 支持 local／UDP／HTTPS；
HTTPS 保留样本使用的 TLS、Host headers、detour 和 domain_resolver。
local 支持 prefer_go、neighbor_domain。`resources.httpClients` 支持 tag、detour、
domain_resolver；resolver 可以是 tag 或 `{ server, strategy? }`。
这些对象均有封闭字段契约，引用沿用 D06 校验。平台 DHCP resolver 只能由
Template 的 `platformDnsServers` 提供；Android 选择 local，若配置 DHCP 或
不支持的进程／应用条件则明确拒绝。资源顺序为模板公共项、平台项、Recipe 项。

Recipe 和结构化 Template 均不接受 `client_subnet`，动态地址只来自
`params.ecs: { address, prefix } | null`，没有默认掩码。
Template 的 `ecsResponseTags` 只声明可注入的顶层 evaluate 响应。
不同参数只改变声明位置的 ECS 字段；null 清除旧网段并设置 remove_client_subnet。
删除声明所需的 evaluate 即使传 null 也仍报错，不自动关闭 ECS。

`test/dns-fixtures.ts` 将既有 first／ecs DNS 策略映射到新入口，使用显式合成的
Inline Rule Set 依赖；这不代表已迁移远程产物内容或完成五份样本的全量迁移。
原生集成覆盖桌面 DHCP／Android local 选择，以及发布和订阅的两种 ECS 输出。

### 草稿与编辑判定

`validateRecipeDraft(unknown)` 仅验证 Recipe 结构，返回 `Result<RecipeDocument>`。
成功值拥有独立数据副本；缺少必填字段、错误类型或未开放字段返回 `STRUCTURE_INVALID`。
缺失固定依赖、悬空出站引用等语义问题不属于结构错误。

`decideRecipeEdit(unknown)` 接受 `RecipeEditInput`，返回 `EditDecision<RecipeDocument>`：

```ts
const decision = decideRecipeEdit({
  previous: trustedPrevious, // 由宿主按候选 ID 加载；全新 ID 才能使用 null
  candidate: candidateRecipe,
  dependencies: fixedDependencies,
  params: { ecs: null },
  nodes: [{ id: 'shared', archived: true }], // 宿主提供当前归档状态
});
if (decision.allowed) {
  // decision.value 是独立的可保存草稿；diagnostics 仍可能含 error。
  // 宿主负责授权、持久化及并发一致性。
}
```

`reasons` 是阻止保存的结构或编辑约束，`diagnostics` 是调用正式编译获得的语义诊断。
`allowed: true` 不代表可以下载或发布；语义错误仍会使 `compileRecipe` 失败。
结构不完整时直接拒绝，无法执行后续语义诊断。编辑输入也拒绝额外 Profile 覆盖字段。

同一 Recipe ID 的 Profile 固定；修改内容必须使用新 revision，原样重试允许。
换 Profile 需要全新 ID，并重新校验。复制时可以提供源 Recipe 作为 `previous`，
但不同 ID 不继承已有绑定资格；宿主必须确认目标 ID 确实尚不存在。
同一身份的归档绑定按 `tag + nodeRef.id + nodeRef.revision` 保留，允许正常编辑、
重排或移除。新增、重复添加、改 tag、升级归档修订以及复制到新 Recipe 都是新增绑定，
返回 `NODE_ARCHIVED`。候选绑定缺少唯一宿主节点状态时返回 `NODE_STATE_INVALID`，
即使固定修订缺失也不能绕过归档检查。编译和发布不读取归档状态，已有固定绑定继续可用。

`decideNodeRevisionDeletion(unknown)` 接受 `NodeRevisionDeletionInput`：
`{ nodeRef: { id, revision }, references: { recipeRevisions, publications } }`。
两个引用标志均为显式 boolean，由宿主针对该固定修订查询；任何一个为 true 都拒绝删除。
成功值是独立的节点修订引用。本函数不扫描引用、不执行删除、不保证事务完整性。
这些纯判定不执行身份认证；宿主不能直接信任来自编辑请求的先前状态或引用标志。

### 稳定规则订阅（Recipe／Template v2）

[工单 #17](https://github.com/wangyingang/sing-box-config-manager/issues/17) 新增显式
`schemaVersion: 2`。Recipe 与所选 Template 必须同版；系统规则绑定只选择
`subscriptionRef: { systemRuleSetId, usage }` 或 `{ systemRuleSetId, usages }`，
保留本地 `tag` 与可选 `httpClient`。多个用途共用一个 tag 时，必须引用同一 SRS 入口。
不接受固定规则产物版本、任意 URL、摘要、格式或能力覆盖。

可信宿主在 `dependencies.subscriptions` 提供 Pipeline 拥有的
[Rule Subscription v1](../../rule-set-pipeline/contracts/rule-subscription.md)。
导出 `RuleSubscription`、`ruleSubscriptionSchema`；已解析 `CompileInput`
与编译输出使用独立 `subscriptions` 字段，稳定入口不转换成带伪造摘要的 `RuleArtifact`。
Compiler 仍为纯函数，默认生成 binary SRS 远程配置，保留用途、响应上下文、
资源引用和固定 Profile 检查。不会下载规则、调用 Pipeline 或统一注入更新周期／缓存。

`compileRecipe`、`resolveRecipe`、草稿／编辑入口、`prepareRecipePublication` 和
Node 端 `publishRecipe` 同时支持两版契约。发布继续执行两种 ECS 原生配置检查；
快照的 `compiled.subscriptions` 和 `recipeSource.subscriptions` 固定契约，
现有 `checks` 保存配置校验摘要。它们不承诺以后稳定入口的内容摘要。
未引用的契约不会进入发布身份；异步检查期间的外部修改不会改变快照。

旧 `schemaVersion: 1` 继续使用下述固定 Manifest 绑定，保留原验收含义；
v2 不接受该绑定。迁移需要新 Recipe／Template 修订、显式改绑和重新发布。
节点、模板和 Client Profile 的固定引用规则不变。
具体输入样本见 [subscription-fixtures.ts](test/subscription-fixtures.ts)，
验收与限制见 [#17 验证记录](docs/verification/issue-17.md)。

### 固定规则产物

`dependencies.manifests` 接受 Pipeline 维护的[Manifest v1](../../rule-set-pipeline/contracts/README.md)。
核心入口导出 `ArtifactManifest` 和 `artifactManifestSchema`；依赖可以省略，已有调用保持兼容。
Recipe 和 Template 的 `resources.ruleSets` 支持
`{ kind: 'curated', tag, artifactRef: { id, revision, usage }, httpClient? }`。
用途仅开放 `route`、`dns-query`、`dns-response`，在每个实际消费位置检查，
包括预设及逻辑子规则。用户不能提交 URL、路径、摘要或能力声明。

解析检查精确修订、用途可用性、非空投影、已知格式／能力及 Recipe 固定 Profile，
显式转换为 D06 的 `RuleArtifact` 和绑定。多个本地 tag／用途可以共享一份物理产物。
DNS 响应用途要求当前匹配对象引用此前已 evaluate 的响应；
具名和无 tag 响应分别验证，不能将目标 IP 投影改作 source IP。
消费位置错误携带稳定 step、预设及最终输出位置诊断。

此入口是纯内存适配器，不读取 Pipeline 或远程文件。
Manifest 地址、摘要和能力声明的真实性由可信接入方验证，
合成样本和真实 binary check 均不能替代远程内容验收。

### 五份样本迁移与 Recipe 发布

`test/fixtures/migrated/` 保存五份可独立加载的静态 `RecipeCompileInput`；
同名 `.mapping.json` 逐项记录原 fragment、固定节点和产物绑定。
每个脱敏节点按样本与本地 tag 显式分配 ID，不根据相同连接内容推断共享身份。
共享节点行为另由合成测试验证。旧 golden 与受限 normalization 保持原样，
数组顺序不排序、不去重；user-d 继续使用独立模板和策略。

本次补齐 Template 的 `experimental.cache_file.enabled/store_dns`、
`route.default_http_client`、`resources.services` 的 API service 与 dashboard，
以及 HTTP client 的 `version`。各层均为封闭字段，Recipe 不获得通用 JSON 或 service 覆盖入口。
同一规则集本地 tag 若需用于多个消费位置，可显式使用
`artifactRef: { id, revision, usages: ['route', 'dns-query'] }`；
`usage` 单用途写法继续有效，两者不能混用。`usages` 必须非空、无重复，
每个声明仍须属于固定 Manifest 的用途投影，每个消费位置分别检查。

```ts
import { compileRecipe, inspectRecipeComposition, prepareRecipePublication,
  renderSubscription } from '@sing-box-config-manager/config-compiler';
import { publishRecipe } from '@sing-box-config-manager/config-compiler/publisher';

// fixedInput 是可信宿主加载的固定 Recipe、Template、NodeRevision 和 Manifest。
const compiled = compileRecipe(fixedInput);
const prepared = await prepareRecipePublication(fixedInput, trustedNativeChecker);
const published = await publishRecipe(fixedInput, {
  binary: '/absolute/path/to/sing-box', directory: '/private/publications/example',
});
if (published.ok) {
  const subscription = await renderSubscription(published.value, { ecs: null });
}
```

`prepareRecipePublication` 先执行严格 Recipe 编译，再复用 `preparePublication`；
`publishRecipe` 复用既有本地发布适配器。启用与关闭 ECS 两种输出都必须通过真实 check。
声明 ECS 的模板发布时仍要求显式探针地址／前缀，不能传 null 绕过探针；
编译与订阅可传 `ecs: null`。不设默认掩码，不把 ECS 地址写入 Recipe。

发布保留原 D06 `inputHash`，新增可选 `body.recipeSource`：
其 `inputHash` 包含完整 Recipe（含步骤 ID）、选中的固定模板、节点、Manifest 和生成参数；
同时保存 Recipe、模板、节点修订及产物摘要记录，供宿主审计与修订保留。
这些记录参与最终发布 ID。未引用的节点最新版或模板候选不改变发布；
检查期间的调用方修改不影响快照。D06 调用及旧发布格式继续可用。
记录中的摘要提供完整性绑定，不提供授权或远程内容证明。

`inspectRecipeComposition` 仅供审计／预览：保持结构、依赖和用途检查，
将 Profile 能力问题延后到现有 `inspectComposition`，返回带诊断候选。
旧 Android 样本可沿新入口完整对照，但 `compileRecipe`、
`prepareRecipePublication` 和 `publishRecipe` 均继续拒绝其进程规则。
独立合法 Android 测试使用 local resolver 与合成 package 策略，并检查两种 ECS 输出。
不能通过删除旧样本条件把它标记为已迁移可交付配置。

验收覆盖完整策略下语义错误草稿可保存但不可发布、归档旧绑定可重新发布、
本地发布失败保留旧指针、发布快照隔离，以及公开类型和浏览器 bundle。
迁移元数据沿用旧 manifest 的 URL、摘要与能力；新增 `byteLength`、`termCount`
明确使用合成占位值 `1`。真实 check 不下载这些规则文件，未验证远端字节与统计。
真实设备运行、代理连通性、在线订阅／激活事务、数据库、Web 页面及实际 Pipeline
采集、转换、产物生产和发布均未实现或验收。

本次迁移验收结果（2026-11-03）：

| 样本 | 新契约与旧 golden 对照 | 真实 1.14.4 两种 ECS check | 正式发布 |
| --- | --- | --- | --- |
| user-a-tun | 通过 | 通过 | 通过 |
| user-b-tun | 通过 | 通过 | 通过 |
| user-b-android-tun | 审计候选通过 | 审计候选通过 | 按 Profile 拒绝进程规则 |
| user-c-tun | 通过 | 通过 | 通过 |
| user-d-tun | 独立策略通过 | 通过 | 通过 |

`pnpm check`：81 项常规测试通过，类型检查、构建、公开声明及浏览器 smoke 通过。
显式指定真实 binary 的 `pnpm test:integration`：26 项通过，0 跳过，
包含既有回归及独立合法 Android 场景。binary 报告 1.14.4，
Revision `c005f35300ce76427dc285481ec5695f5b179cd2`，darwin/arm64；
checker 同时核对固定 Schema 摘要。上述“正式发布”是临时目录内的本地适配器验收，
不表示线上发布或设备运行验收。
