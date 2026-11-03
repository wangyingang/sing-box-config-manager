# #16 确定性 JSON／SRS 与原生验证

2026-11-04，实施 [#16](https://github.com/wangyingang/sing-box-config-manager/issues/16)，覆盖父 [Spec #14](https://github.com/wangyingang/sing-box-config-manager/issues/14) 的 AC05、AC08、AC09 和 AC06／AC07 的构建及投影部分。基线 `0c92452` 已包含 #15，工作位于同级独立 worktree `sing-box-config-manager-issue-16`、分支 `codex/issue-16`。

机器可读的[执行证据](issue-16.evidence.json)包含完整来源、binary version 输出与摘要、产物摘要、原生命令、真实匹配预期和实测结果。证据来自本次实际执行，不是预期模板。

## 实际来源与构建结果

完整官方 Release `20261102130044` 通过 CLI 独立下载两次，第二次以第一份 `source.json` 核对来源。Release ID `431467724`、源码 commit `328f6c5168653e809561c862757c966fc5012e5d`，YAML／摘要资产 ID `701778045`／`701778047`。实际 YAML 为 3758877 字节，SHA-256 `bfa4ab62d0f47216029ce6b777a2364978c3f28086060b592453684a0dd830ee`。两次构建的 JSON／SRS 逐字节一致。

| 产物 | 字节数 | term 数 | 实际 SHA-256 |
| --- | --- | --- | --- |
| `domains.json` | 6316 | 214 | `181b855217d871ed8f0ec40923a8606489c5ffb0fe0b14de3c47aeeb0a5a63d5` |
| `domains.srs` | 2164 | 214 | `b66a1797d2850ba2c2c632ae6f61cb40184134a3d4bcb584dc07273361c167d5` |

Conversion Report：214 条输入全部转换，13 条属性记录全部保留，无不支持、无效、重复或静默丢弃。Route 与 DNS 请求复用 `domains.json`／`domains.srs`；DNS 响应为 `unavailable: empty`，没有生成空文件。两份文件均声明 `requiredCapabilities: []`。

使用明确 binary：

```text
/Users/wangyg/.sbvm/versions/v1.14.4/sing-box-1.14.4-darwin-arm64/sing-box
```

版本 `1.14.4`，Go `go1.26.10`，平台 `darwin/arm64`，revision `c005f35300ce76427dc285481ec5695f5b179cd2`，binary SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。未运行 `sbvm use`，没有切换或替换全局 binary。CLI 构建身份 `e93b8baf0a37d2271c8614b2ac4cef0184db06fd3b9c95e9dcf9bc2e69f711f2` 关联来源、转换工具和 native 构建身份；不同平台的 binary 摘要可能不同。

## 原生行为与失败边界

每份非空投影均执行真实 `rule-set compile`、`decompile` 及 JSON／SRS 两种格式的 `rule-set match`。解码结果转换为独立 OR term 后比较，允许解码器降低 Source Format 版本或把单值数组改为字符串。未知字段、逻辑规则和混合 AND 字段不被错误地扁平化。`match` 会真实读取并初始化 Headless Rule，能发现仅编译未必发现的非法 Go regexp；没有以配置 `check` 替代规则加载。

合成语义样本通过两种文件验证：domain apex／子域命中、相似后缀及后缀外延不命中；full 精确命中及子域不命中；keyword 不依赖 label 边界；regexp 保持锚点及表达式大小写。1.14.4 会在匹配正则前把请求域名转小写，但不改写表达式：大写字面表达式对大小写请求均不命中，小写表达式对相应请求命中，`(?i)` 显式不区分大小写。对应[目标版本源码](https://github.com/SagerNet/sing-box/blob/v1.14.4/route/rule/rule_item_domain_regex.go)与本次实测一致。

通过构建 API 注入纯 IPv4／IPv6 及域名／IP 混合 IR：DNS 请求仅含域名，DNS 响应仅含目标 `ip_cidr`，Route 保留两者；纯 IP 的 Route／DNS 响应复用文件。JSON 和 SRS 均通过匹配正反例。生产 V2Fly reader 和语法没有增加 IP 来源。

固定真实摘录还独立构建两次，第二次逆序枚举 IR，JSON／SRS、摘要和 native 构建身份一致。非法 regexp／CIDR、零有效内容、缺失／相对路径／不可用 binary 和错误版本明确失败；编译、解码、加载失败与解码语义被篡改均不会返回通过状态。故障 wrapper 只用于测试失败分支，不是成功验收 binary。真实 CLI 在取得来源后使用不存在的 binary，输出目录仅含来源、转换报告和失败记录，没有规则文件或 `build.json`。

## 已执行检查

本机默认 pnpm 为其他主版本，实际使用 `npx --yes pnpm@10.33.2` 运行仓库锁定版本，不修改全局版本。以下为 worktree 根目录命令；`<binary>` 为上面的绝对路径。

| 命令 | 结果 |
| --- | --- |
| `npx --yes pnpm@10.33.2 check` | Pipeline 46 项、Compiler 81 项通过；类型检查、构建与 workspace smoke 通过 |
| `SING_BOX_TEST_BINARY=<binary> npx --yes pnpm@10.33.2 test:integration` | Pipeline 5 项、既有 Compiler 26 项通过，无失败或跳过 |
| `SING_BOX_TEST_BINARY=<binary> npx --yes pnpm@10.33.2 --dir packages/rule-set-pipeline test:release` | 1 项通过；完整来源下载、两次独立构建、摘要／字节核对及失败目录检查 |
| `git diff --check` | 通过 |

真实 Release 第一次匿名获取返回 HTTP 403，明确失败；以现有 gh 凭据在进程环境内提供 `GITHUB_TOKEN` 后通过。凭据未写入产物或证据。现有 CI 的 native job 已安装固定且校验摘要的 1.14.4，并调用根 `test:integration`，新增 Pipeline native 脚本随之纳入；本机通过不代表远程 CI 已执行。

## 尚未执行及范围

没有发布 Artifact Manifest 或远程候选，没有激活／回滚稳定入口，没有客户端自动更新、缓存重启或生产设备行为验收。它们分别由 #18 及后续工单完成，不能据本地 `built-validated` 推断父 Spec 已完成。本分支不包含 #17 的代码，不更改 Compiler、订阅契约、父 Spec 或其他工单。
