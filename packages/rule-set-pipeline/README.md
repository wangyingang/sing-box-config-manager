# Rule Set Pipeline

包名：`@sing-box-config-manager/rule-set-pipeline`。已实现 [#15](https://github.com/wangyingang/sing-box-config-manager/issues/15) 的固定 V2Fly Release 域名 JSON 构建。父 [Spec #14](https://github.com/wangyingang/sing-box-config-manager/issues/14) 的 SRS、原生验证、候选发布、激活和自动更新尚未交付。验收记录见 [#15 本地验证](docs/verification/issue-15.md)。

## 本地构建

使用 Node.js ≥24、pnpm 10.33.2。仓库根目录执行：

```sh
pnpm --dir packages/rule-set-pipeline build:release --release 20261102130044 --out /tmp/ai-rules-first
pnpm --dir packages/rule-set-pipeline build:release --release 20261102130044 --out /tmp/ai-rules-repeat --expected-source /tmp/ai-rules-first/source.json
```

`--out` 必须是尚不存在的目录，其父目录必须已存在。已有目录直接拒绝，避免覆盖历史或把失败结果混入旧产物。`--expected-source` 可核对既有来源记录的 Release、commit、资产身份和实际输入摘要；变化时失败。CLI 不查询 latest。公开 API 受 GitHub 限额约束，可通过已有 `GITHUB_TOKEN` 提供只读认证，凭据不进入产物。

构建从指定官方 Release 解析 tag，并递归解引用 annotated tag 至源码 commit。资产通过固定 ID 下载，核对官方摘要记录的文件名及完整 YAML 的实际字节 SHA-256。

成功目录包含：

- `domains.json`：Source Format v4 的非空域名规则文件。
- `source.json`：repository、Release ID、tag、源码 commit、两份资产的 ID／地址和实际输入摘要。
- `conversion-report.json`：输入、转换、不支持、无效、重复、输出、属性记录、类型和用途计数，以及诊断。
- `build.json`：`built-unvalidated` 状态、来源、工具版本、产物实际字节摘要、字节数和用途映射。

输入或转换失败返回非零退出码，只保存失败报告及已取得的来源，不生成规则文件或成功构建记录。完成记录最后写入。此处的成功只表示本地 JSON 构建完成，不表示已验证 Rule Candidate、成功处理的 Release 或已激活版本。

## 输入与转换边界

公开 Node API 由包入口导出：

- `readRelease(options)`：获取并核验固定来源；失败抛出异常。
- `readTargetList(bytes)`：解码一次 YAML，只提取唯一、非空且声明长度正确的 `category-ai-!cn`；返回带位置的来源记录或诊断。
- `convertRules(records)`：与 YAML 无关的 Rule IR 转换、相等去重和排序；失败不返回部分 Rule IR。
- `renderDomainJson(terms)`：将成功转换的 Rule IR 写成 v4 JSON；拒绝空集合。
- `buildRelease(options)`：组合以上步骤，返回成功构建或失败报告，不执行发布。

`domain/full/keyword/regexp` 分别映射为 `domain_suffix/domain/domain_keyword/domain_regex`。每种谓词单独放在一条 Headless Rule 中，规则集合保持 OR 语义。只对同类型、同值去重，按上述类型顺序和字符串代码单元顺序排序。

非正则值的 `:@attr1,@attr2` 尾部被分离；属性记录仍转换，不在本地筛选。regexp 保留表达式；字面 `:@` 导致失败。保留大小写、Unicode、尾点和正则转义，不执行 IDNA 或表达式改写。空值、非法字符、域名空 label／非法边界／超长 label 均失败。正则不使用 JavaScript 引擎预判，目标 Go 引擎检查由 #16 完成。

YAML 解析使用固定版本的 [yaml](https://eemeli.org/yaml/)，拒绝语法错误、重复 key、未知 tag、多个文档和 alias。记录级诊断包含文件、列表、从零开始的记录 index，以及从一开始的 line／column。列表级诊断以文件与目标列表定位。

纯域名文件同时供 Route 和 DNS 请求复用。DNS 响应用途为 `{ status: "unavailable", reason: "empty" }`，不生成空匹配文件。`build.json` 是本地构建记录，不能作为 Compiler 的 Artifact Manifest 使用。[固定产物 Manifest v1](contracts/README.md) 继续保持原有契约，Compiler 不导入 Pipeline 运行时代码。

## 自动化验证

```sh
pnpm --dir packages/rule-set-pipeline test
pnpm --dir packages/rule-set-pipeline test:release
pnpm check
```

常规测试离线运行，纳入现有 `pnpm check` 和 CI。固定样本包含官方目标列表原文摘录、完整资产的来源身份及预期 JSON；摘录不能代替完整资产摘要校验。`test:release` 需联网，通过真实 CLI 两次下载完整固定 Release，核对完整来源、实际产物摘要及确定性，不随 latest 漂移。网络错误、限额或来源变化会使验收失败。

`pnpm build` 输出 Node ESM 和 TypeScript 声明至 `dist/`。本包不提供浏览器运行时，不引入 Compiler 依赖。
