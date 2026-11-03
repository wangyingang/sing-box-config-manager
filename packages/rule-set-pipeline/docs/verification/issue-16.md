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

版本 `1.14.4`，Go `go1.26.10`，平台 `darwin/arm64`，revision `c005f35300ce76427dc285481ec5695f5b179cd2`，binary SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。未运行 `sbvm use`，没有切换或替换全局 binary。CLI 构建身份 `72bbeccb72bd286594d5dac19bb924d5268d3df421950918e36555bb84062cea` 关联来源、转换工具和 native 构建身份；不同平台的 binary 摘要可能不同。

## 原生行为与失败边界

每份非空投影均执行真实 `rule-set compile`、`decompile` 及 JSON／SRS 两种格式的 `rule-set match`。解码结果转换为独立 OR term 后比较，允许解码器降低 Source Format 版本或把单值数组改为字符串。未知字段、逻辑规则和混合 AND 字段不被错误地扁平化。`match` 会真实读取并初始化 Headless Rule，能发现仅编译未必发现的非法 Go regexp；没有以配置 `check` 替代规则加载。

合成语义样本通过两种文件验证：domain apex／子域命中、相似后缀及后缀外延不命中；full 精确命中及子域不命中；keyword 不依赖 label 边界；regexp 保持锚点及表达式大小写。1.14.4 会在匹配正则前把请求域名转小写，但不改写表达式：大写字面表达式对大小写请求均不命中，小写表达式对相应请求命中，`(?i)` 显式不区分大小写。对应[目标版本源码](https://github.com/SagerNet/sing-box/blob/v1.14.4/route/rule/rule_item_domain_regex.go)与本次实测一致。

通过构建 API 注入纯 IPv4／IPv6 及域名／IP 混合 IR：DNS 请求仅含域名，DNS 响应仅含目标 `ip_cidr`，Route 保留两者；纯 IP 的 Route／DNS 响应复用文件。JSON 和 SRS 均通过匹配正反例。生产 V2Fly reader 和语法没有增加 IP 来源。

固定真实摘录还独立构建两次，第二次逆序枚举 IR，JSON／SRS、摘要和 native 构建身份一致。非法 regexp／CIDR、零有效内容、缺失／相对路径／不可用 binary 和错误版本明确失败；编译、解码、加载失败与解码语义被篡改均不会返回通过状态。故障 wrapper 只用于测试失败分支，不是成功验收 binary。真实 CLI 在取得来源后使用不存在的 binary，输出目录仅含来源、转换报告和失败记录，没有规则文件或 `build.json`。

## 已执行检查

本机默认 pnpm 为其他主版本，实际使用 `npx --yes pnpm@10.33.2` 运行仓库锁定版本，不修改全局版本。以下为 worktree 根目录命令；`<binary>` 为上面的绝对路径。

| 命令 | 结果 |
| --- | --- |
| `npx --yes pnpm@10.33.2 check` | Pipeline 49 项、Compiler 81 项通过；类型检查、构建与 workspace smoke 通过 |
| `SING_BOX_TEST_BINARY=<binary> npx --yes pnpm@10.33.2 test:integration` | Pipeline 8 项、既有 Compiler 26 项通过，无失败或跳过 |
| `SING_BOX_TEST_BINARY=<binary> npx --yes pnpm@10.33.2 --dir packages/rule-set-pipeline test:release` | 1 项通过；完整来源下载、两次独立构建、摘要／字节核对及失败目录检查 |
| `git diff --check` | 通过 |

真实 Release 第一次匿名获取返回 HTTP 403，明确失败；以现有 gh 凭据在进程环境内提供 `GITHUB_TOKEN` 后通过。凭据未写入产物或证据。现有 CI 的 native job 已安装固定且校验摘要的 1.14.4，并调用根 `test:integration`，新增 Pipeline native 脚本随之纳入；本机通过不代表远程 CI 已执行。

## 尚未执行及范围

没有发布 Artifact Manifest 或远程候选，没有激活／回滚稳定入口，没有客户端自动更新、缓存重启或生产设备行为验收。它们分别由 #18 及后续工单完成，不能据本地 `built-validated` 推断父 Spec 已完成。本分支不包含 #17 的代码，不更改 Compiler、订阅契约、父 Spec 或其他工单。

## 交付审查

首次交付按 `code-review` 流程以 `0c92452...8d74428` 分别执行 Standards／Spec 审查；根 README 状态问题已修复。当时的 108 条实际匹配记录未覆盖相邻 CIDR 和 term 字段顺序。随后针对 PR #23 的复审发现以下两项 P2，本次已补充回归并修复；首次审查的无遗留结论不能代替这些边界的验证。


## PR #23 两项 P2 修复验收

修复基线 `8d744288ac1c1947663446a2e899d5bf937225ac`。先加入公开 `buildNative` 边界的回归测试；指定同一真实 1.14.4 binary 执行，两项均因 `Semantic round trip failed` 失败，修复后全部通过。机器证据的 `beforeFix` 保存执行命令与失败结果；`native` 中的 `regression` 记录保存修复后的实际结果。

- term 规范化固定复制为 `{type, value}`，字段顺序与枚举顺序不再改变构建结果。原字段顺序与反向字段／枚举顺序分别构建，所有 JSON／SRS 字节、元数据、用途映射和构建身份一致。
- CIDR 仅在比较层转换为精确地址区间集合；使用 Pipeline 显式依赖的既有锁定版本 `ipaddr.js 2.5.0` 解析，不依赖 Compiler 运行时代码。IPv4 的两个 `/25` 与 IPv6 的两个 `/33` 经真实解码归并为 `/24`／`/32`，纯 IP 和混合 IR 均通过。JSON 仍保留四条原始 IP term；SRS 实际解码为两条。对应两种文件分别记录实际 term 数；混合 Route 的 JSON／SRS 分别为 5／3 条。
- 按 IPv4 两个半段、网段边缘、网段外地址及 IPv6 两个半段执行两种文件格式的真实匹配；纯 IP 与混合 IR 各自逆序重复构建，字节及身份一致。新增 80 条匹配结果，总计 188 条，全部符合预期。
- 故障注入将解码 IPv4 扩大为 `/23`、丢失 IPv4 半段或丢失 IPv6 半段，三种情况仍拒绝构建。独立比较测试另覆盖包含／重复网段、IPv6 文本表示、完整地址空间、单 IP、集合缺口和地址族变化；没有将不等价内容放行。

原生验证策略升级为 `native-projection-v2`，构建身份随之更新，避免将不同验证策略标为同一构建。真实官方样本仍为 214 个 term；JSON／SRS 的字节、摘要和大小与上述表格一致。

本次重新执行完整 `pnpm check`（49 + 81 项）、指定绝对 binary 的全仓库 native 集成（8 + 26 项）及联网 `test:release`（1 项），均通过，无失败或跳过。联网验收重新下载完整固定 Release 两次，逐字节核对两种产物，不使用首次运行结果代替本次验证。根锁文件只增加 Pipeline 对现有 `ipaddr.js 2.5.0` 的直接依赖，没有改变 Compiler importer、任何 #17 文件或共享订阅契约。

修复后以 `8d74428...HEAD` 执行独立 Standards／Spec 两轴复核，均为 0 项 finding。Standards 审查者另行运行 3 项语义比较测试通过；两位审查者均只核对既有完整 native／Release 执行证据，没有把证据审阅表述为独立重跑。
