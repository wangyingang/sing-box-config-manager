> **历史归档，非当前规范。** 本文来自用户提供的 `sing-box-configuration-management-handoff.md`，原文版本为 1.0，原文日期与归档日期均为 2026-11-02。下方原文完整保留，不随项目进展持续更新。
>
> 原文中的“D06 尚未最终决定”、后续计划、路径及给智能体的工作约束反映交接当时的状态，不能作为当前行动指令。D06 已确定采用 TypeScript Composer 并完成最小实现，仓库已重构为三模块 monorepo；当前决策与实施范围以随后发布的 ADR 和正式 spec 为准。

当前参考：

- [领域决策 ADR](../adr/)
- [D06 配置组合设计](../../packages/config-compiler/docs/architecture/config-composition-design.md)
- [M2 正式 Spec #1](https://github.com/wangyingang/sing-box-config-manager/issues/1)

原文 SHA-256：`dd6c27cd16b104a93125558171d1fb3a794940c767ac7591fe934ef0c46c70d7`。

---

<!-- archived-original-below -->

# sing-box Configuration Management Platform

# 项目交接文档

-   **文档版本：** 1.0
-   **更新日期：** 2026-11-02
-   **项目状态：** 需求边界基本收敛，进入核心架构设计与技术验证阶段。

------------------------------------------------------------------------

## 1. 项目定位

### 1.1 项目目标

构建一个以 sing-box 为目标运行环境的配置管理系统，具备：

-   多来源规则数据采集与管理
-   统一规则格式解析与转换
-   sing-box Rule Set JSON / SRS 生成
-   可组合 DNS / Route 策略
-   完整客户端配置文件生成
-   多用户、多平台配置管理
-   配置文件直接下载
-   远程订阅、更新、重新生成和撤销
-   规则数据及配置版本管理

**正式定位：**

> 一个以 sing-box
> 为目标运行环境，具备多来源规则数据管理、统一规则格式转换、可组合
> DNS/路由策略、配置生成、订阅发布和持续更新能力的配置管理系统。

### 1.2 使用范围与设计原则

当前首先服务于个人、家人和朋友。未来可能逐步完善并开源，但现阶段不以公共
SaaS 服务为目标。

设计原则：

1.  不过度设计。
2.  不为没有明确需求的功能建立抽象层。
3.  优先满足真实使用场景。
4.  模块边界清晰，便于后续扩展。
5.  业务模型与具体实现机制分离。

------------------------------------------------------------------------

## 2. 相关仓库与历史讨论

### 2.1 相关仓库

  ---------------------------------------------------------------------------------------------------------------------
  仓库                                                                              作用
  --------------------------------------------------------------------------------- -----------------------------------
  [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script)   主要规则数据源

  [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)     补充规则数据源

  [wangyingang/sing-box-geosite](https://github.com/wangyingang/sing-box-geosite)   当前规则采集、转换和 SRS 生成脚本

  [wangyingang/sing-box-config](https://github.com/wangyingang/sing-box-config)     当前实际使用的 sing-box
                                                                                    多用户配置工程
  ---------------------------------------------------------------------------------------------------------------------

### 2.2 相关 Branch

-   [Branch 1：sing-box merge
    源码研究及相关架构讨论](https://chatgpt.com/g/g-p-6ad64b0000648191a9477cad8f683b6f-ji-zhu-wang-luo-fan-qiang/c/6ae788da-a2dc-83e8-9f86-d4abb5fa03d5)
-   [Branch 2：配置管理系统边界、ECS 与 Cloudflare
    部署讨论](https://chatgpt.com/g/g-p-6ad64b0000648191a9477cad8f683b6f-ji-zhu-wang-luo-fan-qiang/c/6ae78773-a96c-83e8-988d-c584e2d2799b)

Branch
内容属于需要继续阅读和核实的历史上下文。后续智能体不应仅凭本交接文档推断
Branch 中未明确列出的源码细节。

------------------------------------------------------------------------

## 3. 整体系统架构

项目由三个独立的逻辑模块组成。它们是逻辑模块，不意味着首期必须部署为三个微服务。

### 3.1 Module 1：Rule Set Pipeline

负责规则数据采集、解析、转换和发布：

1.  获取系统维护的外部规则数据。
2.  使用不同 Parser 解析不同规则格式。
3.  转换为统一 IR。
4.  标准化、去重。
5.  处理不支持的规则并生成报告。
6.  根据 DNS / Route 使用场景生成规则文件。
7.  编译 sing-box JSON / SRS。
8.  执行兼容性及质量检查。
9.  版本化发布规则文件。

该模块允许依赖 sing-box
binary。其他模块只依赖其发布的规则文件和元数据，不需要实时调用 Rule Set
Pipeline。

### 3.2 Module 2：Config Compiler

负责将以下输入编译为完整 sing-box 客户端配置：

-   Base Configuration Template
-   官方预设
-   用户自定义 Outbounds
-   系统维护的 Rule Sets
-   用户自定义 Inline Route Rules
-   用户自定义 Inline Rule Sets
-   用户自定义 DNS Rules
-   Route Policy
-   DNS Policy
-   Client Profile
-   用户及设备配置参数

输出完整、符合目标 sing-box 版本及客户端能力要求的 JSON 配置文件。

该模块不应与 Web UI 耦合，应能够独立调用。

配置组合实现尚未最终确定：自主实现 TypeScript Config
Composer，或继续采用 sing-box merge。必须结合源码研究结果比较后决定。

### 3.3 Module 3：Configuration Manager Web App

为用户提供：

-   用户及设备管理
-   配置模板选择
-   平台及客户端版本选择
-   节点管理
-   Rule Set 选择
-   DNS / Route Inline Rule 管理
-   DNS / Route Policy 编辑
-   配置预览
-   配置生成和校验
-   JSON 下载
-   远程订阅
-   订阅更新
-   订阅重新生成
-   旧订阅撤销
-   配置版本历史

Web App 只负责管理配置数据和调用 Config Compiler，不直接拼接 sing-box
JSON。

当前考虑使用 Cloudflare Workers + Custom Domain 部署 Web App。

------------------------------------------------------------------------

## 4. D01-D05：规则数据与规则模型

### 4.1 D01：规则数据来源

已确定两个系统维护的规则来源。

#### A. Blackmatrix7

仓库：[blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script)

目前一直使用，是主要规则数据源。现有脚本主要处理 Clash List 和 Clash
YAML。

涉及的常见规则类型：

-   DOMAIN
-   DOMAIN-SUFFIX
-   DOMAIN-KEYWORD
-   DOMAIN-REGEX
-   IP-CIDR
-   IP-CIDR6
-   PROCESS-NAME
-   其他 sing-box 能够表达的规则

不支持或者无法准确对应 sing-box 的字段，例如
ASN，应丢弃，但必须记录，不能静默丢弃。不要求保留上游所有规则语义。

#### B. V2Fly Domain List Community

仓库：[v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)

目前明确需要接入的规则文件：

  文件                     用途
  ------------------------ --------------------
  `data/anthropic`         Anthropic / Claude
  `data/openai`            OpenAI
  `data/google-deepmind`   Google DeepMind
  `data/category-ai-!cn`   AI 聚合规则

规则链接：

-   [anthropic](https://github.com/v2fly/domain-list-community/blob/master/data/anthropic)
-   [openai](https://github.com/v2fly/domain-list-community/blob/master/data/openai)
-   [google-deepmind](https://github.com/v2fly/domain-list-community/blob/master/data/google-deepmind)
-   [category-ai-!cn](https://github.com/v2fly/domain-list-community/blob/master/data/category-ai-!cn)

V2Fly 使用自己的 Domain List DSL，需要独立 Parser。

主要语法映射：

  V2Fly 语法             sing-box
  ---------------------- ----------------------
  `domain:example.com`   `domain_suffix`
  `example.com`          `domain_suffix`
  `full:example.com`     `domain`
  `keyword:example`      `domain_keyword`
  `regexp:^example`      `domain_regex`
  `include:xxx`          解析并展开被引用规则

处理原则：

-   Include 必须解析、递归展开。
-   检查循环引用和缺失依赖。
-   展开完成后不再保留 Include 关系。
-   `@ads`、`@telemetry` 等属性直接忽略。
-   忽略属性时仍保留对应域名规则。
-   不需要维护属性过滤和规则继承机制。

### 4.2 D02：统一 IR

采用统一中间表示，但保持最小化。

IR 的目的只是将不同来源的规则转换为 sing-box 能够使用的匹配规则。

不需要维护：

-   上游 Attributes
-   Include 关系
-   规则分类
-   规则集合父子关系
-   每条规则的来源追踪
-   上游原始语法

只需要在 Rule Set 层保存必要的来源信息：

-   Source Repository
-   Source Path
-   Source Revision
-   Generated At
-   Content Hash

不支持的规则字段可以丢弃，但必须记录转换报告。

报告至少包含：

-   输入规则数量
-   成功转换数量
-   不支持规则数量
-   无效规则数量
-   按规则类型统计的丢弃数量
-   错误原因

处理原则：

-   不支持的规则：Warning，跳过并记录。
-   语法错误、Include 缺失、文件无法解析：Error，该规则集构建失败。
-   不允许静默丢弃。

### 4.3 D03：Rule Set 粒度

采用完全平铺的 Rule Set 组织方式。

明确不需要：

-   细粒度 Catalog 分类体系
-   规则集合父子关系
-   聚合规则集合
-   规则集合继承
-   用户可见的分类目录

每个规则集合独立存在，彼此平行。

例如：

-   OpenAI（Blackmatrix7）
-   openai（V2Fly）
-   Anthropic（Blackmatrix7）
-   anthropic（V2Fly）
-   google-deepmind
-   category-ai-!cn
-   GitHub
-   Microsoft
-   Apple
-   Docker

不同来源的同名或相似规则集合不自动合并。

用户直接选择需要的规则集合。

### 4.4 DNS Rule Set 与 Route Rule Set

生成规则文件时，需要明确区分 DNS 和 Route 使用场景。

当前已有设计：

  产物                              用途
  --------------------------------- ---------------------
  `Name.json` / `Name.srs`          通用 Route Rule Set
  `DNS_Name_domain.json` / `.srs`   DNS 域名请求匹配
  `DNS_Name_ipcidr.json` / `.srs`   DNS 响应 IP 匹配

具体生成哪些文件应根据规则内容决定，不需要无条件生成所有组合。

DNS 和 Route 的策略保持独立。

注意：sing-box Rule Set 使用 Headless Rule 结构，不能把 DNS Rule 和
Route Rule 的完整结构混为一谈。

### 4.5 D04：用户自定义规则

禁止用户自定义外部规则源。

用户只能：

1.  选择系统维护的 Rule Sets。
2.  创建 Inline DNS Rule。
3.  创建 Inline Route Rule。
4.  创建 Inline Rule Set。

Inline Rule 与 Inline Rule Set 是不同的配置对象：

-   Inline Rule：直接定义匹配条件和动作。
-   Inline Rule Set：定义可被多个策略引用的内联匹配集合。
-   Curated Rule Set：系统维护的规则文件，通常以 Remote Rule Set 引用。

用户规则保存在 Config Recipe 中，不需要独立维护外部规则文件。

------------------------------------------------------------------------

## 5. D05：DNS / Route 策略

DNS Policy 和 Route Policy 是两个独立的策略体系。

### 5.1 Route Policy

主要负责：

-   Rule Set 与 Outbound 的映射
-   Inline Rule 与 Outbound 的映射
-   规则优先级
-   默认出站
-   Selector / URLTest 逻辑出站组

例如：

  Rule Set          Outbound
  ----------------- ----------
  OpenAI            AI
  Anthropic         AI
  Google DeepMind   AI
  GitHub            Proxy
  China             DIRECT

Outbound 可以是具体节点，也可以是 Selector / URLTest 组。

### 5.2 DNS Policy

负责：

-   DNS Server 选择
-   DNS 规则匹配
-   DNS 请求与响应处理
-   国内/国外 DNS 分流
-   ECS
-   DNS 失败处理
-   DNS 与 Route 策略之间的协调

DNS Policy 不能简单等同于 Rule Set 到 DNS Server 的静态映射。

尤其要考虑 sing-box 1.14 的：

-   evaluate
-   respond
-   match_response
-   DNS Rule Set
-   DNS Server 选择
-   ECS

高级 DNS 策略需要有序执行步骤，而不是简单的规则集合选择器。

### 5.3 已有个人配置的实际需求

当前日常配置涉及：

-   国内 DNS 与海外 DoH 分流
-   AliDNS / Google DNS
-   ECS 优化
-   DNS evaluate / respond
-   UDM Pro 本地 DNS
-   本地域名及局域网 DNS 处理
-   AI 服务指定代理出口
-   Selector / URLTest
-   DNS 与业务流量出口不一致时的 CDN 选址问题
-   防止 DNS、DoT、QUIC 等流量绕过代理策略

这些真实需求应作为 Config Compiler 的设计依据。

Route Action `resolve` 是用于将域名解析结果提供给后续 IP
匹配规则的动作，不应与 DNS 模块本身混为一谈。

------------------------------------------------------------------------

## 6. D06：配置合并机制与源码研究

这是当前最重要的未决技术问题。

### 6.1 sing-box-config 的定位

仓库：[wangyingang/sing-box-config](https://github.com/wangyingang/sing-box-config)

该仓库的目的是帮助理解真实配置业务需求。

**并不意味着必须继承 Snippets + sing-box merge
实现，也不意味着必须放弃它。**

需要继承的业务能力：

-   多用户配置
-   公共基础配置
-   用户专属配置
-   不同 Outbound 节点
-   DNS / Route 独立策略
-   用户自定义规则
-   Android 平台差异
-   ECS 动态参数
-   多个配置片段之间的组合需求
-   最终完整配置生成

现有 Snippets 的文件划分、命名方式及 Merge 实现不属于必须继承的设计。

### 6.2 sing-box merge 1.14.4 源码审计结论

Branch 中已经针对 sing-box v1.14.4
做过源码级研究。以下是阶段性结论，后续应回到对应版本源码复核并补齐精确代码位置。

主要调用链：

``` text
cmd_merge.go
    |
    v
readConfig()
    |
    v
mergeOptionsList()
    |
    v
badjson.MergeJSON()
    |
    v
typed options decode / encode
```

#### 文件加载顺序

-   `-c` 指定的文件与 `-C`
    指定目录扫描得到的文件，统一按完整文件路径字典序排序。
-   `-c` 参数的排列顺序不决定最终合并优先级。
-   `-C` 只扫描目录直接子级 `.json` 文件，不递归扫描。
-   文件命名和目录组织会影响合并优先级。

#### JSON 合并行为

  类型           阶段性结论
  -------------- ---------------------
  Object         递归合并
  Array          追加，不自动去重
  Scalar         已存在的值优先
  null           不是删除指令
  同名数组元素   不会按 tag 自动合并

对象递归合并采用先出现值优先的方式。

类型冲突时的处理还与目标字段类型有关，不能简单概括成一个通用覆盖规则。

CLI 固定使用 `disableAppend=false`。

#### Typed Options 处理

每个 snippet：

1.  先解码为 sing-box typed `option.Options`。
2.  未知字段会被拒绝。
3.  执行 JSON 合并。
4.  合并结果再次进行 typed decode / encode。

此外，`mergePathResources()` 会处理部分证书、密钥等路径资源的内联问题。

#### merge、check、run 的区别

三者共享配置读取和合并链，但后续行为不同：

-   merge：生成合并后的配置。
-   check：构造 sing-box 实例进行检查。
-   run：实际启动 sing-box 实例。

因此，sing-box merge 成功不代表 sing-box check 或 run 一定成功。

### 6.3 现有 Merge 机制的主要局限

1.  合并规则不透明，开发者容易根据少量实例误判。
2.  数组只能追加，无法直接表达替换、按 tag 合并等业务操作。
3.  null 不能用来删除字段。
4.  文件路径字典序与合并优先级绑定。
5.  Snippets 内容划分受到合并语义限制。
6.  用户配置与模板的组合灵活性不足。
7.  Config Compiler 必须依赖 sing-box binary。
8.  Web App 如何调用依赖 binary 的 Compiler，需要额外部署设计。

### 6.4 两种实现路线

#### 路线 A：TypeScript Config Composer

自主实现配置组合引擎。

优点：

-   完全掌握合并语义。
-   不受文件名及 Snippets 划分限制。
-   可以根据配置对象定义不同合并规则。
-   可以作为 TypeScript 独立包供 Web App Backend 调用。
-   不需要 Config Compiler 运行时依赖 sing-box binary。

需要实现：

-   Schema-aware Composition
-   Object Merge
-   Array Merge
-   Rule Ordering
-   Outbound / Rule Set 引用检查
-   字段冲突检测
-   平台兼容性检查
-   最终 JSON 输出

不应该只是重新实现一个通用 JSON deep merge，而应该按 sing-box
配置结构定义业务组合规则。

#### 路线 B：继续使用 sing-box merge

优点：

-   直接使用官方实现。
-   不需要自行维护 Merge 算法。
-   与现有工作流接近。

缺点：

-   依赖 sing-box binary。
-   仍然受到 Merge 行为约束。
-   Snippets 的组织方式需要适应官方机制。
-   Web App 必须通过后端服务调用 Compiler，不能在浏览器端直接运行
    binary。
-   如果 Web App 部署在 Cloudflare Workers，binary
    运行环境需要单独解决。

### 6.5 当前决策状态

**尚未最终决定。**

Branch 中已有的技术研究倾向于推荐 TypeScript Schema-aware Config
Composer，但这是技术建议，不是用户已经确认的最终决定。

下一步：

1.  完整整理 1.14.4 Merge 源码研究报告。
2.  结合 sing-box-config 的真实配置样本，设计 Composer 合并语义。
3.  比较两种路线的开发成本、维护成本和部署约束。
4.  最后确定 D06。

Config Compiler 的领域模型应独立于具体合并实现。

------------------------------------------------------------------------

## 7. D07：客户端平台适配

不需要支持所有操作系统及客户端组合。

只涉及以下五种客户端发行版本：

  Profile ID              平台      客户端
  ----------------------- --------- -------------------
  `windows-standalone`    Windows   Standalone
  `macos-appstore`        macOS     Apple Store
  `macos-standalone`      macOS     Standalone
  `ios-appstore`          iOS       Apple Store
  `android-google-play`   Android   Google Play Store

不考虑：

-   iOS 越狱版本
-   Android 越狱版本
-   其他第三方客户端发行渠道

### 7.1 macOS 特殊差异

当前使用 macOS SFM Apple Store 版本，未来计划迁移至 Standalone 版本。

已明确的差异：

  功能               App Store   Standalone
  ------------------ ----------- ------------
  Process Matching   不支持      支持

包括：

-   process_name
-   process_path
-   process_path_regex

因此，配置生成前必须根据 Client Profile 检查这些规则是否可以使用。

不能只依赖 sing-box check 判断客户端兼容性。

其他能力根据实际使用情况逐步补充，不需要建立过度复杂的全平台能力管理系统。

------------------------------------------------------------------------

## 8. ECS 与 Cloudflare Worker

### 8.1 已确定的用户要求

ECS 不再使用配置生成服务器的公网 IP，而是根据访问 Web App 的客户端公网
IP 动态生成 `client_subnet`。

前提：

**用户必须直连 Web App，不能通过代理访问。**

否则 Web App 获取到的将是代理出口 IP，而不是用户实际宽带公网 IP。

### 8.2 预期工作流程

``` text
用户浏览器
    |
    | Direct Connection
    v
Cloudflare Custom Domain
    |
    v
Cloudflare Worker
    |
    | 获取可信的客户端公网 IP
    v
ECS Generator
    |
    | 生成 client_subnet
    v
Config Compiler
    |
    v
完整 sing-box JSON
```

### 8.3 实现约束

-   Worker 只信任 Cloudflare 提供的客户端 IP 信息。
-   优先使用可信入口的 `CF-Connecting-IP`。
-   不直接信任任意用户提供的 `X-Forwarded-For`。
-   校验公网 IPv4。
-   计算对应的 ECS CIDR。
-   如果没有可靠的公网 IPv4，不生成 ECS，不得使用服务器 IP 代替。
-   默认 `/24` 是此前提出的建议，具体掩码仍需最终确认。

Worker 内部调用其他服务时，应显式传递已经验证的
clientSubnet，不要在子请求中重新推断客户端 IP。

### 8.4 远程订阅的特殊问题

因为 ECS 与访问者 IP 相关，同一份 Config Recipe
可能需要生成不同的配置文件。

建议：

-   每次订阅请求根据请求者 IP 动态生成配置。
-   配置订阅响应使用 `Cache-Control: private, no-store, max-age=0`。
-   Cloudflare CDN 和 Cache API 不缓存个性化配置。
-   公共 SRS 文件可以使用 CDN 缓存。
-   订阅令牌与用户身份应独立管理。

以上是技术方案，缓存策略、令牌模型和最终 Worker/Compiler
部署方式仍需实现验证。

------------------------------------------------------------------------

## 9. 现有仓库分析与迁移要求

### 9.1 sing-box-geosite

仓库：[wangyingang/sing-box-geosite](https://github.com/wangyingang/sing-box-geosite)

现有实现：

``` text
GitHub Actions
    |
    v
Python 定时脚本
    |
    v
Blackmatrix7 Clash List / YAML
    |
    v
JSON
    |
    v
sing-box rule-set compile
    |
    v
SRS
```

已有功能：

-   定时采集
-   Clash List / YAML 解析
-   JSON 生成
-   SRS 编译
-   DNS 专用规则拆分
-   基础测试

需要改进：

-   建立独立 Parser / Adapter。
-   引入最小化 IR。
-   ASN 等不支持字段丢弃并记录。
-   修正 URL-REGEX 与 domain_regex 的错误映射。
-   检查 no-resolve 等修饰符的处理。
-   建立结构化转换报告。
-   增加 Include 展开能力。
-   增加输入异常、依赖缺失等失败处理。
-   生成可追溯的 Rule Set Manifest。
-   增加发布质量门禁和回滚。

此前检查还发现，该仓库 CI 使用 sing-box 1.13.0，输出 Source Format
v4。应重新核实当前仓库状态，并明确目标版本策略。

### 9.2 sing-box-config

仓库：[wangyingang/sing-box-config](https://github.com/wangyingang/sing-box-config)

该仓库应作为真实业务需求的参考和回归测试样本。

需要保留的业务能力：

-   多用户配置
-   公共基础配置
-   用户专属配置
-   不同用户的 Outbound
-   DNS / Route 分离
-   Inline Rule Set
-   平台差异
-   ECS
-   配置片段组合能力

不要求继承其 Snippets + Merge 的实现方式。

尤其需要保留真实配置作为测试 Fixture，避免新 Config Compiler
虽然架构整洁，却无法生成当前实际使用的配置。

------------------------------------------------------------------------

## 10. 当前架构决策清单

  编号   事项             当前结论
  ------ ---------------- ----------------------------------------------------
  D01    规则源           Blackmatrix7 + V2Fly
  D02    IR               最小化，只保留 sing-box 可用规则及规则集级来源信息
  D03    Rule Set 粒度    平铺、独立、无分类、无聚合
  D04    用户自定义规则   只允许 Inline Rule / Inline Rule Set
  D05    DNS / Route      两套独立策略
  D06    配置合并         待源码研究和技术比较后决定
  D07    平台适配         固定五种客户端发行版本
  D08    配置验证         sing-box 语法检查 + Client Profile 兼容性检查
  D09    用户配置         公共配置 + 用户配置 + 平台差异
  D10    配置订阅         本地生成和远程订阅共用 Config Compiler
  D11    ECS              根据访问 Web App 的客户端公网 IP 动态生成

------------------------------------------------------------------------

## 11. 下一阶段工作计划

### M1：完成 D06 技术决策

优先级最高。

-   完成 sing-box 1.14.4 merge 源码研究报告。
-   整理调用链及真实合并语义。
-   分析 sing-box-config 的实际配置组合需求。
-   设计 TypeScript Config Composer 的合并语义。
-   比较 Composer 与官方 merge。
-   确定最终实现方案。

建议交付物：

-   `docs/architecture/sing-box-merge-analysis.md`
-   `docs/architecture/config-composition-design.md`

### M2：完成核心领域模型

定义：

-   Rule IR Schema
-   Rule Source Definition
-   Rule Set Metadata
-   DNS / Route Rule Set 输出模型
-   Config Recipe Schema
-   Outbound / Node Model
-   DNS Policy Schema
-   Route Policy Schema
-   Inline Rule / Inline Rule Set
-   Client Profile Schema

建议交付物：

-   `docs/architecture/domain-model.md`
-   `docs/architecture/rule-ir.md`
-   `docs/architecture/config-recipe.md`

### M3：Rule Set Pipeline 设计与迁移

-   Blackmatrix7 Parser
-   V2Fly Parser
-   Normalize
-   Deduplicate
-   Unsupported Rule Report
-   DNS / Route Projection
-   JSON / SRS Builder
-   Manifest
-   Automated Tests

先保证现有 Blackmatrix7 规则转换能力不退化，再增加 V2Fly。

### M4：Config Compiler

-   Base Template
-   Outbound Builder
-   Rule Set Reference Builder
-   DNS Policy Compiler
-   Route Policy Compiler
-   Client Profile Validation
-   ECS Generator
-   Final Config Builder

使用 sing-box-config 现有配置作为 Golden Fixtures。

### M5：Web App

-   用户及配置管理
-   Client Profile 选择
-   节点管理
-   Rule Set 选择
-   Inline Rule 编辑
-   DNS / Route Policy 编辑
-   预览和校验
-   下载和订阅
-   更新及撤销
-   Cloudflare Worker 与 ECS 动态生成

------------------------------------------------------------------------

## 12. 给后续智能体的工作约束

1.  不要重新讨论已经确定的产品定位和三模块划分。
2.  不要把 sing-box-config 的 Merge 实现当成必须继承的方案。
3.  不要在 D06 未完成技术比较前擅自确定 Merge 或 Composer。
4.  不要设计用户自定义外部 Rule Source。
5.  不要为 Rule Set 建立分类、父子关系、聚合或继承体系。
6.  不要过度设计 IR；不支持的规则只需记录并丢弃。
7.  不要把 DNS Policy 和 Route Policy 混为一体。
8.  不要把五种客户端发行版本扩展为通用全平台矩阵。
9.  不要让 Web App 生成的 ECS 使用服务器公网 IP。
10. 不要仅凭 sing-box check 成功就认为目标图形客户端完全兼容。
11. 优先阅读现有两个 GitHub 仓库和真实配置，不要凭空设计业务模型。
12. 技术结论必须区分官方文档、源码证据、实测结果和推测。
13. 复杂问题逐项推进，先形成技术规范，再开始实现。
14. 所有关键决策都应有明确记录，避免后续智能体反复推翻已经确认的设计。

------------------------------------------------------------------------

## 13. 当前最重要的下一步

**首先完成 sing-box merge 源码研究及 Config Composer 技术方案比较。**

这是目前唯一明确需要优先解决的核心技术选型问题。

完成 D06 后，再冻结 Config Recipe 和 Rule IR 的第一版 Schema。

之后才能可靠地推进 Rule Set Pipeline、Config Compiler 和 Web App
的并行开发。

项目最终目标不是复刻现有两个 Python / JSON
配置仓库，而是将目前分散的规则转换、配置组织、DNS/Route
策略和订阅工作整合成一套可持续维护的 sing-box Configuration Management
Platform。
