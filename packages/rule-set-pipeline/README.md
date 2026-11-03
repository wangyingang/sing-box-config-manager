# Rule Set Pipeline

包名：`@sing-box-config-manager/rule-set-pipeline`。已实现 [#15](https://github.com/wangyingang/sing-box-config-manager/issues/15) 的固定来源转换，以及 [#16](https://github.com/wangyingang/sing-box-config-manager/issues/16) 的确定性 JSON／SRS、本地原生验证和用途投影。父 [Spec #14](https://github.com/wangyingang/sing-box-config-manager/issues/14) 的候选发布、激活和自动更新尚未交付。验收记录见 [#15](docs/verification/issue-15.md) 和 [#16](docs/verification/issue-16.md)。

## 本地构建

使用 Node.js ≥24、pnpm 10.33.2。仓库根目录执行：

```sh
pnpm --dir packages/rule-set-pipeline build:release --binary /absolute/path/to/sing-box-1.14.4 --release 20261102130044 --out /tmp/ai-rules-first
pnpm --dir packages/rule-set-pipeline build:release --binary /absolute/path/to/sing-box-1.14.4 --release 20261102130044 --out /tmp/ai-rules-repeat --expected-source /tmp/ai-rules-first/source.json
```

`--binary` 必须明确提供绝对路径。构建检查版本恰为 1.14.4，记录完整 version 输出、真实路径及 binary SHA-256；不调用 PATH 中的默认 sing-box，不切换全局版本。缺失、不可执行或版本错误均失败。

`--out` 必须是尚不存在的目录，其父目录必须已存在。已有目录直接拒绝，避免覆盖历史或把失败结果混入旧产物。`--expected-source` 可核对既有来源记录的 Release、commit、资产身份和实际输入摘要；变化时失败。CLI 不查询 latest。公开 API 受 GitHub 限额约束，可通过已有 `GITHUB_TOKEN` 提供只读认证，凭据不进入产物。

构建从指定官方 Release 解析 tag，并递归解引用 annotated tag 至源码 commit。资产通过固定 ID 下载，核对官方摘要记录的文件名及完整 YAML 的实际字节 SHA-256。

成功目录包含：

- `domains.json`／`domains.srs`：Source Format v4 JSON 和真实 1.14.4 编译的非空 SRS。
- `source.json`：repository、Release ID、tag、源码 commit、两份资产的 ID／地址和实际输入摘要。
- `conversion-report.json`：输入、转换、不支持、无效、重复、输出、属性记录、类型和用途计数，以及诊断。
- `build.json`：`built-validated` 状态、来源、工具版本、binary 身份、构建身份、每份产物的实际 SHA-256／字节数／term 数／能力要求，以及用途映射和原生命令验证记录。域名及目标 IP 不要求额外 Profile 能力，`requiredCapabilities` 为 `[]`。

输入、转换或原生验证失败返回非零退出码，只保存诊断及已取得的来源，不生成通过状态。原生验证在临时目录完成，全部通过才写入产物；`build.json` 最后写入。写入中断可能留下不完整目录，没有完成记录就不能交付。此处的成功仅表示本地验证通过，不表示已发布 Rule Candidate、成功处理的 Release 或已激活版本。构建身份关联来源、转换工具版本、规范化 IR、原生策略 `native-projection-v1` 和 binary 摘要。运行时间、临时路径和验证日志不进入规则文件。

## 输入与转换边界

公开 Node API 由包入口导出：

- `readRelease(options)`：获取并核验固定来源；失败抛出异常。
- `readTargetList(bytes)`：解码一次 YAML，只提取唯一、非空且声明长度正确的 `category-ai-!cn`；返回带位置的来源记录或诊断。
- `convertRules(records)`：与 YAML 无关的 Rule IR 转换、相等去重和排序；失败不返回部分 Rule IR。
- `renderDomainJson(terms)`：将成功转换的 Rule IR 写成 v4 JSON；拒绝空集合。
- `buildRelease(options)`：保留 #15 的输入／转换接口，返回 `built-unvalidated` JSON 或失败报告，不执行原生验证或发布。
- `projectTerms(terms)`／`renderRuleJson(terms)`：固定排序、相等去重及 Route／DNS 请求／DNS 响应投影，拒绝零有效内容。`BuildTerm` 另允许合成目标 `ip_cidr`；不增加 V2Fly IP 语法或输入源。
- `buildNative(terms, absoluteBinary)`：编译、解码、规范化语义比较及真实加载；返回已验证的内存字节、元数据和验证记录，失败抛出异常。CLI 组合 `buildRelease` 与 `buildNative`。
- `decodedTerms(value)`：将支持的平铺 OR 规则还原为排序、去重的 term；容忍解码器的 Source Format 版本和单值表示差异，拒绝逻辑规则、混合 AND 字段及未知字段。

`domain/full/keyword/regexp` 分别映射为 `domain_suffix/domain/domain_keyword/domain_regex`。每种谓词单独放在一条 Headless Rule 中，规则集合保持 OR 语义。只对同类型、同值去重，按上述类型顺序和字符串代码单元顺序排序。

非正则值的 `:@attr1,@attr2` 尾部被分离；属性记录仍转换，不在本地筛选。regexp 保留表达式；字面 `:@` 导致失败。保留大小写、Unicode、尾点和正则转义，不执行 IDNA 或表达式改写。空值、非法字符、域名空 label／非法边界／超长 label 均失败。正则不使用 JavaScript 引擎预判，目标 Go 引擎由原生加载步骤检查。1.14.4 在 regexp 匹配前将请求域名转为小写，但不改写表达式；大写字面表达式不会因此变成大小写无关。

YAML 解析使用固定版本的 [yaml](https://eemeli.org/yaml/)，拒绝语法错误、重复 key、未知 tag、多个文档和 alias。记录级诊断包含文件、列表、从零开始的记录 index，以及从一开始的 line／column。列表级诊断以文件与目标列表定位。

每个非空用途分别生成 JSON／SRS，内容相同的用途复用同一组物理文件。纯域名文件同时供 Route 和 DNS 请求复用。纯 IP 的 Route／DNS 响应同样复用，混合 IR 分别输出三组文件。DNS 响应用途为 `{ status: "unavailable", reason: "empty" }`，不生成空匹配文件。`build.json` 是本地构建记录，不能作为 Compiler 的 Artifact Manifest 使用。[固定产物 Manifest v1](contracts/README.md) 继续保持原有契约，Compiler 不导入 Pipeline 运行时代码。

## 自动化验证

```sh
pnpm --dir packages/rule-set-pipeline test
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 pnpm --dir packages/rule-set-pipeline test:integration
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 pnpm --dir packages/rule-set-pipeline test:release
pnpm check
```

常规测试离线运行，纳入现有 `pnpm check` 和 CI。固定样本包含官方目标列表原文摘录、完整资产的来源身份及预期 JSON；摘录不能代替完整资产摘要校验。`test:release` 需联网，通过真实 CLI 两次下载完整固定 Release，核对完整来源、两种文件的实际字节摘要及确定性，并验证原生失败没有完成记录，不随 latest 漂移。网络错误、限额或来源变化会使验收失败。

`test:integration` 使用固定真实样本和合成 IR，通过 `rule-set match` 实际读取、初始化并匹配 JSON／SRS。非法 Go regexp 会在此被拒绝，不能以编译或配置 `check` 代替加载。测试覆盖域名边界、regexp 大小写、IPv4／IPv6 投影、独立构建确定性及编译／解码／加载／语义错配故障；现有 native CI 自动执行此脚本。

`pnpm build` 输出 Node ESM 和 TypeScript 声明至 `dist/`。本包不提供浏览器运行时，不引入 Compiler 依赖。
