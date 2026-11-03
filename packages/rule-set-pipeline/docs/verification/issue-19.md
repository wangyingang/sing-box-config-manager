# #19 显式激活与客户端自动更新验收

验收日期：2026-11-04（Asia/Shanghai）。范围依据 [#19](https://github.com/wangyingang/sing-box-config-manager/issues/19)、父 [Spec #14](https://github.com/wangyingang/sing-box-config-manager/issues/14) 及 ADR 0006。[机器证据](issue-19.evidence.json) 分开保存真实公开激活和受控客户端更新结果。

## 真实官方候选与稳定 HTTPS

本次复用 #18 已实际发布并回读的固定官方候选，没有重新处理 Release 或伪造新的成功处理记录。激活前重新下载来源、报告、Manifest、构建记录及 JSON／SRS，核验回读链和实际字节，并重新执行真实 1.14.4 原生验证。

- Release：`20261102130044`，ID `431467724`；源码 commit `328f6c5168653e809561c862757c966fc5012e5d`。
- 输入 YAML SHA-256：`bfa4ab62d0f47216029ce6b777a2364978c3f28086060b592453684a0dd830ee`。
- 候选：`6e76b4ef-883c-46d1-8058-ef3f803b347b`；[不可变回读记录](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/3f06056ee6f1c6336936d3b1e7b776215c8b2ded/candidates/6e76b4ef-883c-46d1-8058-ef3f803b347b/readback.json)。首次发布的完整输入和 HTTPS 证据保留在 [#18](issue-18.md)。
- 隔离分支：`acceptance-issue-19`，从 `ae3cf588169226618eb30271f123c29608eb754a` 开始。
- 最终激活 commit：[4208b055c9690495eb500b26a9129d3e3a7e69c5](https://github.com/wangyingang/sing-box-rule-artifacts/commit/4208b055c9690495eb500b26a9129d3e3a7e69c5)（预期旧 head 为首次激活 `8b1118eb8060d65ac0da5a1aba6dff05d456654b`）。一次提交更新 JSON、SRS 和 [激活记录](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/4208b055c9690495eb500b26a9129d3e3a7e69c5/stable/activation.json)。
- [稳定 SRS](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/acceptance-issue-19/stable/v2fly/category-ai-not-cn/domains.srs)：2164 bytes，SHA-256 `b66a1797d2850ba2c2c632ae6f61cb40184134a3d4bcb584dc07273361c167d5`。
- [稳定 JSON](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/acceptance-issue-19/stable/v2fly/category-ai-not-cn/domains.json)：6316 bytes，SHA-256 `181b855217d871ed8f0ec40923a8606489c5ffb0fe0b14de3c47aeeb0a5a63d5`。

`test/acceptance/activation.test.ts` 完成真实 GitHub 激活、完整 commit 和稳定分支 HTTPS 字节核验，通过公开 `compileRecipe` 生成稳定 SRS 配置，并用真实 1.14.4 检查。Compiler 配置 SHA-256、完整配置和产物身份见机器证据。此处证明实际发布链路；不把 HTTP 200 或配置检查当成自动更新行为证据。

## 受控 A／B 自动更新

`test/integration/activation-client.test.ts` 用明确标为 synthetic 的 A／B 候选调用同一正式 `activateRules`。该测试使用内存提交 transport 和真实 loopback HTTPS，候选和提交身份不是公开 GitHub commits。HTTPS 只交付激活后的稳定文件，临时 CA 仅由测试配置信任，HTTP 隧道仅在受控进程内转接规则下载。

Compiler 只生成一次配置；启动前一次性设置测试用 `update_interval: 1s`。运行期间不修改 Recipe、配置文件或配置发布，不重启客户端。测试比较 PID、运行状态和配置字节，使用同一真实 sing-box 1.14.4 实例发起新请求。

| 阶段 | 新 HTTP Route 请求 | 新 DNS TCP 请求 |
| --- | --- | --- |
| A：不匹配 `updated.issue19.test` | `route-fallback-A` | `192.0.2.10` |
| 正式激活 B 并由客户端自动更新后 | `route-matched-B` | `192.0.2.20` |

两种请求在相同进程与配置下均出现预期变化。证据记录实际 PID、配置 SHA-256、A／B 候选、激活身份及两次观察时间。测试关闭 DNS 缓存并新建请求，避免已有连接或缓存答案掩盖行为。配置内 CA、测试周期、临时服务和进程在验收后清理，不修改 hosts、系统信任、生产入口或实际客户端。

## 门禁、并发与不确定结果

26 项真实 binary 激活集成测试覆盖：完整候选成功；缺失来源和证据、摘要错配、全部摘要同步修改后的坏 SRS、合法空内容、虚假通过标记、错误转换报告、来源缺失、目标版本、用途、term 数、能力及订阅不兼容均拒绝写入；合成来源禁止进入生产分支。

同一预期旧 head 的并发请求只有一个成功，旧 head 无法覆盖。注入提交未生效、回复丢失但已生效、远端不可达、其他提交替代以及提交后 HTTPS 回读失败，分别核实并报告结果，不执行重复写入。失败后复用原候选重试成功，历史候选和 Release 成功处理记录不变。后续激活也拒绝改变已交付订阅契约。

28 项 transport 单元测试核对 GitHub 请求：只用预期旧 head 为父提交，一次 tree 更新稳定文件与激活记录，PATCH `force:false`；拒绝非法路径、并发 head 变化及私有仓库，PATCH 回复丢失保留 attempted commit；用完整 Git tree／blob 核实旧激活记录，API 故障、截断、非 blob／符号链接、错误编码或长度均拒绝。旧记录包含 `Readback HTTP 404:` 文本也不能被当作缺失。

## 回归与边界

实际执行并通过：

- Node 24.15.0、pnpm 10.33.2：`pnpm check`。Pipeline 84 项、Compiler 96 项测试全部通过，typecheck、build 和 workspace smoke 通过。
- 指定安装路径的真实 1.14.4：`SING_BOX_TEST_BINARY=... pnpm test:integration`。Pipeline 52 项（含 26 项激活门禁和 1 项 A／B 客户端测试）、Compiler 27 项全部通过，无跳过。
- 显式提供隔离分支、候选 URL、预期旧 head 和证据路径：`pnpm --dir packages/rule-set-pipeline test:activation`，1 项通过。执行参数含义见包 README；输出文件须不存在，重跑前核对实际远端 head。
- `git diff --check` 通过。检查日志摘要与 SHA-256 保存在机器证据。

产物仓库生产 `main` 前后均为 `ae3cf588169226618eb30271f123c29608eb754a`。原工作区保持 `main`，未编辑；全局 sing-box 未切换。测试分支保留用于复核。

未执行生产切换、实际设备全面验收、回滚及客户端故障／缓存恢复；后两者属于 #20、#21。未重新执行已由 #15／#16／#18 保存的完整 Release 构建／发布验收；本次重新读取并校验其已发布候选。GitHub 缓存和客户端轮询存在延迟，1s 测试条件不构成全部设备更新时限承诺。

## 双轴审查

固定比较基线 `3258f8a376f4da0c7c018ea13fd4a66150bf4629`，实现提交 `23e22c1`。Standards 与 Spec 由独立 subagents 分别审查完整 diff，均为 0 项发现。Standards 独立执行 `git diff --check`；Spec 独立重跑 16 项 transport 与 25 项真实 binary 激活测试，共 41 项全部通过，无跳过。审查未重复执行外部写入；官方激活和 A／B 更新部分复核已保存证据与测试实现。

首次 PR 原生 CI 在干净 checkout 中发现跨包测试过早加载尚未生成的 Compiler validator。已通过测试用 workspace devDependency 建立执行顺序，并在集成与验收脚本显式准备 validator；移除本地 generated 文件后重跑全部原生测试通过。Pipeline 运行时代码仍不导入 Compiler。随后补强旧激活记录读取，并在已激活的同一隔离分支再次完成真实官方候选验收。最终回归为常规 180 项、原生 79 项，全部通过。
