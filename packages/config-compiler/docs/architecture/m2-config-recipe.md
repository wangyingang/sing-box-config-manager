# M2 Config Recipe 契约草案

日期：2026-11-02。状态：字段与映射设计，尚未生成或冻结 JSON Schema。上层计划见 [M2 契约与实施计划](../../../../docs/architecture/m2-contract-plan.md)。

## 三种数据表示

1. **保存的 Recipe Revision**：有版本的编辑数据及固定依赖引用。凭据属于受保护内容，不能写入日志、公共规则产物或诊断。
2. **Resolved Compile Input**：可信宿主已取得并验证依赖；纯适配器接收这些内存对象，生成当前 `CompileInput`。
3. **Publication**：两种 ECS 情况真实 check 后的不可变快照。订阅不重新读取草稿，不重新解析最新模板或规则。

新持久模型不能直接复用当前 `Recipe` 的宽泛 `Obj` 作为开放请求体。原 `compile`、`inspectComposition`、`preparePublication`、`renderSubscription` 接口在 M2 初期保持不变；新增 Schema 与纯适配器位于 Compiler 包，不新增共享业务包。

## 建议的保存结构

下面只展示结构，花括号中的说明不是可提交 JSON。最终字段由 M2-01 Schema 定义，未知字段默认拒绝。

```text
RecipeRevision
  schemaVersion: "recipe-1"
  id: 稳定 Recipe ID
  revision: 不可变修订 ID
  profile: 本 Recipe 固定的 Client Profile ID
  templateRef: { id, revision }
  settings: { logLevel?, tunMtu?, dnsFinal?, routeFinal? }
  resources:
    outbounds: 有序的 NodeBinding / Direct / Selector / URLTest 定义
    dnsServers: 有序的受支持 DNS server 定义
    httpClients: 有序的受支持 HTTP client 定义
    ruleSets: 有序的 Inline / Curated 绑定
  dnsSteps: 有序 DNS step 列表
  routeSteps: 有序 Route step 列表
```

`schemaVersion` 管理数据形状；`revision` 管理内容变更。配置使用者、显示名称、创建／修改时间属于管理层记录，不混入生成配置。每份 Recipe 固定现有五种 Profile ID 之一；交付目标不能覆盖 Profile，也不接收上传的能力布尔值。更换 Profile 创建另一份 Recipe，共用模板与节点引用，不引入平台策略覆盖。ECS 地址不存入 Recipe，避免保存访问时的过期公网 IP。

用户已确认采用共享节点库，见 [ADR](../../../../docs/adr/0001-shared-node-revisions.md)。`Node` 管理稳定身份和显示名称，由管理者统一维护；`NodeRevision` 保存 `{schemaVersion, nodeId, revision, connection}`，connection 是按协议区分的连接数据，包含地址、凭据及支持的 TLS／transport 设置。Recipe 的节点绑定保存 `{kind: "node", tag, nodeRef: {nodeId, revision}}`，不复制连接字段。

节点库允许不同配置使用者的 Recipe 共享，由管理者分配引用；不以配置使用者身份作为节点库分区。复制 Recipe 保留固定节点引用；编辑节点产生新 NodeRevision，已有 Recipe 继续引用旧版本。管理者显式升级引用后产生新 Recipe Revision，并重新校验、发布。Q4 已确认：归档禁止新增引用，已有绑定继续可用于生成和发布，被引用修订不可删除。新建或复制 Recipe 时增加的引用也须遵守归档约束；不能借复制创建归档节点的新绑定。凭据在服务端的保护方式留给 Web 存储设计，核心仅接收已解析内存值，不引入密钥库客户端。

节点修订不包含 Recipe 本地 tag、Selector 成员或 DNS／出站的本地引用。同一修订在不同 Recipe 可使用不同 tag。现有五份样本的代理节点未使用 detour／domain_resolver 这类本地引用，因此本次首个切片的 NodeBinding 仅包含 kind、tag 和固定 nodeRef，不新增上下文覆盖选项。后续若有真实需求，应增加具名字段与引用检查，不能在共享连接中嵌入某个 Recipe 的 tag，也不提供任意 options 覆盖。

## 身份、引用与顺序

