# #15 固定 V2Fly Release 本地 JSON 构建验收

2026-11-03，实施 [#15](https://github.com/wangyingang/sing-box-config-manager/issues/15)，对应父 [Spec #14](https://github.com/wangyingang/sing-box-config-manager/issues/14) 的来源校验和域名 JSON 转换部分。未执行 SRS 编译、原生加载或远程发布；本地完成状态为 `built-unvalidated`，不生成成功处理记录或已验证候选。

## 真实来源与产物

实际联网下载两次固定官方 Release 的完整 YAML 与摘要文件，通过 CLI 构建并核对字节一致性。源码 commit 从 tag 解析，没有使用浮动分支。下载通过固定资产 ID 完成。

| 项目 | 实际值 |
| --- | --- |
| repository | `v2fly/domain-list-community` |
| Release ID／tag | `431467724`／`20261102130044` |
| 源码 commit | `328f6c5168653e809561c862757c966fc5012e5d` |
| YAML／摘要资产 ID | `701778045`／`701778047` |
| YAML 实际字节数 | `3758877` |
| YAML SHA-256 | `bfa4ab62d0f47216029ce6b777a2364978c3f28086060b592453684a0dd830ee` |
| 目标列表 | `category-ai-!cn` |
| JSON 字节数／term 数 | `6316`／`214` |
| JSON SHA-256 | `181b855217d871ed8f0ec40923a8606489c5ffb0fe0b14de3c47aeeb0a5a63d5` |
| 构建工具 | Pipeline `0.1.0`、policy `v2fly-domain-v1`、Node `26.13.0`、yaml `2.9.1`、Source Format `4` |

来源身份和两份资产地址保存在 [source.json](../../test/fixtures/20261102130044.source.json)，[JSON](../../test/fixtures/20261102130044.domains.json) 与 [Conversion Report](../../test/fixtures/20261102130044.conversion-report.json) 可独立检查。[目标列表原文摘录](../../test/fixtures/20261102130044.category-ai-not-cn.yml)用于离线回归，不是完整摘要对应文件；完整输入的摘要验证由联网验收执行。

报告：`inputCount = convertedCount = outputTermCount = 214`，不支持、无效、重复均为 0；179 个 domain、34 个 full、1 个 regexp；13 条来源记录含属性尾部，全部保留。Route 与 DNS 请求复用同一 JSON，DNS 响应用途为 `unavailable: empty`。214 仅用于固定样本验收，生产构建不以此限制其他 Release。

## 自动化执行

使用仓库固定 pnpm `10.33.2`。环境默认 pnpm 为其他主版本，本次通过临时 PATH 使用固定版本，不修改全局工具。

| 命令 | 结果 |
| --- | --- |
| `pnpm --dir packages/rule-set-pipeline test` | 43 项通过；包括真实目标摘录、合成反例和 CLI 失败／覆盖保护 |
| `pnpm --dir packages/rule-set-pipeline test:release` | 1 项通过；两次真实 CLI 下载与构建，第二次核对首份 source.json，产物字节一致 |
| `pnpm check` | 通过；Pipeline 43 项、Compiler 81 项，类型检查、构建和 workspace smoke 全部通过 |
| `SING_BOX_TEST_BINARY=<installed-1.14.4> pnpm test:integration` | 既有原生集成回归 26 项通过，未改变全局 binary |
| 构建后导入 `dist/src/index.js` | 5 个公开函数可加载 |
| `git diff --check` | 通过 |

联网验收第一次匿名 API 请求返回 HTTP 403，明确失败；复用现有 gh 登录凭据作为进程内 `GITHUB_TOKEN` 后通过。凭据没有写入日志、产物或仓库。

合成验收覆盖四种类型、属性尾部与不筛选、regexp 转义／大小写／字面 `:@`、跨类型相同值、重复 term 和输入逆序；覆盖坏 YAML、非目标区域损坏、多文档、重复 key、未知 tag、alias、无效 UTF-8、缺失／重复／空列表、错误 length、未知类型、非字符串与非法值。来源故障覆盖 HTTP／网络失败、资产缺失／错配、摘要文件名／字节错配、tag 类型／循环及固定来源身份或内容改变。失败报告保留可用计数和记录位置，不返回部分规则文件。

本次测试没有验证目标 Go 正则引擎、Route／DNS 实际匹配或 SRS，这些属于 #16。现有 Compiler 的原生集成通过，只说明既有回归保持有效，不代表 #16 已完成。未更新远程工单或推送代码。
