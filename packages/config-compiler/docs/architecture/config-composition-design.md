# D06 配置组合设计

状态：已接受并实现最小验证版本，2026-11-02。目标版本固定为 sing-box 1.14.4。完整领域 Schema、存储、账号、在线校验服务部署、规则 Pipeline 和 Web UI 不在本次实现中。

monorepo 迁移说明：本文中的 `src/`、`test/`、`schemas/` 等路径以 `packages/config-compiler/` 为基准；公开包名为 `@sing-box-config-manager/config-compiler`。组合契约与行为没有因目录迁移而变化。

## 输入、对象归属与规则顺序

`CompileInput` 由可信应用层解析：Template、Recipe、系统 RuleArtifact 元数据、Profile ID、GenerationParams。核心仅处理内存数据；不读取文件或网络、不执行 binary。TypeScript 类型位于 `src/types.ts`，这是 D06 已解析输入契约，不能直接当成开放 HTTP 请求 Schema。

| 输入 | 组合规则 |
| --- | --- |
| `template.defaults` | 基础 log、DNS/Route 选项、experimental、NTP、certificate。DNS/Route 的集合与规则禁止放入 defaults。 |
| `recipe.settings` | 首期仅开放 logLevel、唯一 TUN 的 tunMtu、dnsFinal、routeFinal。显式值覆盖模板默认值；未知设置报错，null 不表示删除。 |
| `resources` | 模板对象在前，Recipe 对象在后。管理 inbounds、outbounds、dnsServers、httpClients、services 和 ruleSets。同命名空间重复 tag 报错，不按 tag 合并。 |
| `platformDnsServers` | 先选择 Profile 对应列表，再生成 DNS servers；顺序为模板公共项、平台项、Recipe 项。缺少被引用的平台 resolver 会报缺失引用。 |
| `dnsSteps` / `routeSteps` | 两个独立有序列表，每一步为 `{preset}` 或 `{rule}`。预设在原位展开，内部顺序不变；不排序、不去重、无隐式跨列表映射。 |
| `ruleSets` | Inline 定义或引用系统 artifact ID 的 curated binding。Recipe 不能直接提供 remote/local Rule Set 或任意 URL。 |

Template 是系统维护对象，Recipe 是业务编辑入口产生的配置。增加用户可编辑设置时，需要增加有名字段及检查；不通过任意属性路径 patch 扩大能力。

删除由上游编辑已解析集合或步骤列表表达，不能用 null 删底层字段。被引用的对象删除后会触发错误。证书或密钥文件路径属于外部依赖，核心拒绝这些路径；受控导入如何转换为 inline 内容留给后续功能。

### 旧配置迁移示例

迁移只发生在测试映射 `test/fixtures.ts`，生产 Compiler 不认识片段文件名：

- 基础 DNS → `dnsPresets[base]`；用户 DNS → 显式 rule steps；共享 DNS 主体 → 下一条 preset step。
- Route 按基础规则、模式策略、TUN resolve、用户规则、业务主体、后置规则的原顺序构造 steps。
- `1.dns-lan*.json` → 平台 resolver 选择；zhongni 原独立策略 → 独立 Template/Recipe。
- 为保持旧根对象数组顺序，共享业务主体中的 Selector/Rule Set 与用户对象一起成为 Recipe 中的已解析集合；基础对象留在 Template 中。未增加通用数组插入补丁。
- Remote Rule Set → 系统 artifact binding，保留显式 tag 与 HTTP client；inline 集合保留原匹配条件。

## 编译与诊断接口

`compile(input)` 返回 `Result<CompiledConfig>`：成功包含配置、所选 artifact、ECS 声明和版本信息；失败只含诊断。诊断固定包含 severity、code、path、message，不回显凭据或 native stderr。

`inspectComposition(input)` 供预览和迁移审计使用。它可以返回带错误的 candidate；存在 candidate 不表示配置可交付。正式下载使用 compile 成功结果，远程订阅使用发布快照。`preparePublication` 内部只调用正式 compile。

检查顺序：输入边界 → 显式组合 → ECS → 固定 JSON Schema → 引用和 Profile 能力。错误阻止正式编译；明显不可达规则使用 warning。诊断位置指向输入或最终配置的位置；M2 再补齐精确的 UI 字段映射。

引用检查覆盖组成员/默认值、默认出站、detour、HTTP client、DNS server、resolver、inbound 和 Rule Set；出站组成员与 detour 构成依赖图，拒绝环。DNS 具名响应必须由此前 evaluate 定义，包括逻辑条件内的引用；这是定义顺序检查，不证明每个请求一定走过该 evaluate 分支。