- 模板、Recipe、规则集有稳定身份和不可变修订；不使用显示名或可变 branch 名作为版本。
- 配置内部继续使用带命名空间的 tag 引用，保留 D06 的引用与冲突检查。显示名称与 tag 分离；首版 tag 创建后保持稳定，重命名需要专门的引用迁移，不能只改一个字符串。
- DNS 与 Route step 各有稳定 `id`，用于编辑与诊断定位；顺序只由数组位置决定。`{id, kind: "preset", presetId}` 或 `{id, kind: "inline", rule}` 二选一，不另设 priority 或自动排序。
- 同一 preset 可以在不同 step 使用，每次独立展开。最终诊断需能定位到 step ID、preset 内部下标和输出规则下标。
- Q3 已确认：Recipe 可整体添加、移除、重排预设引用，并通过明确入口编辑 Inline Rule；没有固定编辑区或必选／锁定预设。预设内部变化必须形成新模板修订，不能通过 Recipe 任意 patch。
- 对象列表与规则列表都保留输入顺序。模板资源仍在 Recipe 资源前；平台 resolver 在生成前选择。
- Inline Rule Set 是 `{kind: "inline", tag, rules}`；Curated 绑定是 `{kind: "curated", tag, artifactRef, httpClient?}`。用户不提供远程 URL、文件路径、hash 或能力声明。
- `artifactRef` 选择固定 manifest revision 中的具体 artifact ID；一个发布不能用“最新版”占位。具体 projection／format 在选择时确定。
- `null` 不表达删除。管理层通过明确的编辑入口操作集合；删除被引用资源报诊断，不能静默级联移除规则。

## 草稿与交付校验

Q5 已确认：保存草稿要求结构完整、字段类型正确，但允许缺失对象引用、Profile 不支持规则等语义错误。缺少必填字段等不完整表单仅留在编辑界面。保存成功返回或保留诊断，不赋予可交付状态。

Schema 校验负责形状与明确字段范围；纯解析与 Compiler 负责固定依赖、引用、顺序和能力；应用层负责管理授权及编辑状态转换。结构正确的草稿不能绕过 Recipe 固定 Profile 或归档节点禁止新增引用等编辑约束。既有已授权归档绑定解析时不应被当成缺失节点。

移除预设可能留下未解析的响应或出站引用，保存后仍需修复才能生成可下载配置。特别是模板声明的 ECS evaluate 响应被移除时，仍按 D06 报错，不自动关闭 ECS 或改写模板声明。正式下载要求 compile 成功；发布还必须通过既有两种 ECS 输出的原生 check。

## 首版字段边界

| 对象 | 首版范围与验证 |
| --- | --- |
| settings | 保持现有四项；logLevel 使用固定版本枚举，tunMtu 延续 576–65535 且唯一 TUN 的约束，两个 final 必须解析到正确命名空间 |
| NodeRevision／NodeBinding | 节点修订根据五份样本支持 VLESS、Hysteria2、Shadowsocks；分别声明 server／port、协议凭据、TLS 及已使用 transport 字段；绑定只接受固定修订、本地 tag 和明确开放的上下文选项，不接受 `options: Obj` 逃生口 |
| Selector／URLTest | 显式成员、默认成员及已使用选项；默认成员必须属于组，组成员和 detour 一同检查依赖环 |
| DNS server | 覆盖样本中的 HTTPS、local；DHCP 留在系统模板的平台定义；HTTPS 的 TLS、headers、detour 等使用明确字段 Schema |
| HTTP client | 显式 tag、version、detour、domain_resolver 等已使用字段；内联 resolver 的结构也需严格校验 |
| Inline Rule Set | 固定 1.14.4 HeadlessRule 的明确子集，可含已确认的逻辑组合；不包含动作、remote URL 或本地路径 |
| Inline DNS Rule | 覆盖现有 route、evaluate、respond、reject、predefined；匹配与动作字段分别验证，具名响应按步骤顺序引用 |
| Inline Route Rule | 覆盖现有 route、resolve、sniff、hijack-dns、reject；含现有逻辑条件与 Profile 限制 |
| inbounds／services／基础根设置 | 首版由系统模板维护；只通过明确 settings 开放编辑，不向用户暴露任意底层对象 |

这张表确定首版范围，不冒充完整字段 Schema。M2-01 必须枚举样本里每种协议的嵌套 TLS／transport、逻辑条件和动作选项；使用固定 1.14.4 Schema 复核类型，同时排除路径资源与不开放字段。Schema 允许某个字段不等于产品允许用户编辑它。

系统模板也需要版本化 Schema，包括允许的 settings、基础资源、五种平台差异、预设及 ECS 响应声明。预设按 DNS／Route 分域，输入引用必须存在于所选模板。Template 中未开放给用户的字段不能通过 Recipe 的相似对象绕过。

## DNS／Route 与 ECS

DNS Policy 是有序程序；不能简化为 Rule Set 到 DNS Server 的映射。`evaluate` 定义具名响应，后续 `match_response`／`respond` 引用此前的响应；这仍不是所有分支上的运行存在性证明。

Route Policy 独立维护匹配、动作、默认出站和组。Route 的 `resolve` 为后续 IP 匹配提供解析结果，不自动插入 DNS Policy 步骤。

ECS 声明来自模板的顶层 evaluate 响应 tag。用户规则不得自行提供 `client_subnet`；纯适配器最终仅传入可信生成参数。`remove_client_subnet` 的已有非动态配置可按明确字段保留，但不能借此修改声明外的运行参数。

