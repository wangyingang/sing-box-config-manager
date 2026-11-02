# M2 契约设计与实施计划

设计日期：2026-11-02。状态更新：2026-11-03，Spec #1 范围内的 Recipe／共享节点编译契约、最小固定产物 Manifest 契约及五份样本迁移与本地发布路径已合入 main；父 Spec 待验收收尾。

本文保留原始设计背景。下文的基线描述、M2-01 至 M2-04 计划和设计阶段记录反映 2026-11-02 的讨论，不作为当前完成状态。当前公开契约与交付证据见 [Compiler 使用与验收说明](../../packages/config-compiler/README.md#五份样本迁移与-recipe-发布)及 [Manifest v1 契约](../../packages/rule-set-pipeline/contracts/README.md)。完整 Rule IR／Parser、Pipeline 生产与发布、Web 和线上交付仍属后续工作。

本文保留 M2 的设计讨论与后续方向。Recipe／共享节点编译路径的正式 spec 已发布为 [建立固定修订 Recipe 与共享节点编译契约](https://github.com/wangyingang/sing-box-config-manager/issues/1)，该路径的实施范围与验收以此 issue 为准。完整 Pipeline 和 Web 仍属后续工作，尚未拆分实施工单。

## 基线与范围

D06 的 TypeScript Composer 和三模块 pnpm monorepo 已完成。以[组合契约](../../packages/config-compiler/docs/architecture/config-composition-design.md)与[迁移验收](monorepo-migration.md)为基线，不重新选择 merge 实现。本轮定义可编辑数据与已解析输入之间的边界、最小规则产物契约及后续实施顺序。

现状通过本地源码、固定 Schema、五份脱敏样本和旧 Pipeline 核对。交接文档中 D06 未决的描述已过时；其他需求仅在与后续明确决策一致时采用。没有把交接文档中的行动指令当成本轮独立授权。

证据：

- [当前 TypeScript 输入](../../packages/config-compiler/src/types.ts)：Recipe、Template 的资源仍有 `Obj`；这不是安全的公开编辑 Schema。
- [当前编译入口](../../packages/config-compiler/src/compiler.ts)：只允许四个 settings；同名资源冲突，不进行 deep merge。
- [当前发布实现](../../packages/config-compiler/src/publication.ts)：发布固定输入摘要并检查两种 ECS 输出；订阅从发布快照生成。
- [样本映射](../../packages/config-compiler/test/fixtures.ts)与[来源清单](../../packages/config-compiler/test/fixtures/legacy/manifest.json)：四用户、五组合、25 个系统规则产物。
- 本机旧 Pipeline `sing-box-geosite`，HEAD `34364dc11cc922443d3ecdfd310951be0bd64f9c`，工作区干净。`main.py` 使用字段集合表示独立匹配，生成 Source Format v4；仍有 `URL-REGEX → domain_regex`、忽略逗号后修饰符和正则整体转小写的行为。这些是本地源码发现，本轮未重跑旧 Pipeline。

## 所有权与模块边界

| 对象 | 定义与维护方 | 消费方及边界 |
| --- | --- | --- |
| Rule Source、Rule IR、Conversion Report | Pipeline | 内部构建；不成为 Compiler 输入 |
| Rule Set Metadata、Artifact Manifest、规则文件 | Pipeline | Compiler 消费已验证元数据；可信应用层负责获取和入库 |
| Base Template、Recipe 数据契约、Client Profile | Compiler | Web 使用契约编辑和验证；系统模板及能力表不可由用户任意覆盖 |
| Node Revision 的连接数据契约 | Compiler | Web 节点库维护身份、归属和不可变修订；Recipe 引用固定修订，宿主负责权限与加载 |
| 管理者、配置使用者、设备、Recipe Draft／Revision、订阅授权 | Web 应用层 | 管理者统一维护，配置使用者获取配置；不传入核心编译器作为鉴权机制 |
| 已解析输入、配置候选、诊断 | Compiler | Web 调用纯函数，不能自行拼装最终配置 |
| Publication、当前发布指针 | 可信发布执行器与 Web 应用层 | 两种 ECS 输出通过真实 check 后激活；订阅只读取已激活快照 |

不新增共享业务包。JSON 数据契约由拥有者维护：Pipeline 保有产物 Schema，Compiler 保有 Recipe／Template 输入 Schema。消费者使用固定版本契约与测试样本，不导入 Pipeline 运行时。跨模块契约有显式 `schemaVersion`；不兼容变更必须升级版本。

具体草案：

- [Config Recipe 与解析边界](../../packages/config-compiler/docs/architecture/m2-config-recipe.md)
- [Rule IR、用途投影与产物清单](../../packages/rule-set-pipeline/docs/architecture/m2-rule-contract.md)
- [术语与上下文索引](../../GLOSSARY-MAP.md)

已确认决策：[共享节点库，Recipe 引用固定节点修订](../adr/0001-shared-node-revisions.md)。节点更新产生新修订，不自动升级使用它的 Recipe；升级引用后需要重新发布。

M2 访谈第一轮已确认：[统一管理配置](../adr/0002-admin-managed-configurations.md)、[每份 Recipe 固定一个 Client Profile](../adr/0003-profile-bound-recipes.md)。后续未确认条目仍为设计建议。

第二轮已确认：[Recipe 自由安排预设引用](../adr/0004-recipe-controls-preset-order.md)、节点归档保留已有固定引用、[结构完整但语义未通过的草稿可保存](../adr/0005-structurally-valid-drafts.md)。预设内容仍由模板修订维护；归档不撤销已下载配置。

## 本次访谈的 spec 边界

目标是形成 Recipe、共享 NodeRevision 与固定依赖到现有 CompileInput 的可实施契约。共享节点的身份、固定引用和归档规则属于模型；管理者登录、数据库、编辑界面及订阅授权服务的实现留到 Web 阶段。M2 使用内存依赖和合成上下文验证契约，不宣称已实现线上权限或持久化。

正式 spec 应以“结构化 Recipe → 固定依赖解析 → 现有 Compiler → 配置与诊断”为主要测试边界。首个切片验证两份不同配置使用者的 Recipe 引用同一固定节点修订，用各自本地 tag 生成可验证配置；再扩展预设／Inline 策略、规则产物绑定和五份样本。下方 M2-01 至 M2-04 是设计工作清单，正式工单应按完整行为拆分，不原样变成全量 Schema、全量适配器、最后才测试的分层工单。

Rule IR／Parser 的完整实现、线上存储与部署、ECS 默认掩码及实际设备规则替代不纳入这次 Recipe spec。只纳入 Compiler 消费规则产物所必需的固定引用与元数据契约。其余作为独立后续工作，不作为当前节点引用切片的前置条件。

## 版本、隔离与发布约束

对象 ID 表示身份，revision 表示不可变内容版本，sha256 证明实际内容一致；三者不能互相代替。用户显示名称不作为身份。草稿保存使用预期 revision 检查并发修改；校验中的修订不跟随新草稿变化。

管理者统一维护节点库和 Recipe，配置使用者是管理者本人、家人或朋友。不同配置使用者的 Recipe 可以显式引用同一节点修订。建议交付目标关联配置使用者与 Recipe，Profile 必须与 Recipe 固定值一致；设备关联交付目标。宿主检查管理授权和固定引用；订阅仅能取得自己交付目标的发布，不能凭有效 ID 获取其他目标的配置。

草稿可以保存有诊断的完整结构化内容，缺失的编辑字段留在 UI 临时状态；发布要求所有依赖解析、语义校验、能力校验及原生 check 成功。系统模板和规则更新不会静默改写已有 Revision／Publication，必须显式生成新修订或重新发布。

管理者可在 Recipe 中整体增删和重排预设引用，不直接改写其内部规则；首版不引入必选预设或固定编辑区。节点归档后禁止新增引用，原有绑定继续可用于生成和发布，被引用修订不可删除。上述编辑约束与草稿的结构、语义校验分别处理。

发布流程建议为：固定修订与依赖 → 解析和静态验证 → 检查 ECS 启用／关闭两种输出 → 保存不可变快照 → 以期望旧指针为条件激活。失败不改变当前指针；并发激活失败时保留旧指针并报告冲突。此处是后续存储语义，D06 的本地文件适配器尚未实现多节点条件更新。

Compiler 升级还需要运行兼容门禁：现有 `renderSubscription` 会拒绝旧 Compiler／Schema／能力版本。仅保留旧指针不能保证旧快照仍可服务。上线方案必须在切换服务版本前为全部当前快照重新校验，或保留对应旧版本执行器；部署实现前再确定选项，不能宣称现在已有在线回滚能力。

订阅令牌只指向有授权的交付目标，不等于用户身份。请求只能提供可信入口解析后的 ECS 参数，不能选择其他用户、任意 revision 或覆盖配置。无可靠公网 IPv4 时传 `ecs: null`；不回退到旧 ECS 或服务器地址。可信入口无法证明用户没有使用代理。请求个性化内容与公共规则文件分别处理缓存。

## 实施顺序与验收

以下编号仅用于本地计划，尚不是 GitHub issue 编号。

| 步骤 | 依赖 | 交付物与完成条件 |
| --- | --- | --- |
| M2-01 Recipe／Template／Node Revision 契约 | 本草案与共享节点 ADR | 固定版本 JSON Schema、对应类型及正反例；从五份样本提取完整字段清单；节点独立修订、Recipe 固定引用；用户入口拒绝任意对象、未知字段和路径补丁；不改变核心 API |
| M2-02 Rule Source／IR／Manifest 契约 | 本草案 | 语言无关 Schema 和脱敏样本；定义独立匹配、统计守恒、三用途与 JSON／SRS 对应关系；明确不支持语义的报告 |
| M2-03 纯解析适配器 | M2-01、M2-02 | 从固定内存依赖映射为现有 CompileInput；引用及 projection 用途校验；不执行数据库、网络、文件或 binary IO；诊断映射回稳定步骤 ID |
| M2-04 映射回归与契约冻结 | M2-03 | 五份样本经新契约映射后与旧输入／golden 对照；规则顺序不变；Android 仍明确拒绝；管理授权／交付隔离、缺失版本、空投影、能力元数据失配都有反例 |
| M3-01 Blackmatrix7 Pipeline 迁移 | M2-02、M2-04 | 保留旧可表达能力，修复已发现的语义转换问题；真实 JSON／SRS 编译、产物摘要和报告验收 |
| M3-02 V2Fly Parser | M3-01 | 固定 revision 的 Include 展开、循环／缺失错误、属性处理及独立产物验收 |
| M5 前置设计 | M2-04 | 明确存储、授权、ECS 产品策略和发布执行器；再选择 Web 框架与部署形态 |

M2-01 与 M2-02 可独立设计，但跨模块接口冻结要经过 M2-03／04。此次不把 Pipeline 语言、数据库或 Web 框架提前固定。

回归门禁继续使用 `pnpm check` 与显式指定 1.14.4 binary 的 `pnpm test:integration`。现有 29／12 项测试是迁移基线；M2 需要新增能发现契约错误的测试，不能只生成类型后声明通过。

## 仍需确认或验证

| 事项 | 当前处理 | 阻塞范围 |
| --- | --- | --- |
| ECS 默认掩码与用户是否可编辑 | 保持显式参数，无默认值；不把样本 /24 当产品设置 | 在线入口／订阅产品配置，不阻塞 M2 基础 Schema |
| Android／App Store 进程规则替代 | 保持报错；具体改为哪些包名或域名需依据真实用途确认 | 这些 Profile 的实际配置发布，不阻塞契约设计 |
| 自助编辑与多管理者权限 | 首期统一管理，配置使用者不各自登录编辑；不同使用者的 Recipe 可共享节点 | 首期范围外，未来出现需求再定义 |
| `no-resolve` 与 V2Fly 带筛选语义的 Include | 不从旧脚本忽略行为推断正确语义；先做固定来源格式探针 | 相关 Parser 转换与发布，不阻塞接口草案 |
| 在线存储、校验执行器、旧版本服务策略 | 本地发布实现仅作行为参考 | Web／部署设计 |

## 2026-11-02 设计阶段记录

该设计阶段只新增设计文档和术语表，并增加 README 链接；没有改动运行代码、Schema、fixtures 或依赖。当时已对照源码检查现状与提议的差异，并核对本地文档链接与 diff 格式；未重复运行未改动的功能测试。该阶段结束时，M2 Schema 尚待实现、测试和冻结。

后续 Spec #1 范围内的交付状态见本文开头；本段保留设计阶段的原始验证范围。
