# M2 Rule IR 与产物契约草案

后续设计确认（2026-11-03）：首个完整交付采用 V2Fly 官方 Release 的 dlc.dat_plain.yml，不自行解析原始 Include、attribute 筛选或 affiliation。规则生产、失败策略、投影、不可变候选及稳定订阅的本次范围，以[首个完整交付设计](../../../../docs/architecture/rule-set-pipeline-first-delivery.md)为准。下文保留更广泛的历史草案，未被该交付明确纳入的字段、Parser 和迁移工作仍属后续方向。

设计日期：2026-11-02。状态更新：2026-11-03，Compiler 消费所需的[最小固定产物 Manifest v1 契约](../../contracts/README.md)及其结构、固定版本、用途和能力校验已实现。本文保留更完整的 Rule IR、Parser、产物生产与发布设计草案；这些后续契约尚未全部定稿，旧 Pipeline 尚未迁移。上层计划见 [M2 契约与实施计划](../../../../docs/architecture/m2-contract-plan.md)。

## Rule Source 与规则集身份

系统维护 Rule Source Definition：`schemaVersion`、`sourceId`、允许的 repository、parser 类型及选定 source path。构建时把可变 ref 解析为精确 source revision，再在该 revision 内取根文件及 Include 依赖。用户 Recipe 不能新增规则源或提交任意 URL。

每个 Curated Rule Set 有稳定 `ruleSetId`、显示名称、sourceId 和 source path；不同来源同名规则集不合并。推荐用来源命名空间保证 ID 唯一，不用文件 basename 作为全局身份。没有分类、父子、聚合或继承模型。

来源信息保存在规则集构建记录：repository、根 path、source revision、输入内容摘要、generatedAt 和 parser 版本。IR 不保留每条规则的来源、属性或 Include 关系。错误报告可以含源文件和行号，便于定位；这不等于引入逐规则来源模型。

## 最小 Rule IR

建议首版结构：`{schemaVersion: "rule-ir-1", terms: MatchTerm[]}`。每个 term 是单一匹配谓词，集合表达任一 term 命中；不把不同字段拼到同一个 Headless Rule 而改变组合语义。

| MatchTerm 类型 | 值与边界 |
| --- | --- |
| domain／domain_suffix／domain_keyword／domain_regex | 字符串；domain／suffix 可规范化，regex 保留原字面及大小写，不以 JavaScript 正则校验代替目标引擎 |
| ip_cidr／source_ip_cidr | 已规范化的 IPv4／IPv6 CIDR |
| port／source_port | 端口整数，范围与固定 Schema 一致 |
| port_range／source_port_range | 显式范围端点；序列化时转换为目标格式，拒绝倒置范围 |
| process_name／process_path／process_path_regex | 保留字面；声明 processMatching 能力 |
| package_name | 保留字面；声明 packageMatching 能力 |
| network | 固定目标版本允许的枚举 |

首版范围覆盖旧 Pipeline 已明确处理的可表达字段。上游逻辑表达式暂不展开到此平铺 IR：识别后整条 Warning 跳过并计入报告，不能摘取其中一个条件而扩大匹配。用户 Inline Rule Set 的逻辑规则属于 Compiler 契约，不受系统源 Parser 的首版范围限制。

IR 不含 action、outbound、DNS server、ECS、Rule Set 间引用或无条件空匹配。去重只处理同类型且规范化后相等的 term；不做 CIDR 聚合、正则改写、跨来源合并或语义猜测。生成顺序由固定字段顺序和规范化值顺序决定。此规则适用于无动作的系统匹配集合，不适用于 Composer 的 DNS／Route 有序策略。

## Parser 失败边界

- Blackmatrix7 的 List 和 YAML 分别按声明格式解析。格式损坏是 Error，不能像旧实现一样将坏 YAML 当普通行继续猜测。
- `URL-REGEX` 不能直接作为域名正则；首版标记为不支持并记录，不复用旧错误映射。ASN 等未纳入范围的规则同样记录 Warning。
- 包含修饰符的行必须完整解析；不能截断逗号后内容。`no-resolve` 的精确投影尚需探针验证，在有依据前按不支持的完整规则记录，不静默丢弃修饰符。
- V2Fly Include 在同一固定 revision 中递归展开。缺失文件、循环引用、语法错误使当前规则集构建失败，不发布部分展开结果。
- 普通 `@ads`／`@telemetry` 属性按已确定范围忽略，保留域名；带筛选含义的 Include 不是普通注释，验证前不能当成无筛选 Include 展开。
- 空文件、只有不支持内容、投影后为空须分别记录。首版建议零有效 term 的规则集不激活新版本；不能发布一个空条件对象形成意外全匹配。

建议 Conversion Report：`inputCount`、`convertedCount`、`unsupportedCount`、`invalidCount`、`duplicateCount`、`outputTermCount`、按类型与原因统计的丢弃数量、warnings、errors。

统计单位先统一：输入数为排除注释、空行后的叶规则出现次数，Include 指令不算叶规则；同一文件被多次包含会产生多次出现。去重前满足 `inputCount = convertedCount + unsupportedCount + invalidCount`。首版每条可转换叶规则产生一个 term，因此 `outputTermCount = convertedCount - duplicateCount`。Include／文件级失败另列 errors，即使已有部分计数也不得发布。各用途投影的条数单独统计，不累加回输入数。