ECS 掩码暂不设默认。缺少产品配置时应报告尚未配置，而不是静默使用 /24；“没有可靠 IPv4”则是不同情况，明确生成 `ecs: null`。发布验证样本的地址与前缀必须显式提供，样本地址不是用户保存的公网 IP。

## 从保存结构到 D06 的映射

建议接口概念：`resolveRecipe(revision, fixedDependencies, params)` 返回已有 `Result<CompileInput>` 加诊断位置映射；Profile 从 Recipe 取得，不能由调用方覆盖。实际类型在 M2-03 决定。`fixedDependencies` 已由宿主取得，不是读取数据库或网络的回调。

| 保存结构 | D06 输入 |
| --- | --- |
| templateRef | 精确取得固定 `Template`，核对身份、修订及内容摘要 |
| Recipe id／revision／settings | 原样映射 `recipe` 对应字段 |
| NodeBinding | 宿主检查管理授权并加载固定 NodeRevision，允许不同配置使用者的 Recipe 显式共享；纯适配器合成连接字段与本地 tag，放在原 outbounds 位置 |
| Direct／Selector／URLTest、dnsServers／httpClients | 受限结构转换到现有 resources，保持次序 |
| Inline binding | `{kind: "inline", definition: {type: "inline", tag, rules}}` |
| Curated artifactRef | 从可信 Manifest 选定的 `RuleArtifact` 与 `{kind: "curated", artifactId, tag, httpClient?}` |
| `{id, kind: "preset", presetId}` | `{preset: presetId}`；在独立映射中保存 id |
| `{id, kind: "inline", rule}` | `{rule}`；在独立映射中保存 id |
| Recipe 固定 Profile、可信 ECS 参数 | `profile` 与 `params`；交付目标 Profile 不一致时报错 |

业务结构中的额外元数据不塞入现有 `CompileInput`：当前 Compiler 会拒绝未知键。Manifest 中 projection 等新增约束在适配器检查，后续若需要进入核心也必须显式版本化。

发布记录另存所用 NodeRevision 引用及摘要，便于审计和引用保留；D06 输入摘要已经覆盖解析后的实际连接内容。节点库后续更新不会改变发布快照。需要立即失效的凭据撤销属于单独的管理动作，不能通过悄悄重写不可变修订实现。

例如 user-b 的桌面和 Android 分别保存为 Recipe，保留各自的 Selector、Inline Rule Set 与 Route 步骤差异，再由各自固定 Profile 选择 LAN resolver。保留进程规则的 Android 候选仍报能力错误，不能为了通过发布而删除那条规则。user-d 保持独立模板与策略，不能自动归并为公共默认配置。

脱敏样本会把不同地址、凭据及 TLS／transport 信息替换为合成值，可能使原本不同的节点变得相同。迁移不能按脱敏连接内容自动推导共享 Node ID；应使用显式迁移映射，并用合成样本验证共享行为。

旧样本中 Selector／Rule Set 为保持输出顺序而放入 Recipe 的部分，迁移时仍沿用该归属与次序。不要在本轮模型收紧时悄悄搬入模板，导致组顺序变化。

## 验收场景

- 五份样本通过保存结构和解析适配器恢复原 CompileInput；使用现有受限 normalization 比较 golden，严格保留数组顺序。
- 同名 tag、未知字段、模板未开放设置、缺失固定版本、任意 URL 和本地文件路径被拒绝。
- 管理者可给不同配置使用者的 Recipe 绑定同一节点修订；未获授权的管理请求或订阅对其他交付目标的访问必须拒绝。纯核心不承担身份认证。
- 每份 Recipe 的 Profile 固定；调用方和交付目标不能换用另一 Profile，复制为新 Recipe 后重新校验。
- 两个 Recipe 引用同一 NodeRevision 时可使用不同本地 tag；新节点修订不会改变两者，显式升级只影响选定 Recipe 的新修订。缺失节点修订必须报错，不能回退到最新版。
- 归档节点的新绑定被编辑边界拒绝；归档前已有绑定可继续解析、编译和发布。被引用修订不能删除，归档不改写发布快照。
- preset 重复展开仍有独立对象和明确诊断来源；修改输入或生成结果不污染其他用户与调用。
- 预设整体移动后按新位置展开；删除后若留下未解析引用，草稿可保存但编译失败。不得自动恢复顺序或添加被移除预设。
- 类型错误或缺少必填字段的草稿不能保存；结构完整但引用缺失／能力不兼容的草稿可保存并带诊断，不能下载或发布。
- 缺失具名 DNS 响应、在定义前引用、错误 projection 用途，以及不支持的 Profile 能力均有针对性反例。
- 保存后修改草稿不影响已固定修订的发布；发布失败和并发激活冲突均不替换旧版本。

以上是后续验收条件，尚未执行新的 Schema／适配器测试。