只对没有匹配条件的明确终结动作报告后续规则不可达。`respond` 依赖响应存在性，不因表面没有域名条件就被认定为无条件终结。

### Client Profile

能力表版本为 `d06-1`，这是小范围能力检查，不是全平台兼容性认证。

| Profile | process_name/path/path_regex | package_name/package_name_regex | DHCP DNS |
| --- | --- | --- | --- |
| windows-standalone | 允许 | 拒绝 | 允许 |
| macos-standalone | 允许 | 拒绝 | 允许 |
| macos-appstore | 拒绝 | 拒绝 | 允许 |
| ios-appstore | 拒绝 | 拒绝 | 允许 |
| android-google-play | 拒绝 | 允许 | 拒绝，模板选 local |

进程及应用匹配依据固定版本的 [Apple features](https://github.com/SagerNet/sing-box/blob/v1.14.4/docs/clients/apple/features.md) 和 [Android features](https://github.com/SagerNet/sing-box/blob/v1.14.4/docs/clients/android/features.md)。Android DHCP 边界沿用现有 SFA 配置约束；其他平台允许该选项不代表已在设备验证。能力检查递归覆盖内联规则；remote 集合依赖 Pipeline 提供的 requiredCapabilities，不能只检查下载 URL。

旧 Android 样本包含桌面进程规则，所以能够通过原生 check，却不能正式发布到 Android Profile。当前实现如实报错，不删除条件、不把空逻辑规则变成全匹配；如何按实际应用改写由后续平台迁移决定。

## ECS、校验与发布

模板通过 `ecsResponseTags` 声明唯一顶层 evaluate 响应的位置；不接受客户端提供 JSON 路径。其他位置出现 `client_subnet` 时拒绝，避免遗漏旧网段。

`params.ecs` 只有两种形式：

- `{address, prefix}`：严格公网单播 IPv4、显式 0–32 前缀；计算 network CIDR，设置 client_subnet，去掉 remove_client_subnet。
- `null`：移除声明位置的 client_subnet，并设置 remove_client_subnet=true，避免沿用查询携带的 ECS。

不设置默认掩码。样本的 `/24` 仅是回归参数，不是产品默认值。核心不推断访问者 IP；未来可信 Worker 入口处理 CF-Connecting-IP，将不可靠地址转换为 null，不使用生成服务器 IP。可信入口仍无法自动证明请求未经过代理。

规则与顺序在两种 ECS 情况下都保持不变。无 ECS 的 evaluate 可能再次查询同一上游；这是本版为保持既有步骤和订阅修改边界作出的选择，没有擅自删除 ecs 分支。

发布流程：

1. 深拷贝所有输入，固定 Recipe、Template、Compiler、能力表、Schema 和所选规则元数据。SHA-256 同时覆盖完整输入，不能仅靠未变化的 revision 字符串复用检查。
2. 编译显式 ECS 样本及 ecs=null 两种配置。模板声明了 ECS 时，发布调用方必须提供带掩码的校验样本；它不必是订阅者 IP。
3. 可信执行器分别运行真实 check。Node 适配器核对版本和 `schema` 摘要，使用权限受限的临时文件、隔离 cwd、30 秒超时，最终清理目录。不启动服务。
4. 两次检查成功后生成不可变快照及摘要。快照持久化不启用 ECS 的完整配置，防止误用校验样本网段。
5. 本地适配器先以 0600 写入 `releases/<digest>.json`，再通过同目录临时指针 rename 切换 `current.json`。失败不切换；旧版本保留，可重新选择以回滚。这里提供单机原子可见性，不承诺断电持久性或多节点事务。

`renderSubscription` 从可信存储加载快照，核对摘要和当前 Compiler/Schema/能力版本，只注入 ECS 后做静态校验。它不读取 Recipe 最新草稿，也不重新生成其他字段。升级相关版本后需要重新发布；旧校验不能自动转用于新 Compiler。

摘要用于完整性，不是签名或授权机制。`preparePublication` 的 checker 回调及 `commitPublication` 只能由可信发布路径调用，不能开放为接受浏览器上传“已校验快照”的 API。RuleArtifact 的 URL、revision、hash 和能力元数据必须来自系统 Pipeline；D06 不下载或验证远程文件内容。

原生 Schema 使用 `schemas/sing-box-1.14.4.json` 与 `schemas/build.json`；Ajv 在构建时生成 standalone validator，核心不使用运行时代码生成。Schema 来自上游，出处及许可证随文件保存。

Web App、HTTP 缓存头、订阅令牌和在线校验执行器尚未部署。后续 HTTP 响应需要保持 `private, no-store`，不能将本地快照存储误当成公共配置 CDN。
