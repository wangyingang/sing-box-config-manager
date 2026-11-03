# 配置编译

把固定版本的模板、用户配置意图、已验证的规则订阅契约和客户端能力组合为完整客户端配置。

## Language

**Config Recipe（配置配方）**：管理者为一种固定 Client Profile 选择的资源、设置及有序 DNS／Route 策略所组成的配置意图。
_Avoid_: 生成配置、订阅、JSON 补丁

**Base Template（基础模板）**：系统维护的默认设置、基础资源、平台差异及策略预设。

**Policy Preset（策略预设）**：模板维护、在 Recipe 指定位置整体展开的一组有序步骤。预设内部内容属于模板版本，预设引用及其位置属于 Recipe。

**DNS Policy（DNS 策略）**：管理 DNS 查询、响应及解析服务选择的有序步骤与默认设置。

**Route Policy（路由策略）**：管理流量匹配、处理与出站选择的有序步骤与默认设置。

**Inline Rule（内联规则）**：直接位于策略中的匹配条件和动作。

**Inline Rule Set（内联规则集）**：属于 Recipe、可被策略引用的匹配集合；本身不带动作。
_Avoid_: Inline Rule、外部规则源

**Rule Subscription Binding（规则订阅绑定）**：Recipe 或模板对系统规则集及用途的选择，以及该选择在配置中的本地身份。绑定跟随已激活规则版本，不选择固定产物版本。

**Outbound（出站）**：流量的转发目标，可以是直连、具体代理节点或选择组。

**Node（节点）**：连接具体代理服务的出站定义。Selector 和 URLTest 是组，不是节点。

**Node Binding（节点绑定）**：Recipe 对固定节点修订的引用，以及该节点在当前配置中的本地出站身份。

**Client Profile（客户端档案）**：项目支持的五种平台与发行渠道组合之一，携带已确认的能力约束。

**Resolved Compile Input（已解析编译输入）**：依赖版本已确定、资源已解析、可直接交给 Compiler 的输入。
_Avoid_: HTTP 请求、持久化 Schema

**Configuration Candidate（配置候选）**：编译或审计阶段产生的配置。存在候选不表示校验成功或允许发布。