## 三种 Projection

| 用途 | 内容 | 允许的消费位置 |
| --- | --- | --- |
| route | 全部有效 MatchTerm | Route 匹配 |
| dns-query | domain、domain_suffix、domain_keyword、domain_regex | DNS 请求域名匹配 |
| dns-response | 目标 ip_cidr；不包含 source_ip_cidr | 具有响应上下文的 DNS IP 匹配 |

请求／响应上下文需要检查策略位置与动作，不能只依据“出现在 dns.rules”判断。具体响应动作组合用固定版本 Schema、现有 first／ecs 样本和真实 check 验证后冻结。

用途无内容时不生成产物，Manifest 显式说明该 projection 不可用；被用户选择时返回错误，不静默生成空集合。若某个规则集只有域名，其 route 与 dns-query 内容可共用同一物理文件，由两个 projection 映射到同一 artifact；不能要求必有 `DNS_*` 文件名。纯 IP 情况同理。这样保留旧 Pipeline 只在必要时拆分文件的能力。

同一 projection 可生成 source JSON 与 binary SRS。二者语义相同、字节摘要不同，各自有 artifact ID；它们共享语义内容摘要作为对应关系。JSON Source Format 版本作为显式字段记录；旧仓库为 v4，新契约仍需用固定 1.14.4 binary 编译与解码探针确认，不从 sing-box 版本号推断 Source Format 版本。

requiredCapabilities 从实际投影内容计算，而不是从未投影的整个源集合复制。包含进程规则的 route 产物与只含域名的 dns-query 产物可能有不同能力要求。

## Artifact Manifest

建议首版 Manifest 保存：

| 层级 | 必需内容 |
| --- | --- |
| Manifest 身份 | schemaVersion、不可变 manifest revision、pipeline／parser 版本、generatedAt |
| Rule Set Metadata | ruleSetId、显示名称、repository／source path／固定 source revision、输入摘要、转换报告引用 |
| Build 信息 | targetVersion=1.14.4、binary revision／构建信息、sourceFormatVersion |
| Projection 映射 | route／dns-query／dns-response → artifact ID 列表或不可用原因 |
| Artifact | 全局唯一且绑定版本的 artifact ID、format、不可变 HTTPS URL、文件字节 sha256、byteLength、语义摘要、termCount、requiredCapabilities |

Artifact ID 可以由规则集、修订、projection 和 format 组合；不可使用仅有 tag 的 ID，避免不同版本进入同一次编译时冲突。具体字符串编码在 Schema 实现时统一，不作为用户可编辑值。

字节 sha256 覆盖已上传的实际 JSON／SRS 文件，不覆盖 URL 或时间。语义摘要覆盖规范化 IR／projection，不覆盖 generatedAt。Manifest 摘要另算，不包含自己的摘要字段；不能把包含自身 URL 的摘要作为循环定义。相同固定输入应生成相同规则字节，构建记录的时间可以不同。

发布顺序：固定来源 → 解析／报告 → 投影 → 固定 binary 编译 → 对照解码语义 → 校验能力元数据和摘要 → 上传不可变文件及 Manifest → 验证可读性与内容 → 激活规则版本。任一步失败保留旧版本；首版以一个规则集版本的全部产物为原子激活单元，不要求所有平铺规则集同时发布。

## 到 Compiler 的边界

可信宿主从系统发布渠道取得 Manifest，验证版本、来源及文件摘要后登记可用产物；浏览器提交的“已验证”标志无效。文件内容验证不放进纯 Compiler，也不在每次订阅实时下载执行。

适配器检查 Recipe 选择的 projection 存在、使用位置匹配、格式受支持和能力满足 Profile，再将具体 Artifact 转为当前 `RuleArtifact`：

```text
id                   ← 绑定版本的 artifact ID
revision             ← 固定的产物／Manifest 修订
sha256               ← 实际规则文件字节摘要
url                  ← 固定 HTTPS URL
format               ← source | binary
requiredCapabilities ← 实际产物能力要求
```

D06 接收宿主提供的产物元数据，不下载并验证文件。Recipe 入口已在适配器中实现 Manifest 结构、固定修订、用途、消费位置及 Profile 能力校验，并拒绝未知 Manifest 版本、格式或能力词汇。远程内容获取、实际字节摘要、用途内容与能力声明的一致性，以及发布内容门禁仍待后续实现；单靠 `sing-box check` 不能证明远程文件与摘要一致。

## 验收重点

- 不同来源同名集合身份不同；固定 revision 的 Include 缺失／环使构建失败。
- URL 正则、带逗号的表达式、坏 YAML、修饰符、大小写敏感正则有明确测试；每条被跳过规则进入报告。
- domain + process 的集合投影为 DNS 时仅剩 domain，能力声明同步变化；纯域名产物可复用，空投影不能被绑定。
- JSON／SRS 经真实 1.14.4 编译与解码后语义一致；内容改变、摘要不符、上传失败不能激活新版本。
- 相同固定输入与构建版本产生相同产物字节；不会因输入枚举次序改变集合语义或摘要。
- 旧 Pipeline 的有意修复逐项记录差异；不能修改 golden 来掩盖 Compiler 策略顺序变化。

这些是后续验收条件，本轮未执行新 Parser、Projection 或发布流程。
