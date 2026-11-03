# #20 历史规则回滚验收

验收日期：2026-11-04（Asia/Shanghai）。范围依据 [#20](https://github.com/wangyingang/sing-box-config-manager/issues/20)、父 Spec #14 的 AC17 及 ADR 0006。[机器证据](issue-20.evidence.json) 分别保存公开 GitHub 回滚与受控真实客户端的结果。

## 回滚入口与保护

`rollbackRules`／CLI `rollback --activation <完整历史激活 commit>` 选择保留的历史版本。历史 `stable/activation.json` 必须存在，候选 ID、证据 URL、完整订阅契约、稳定文件集合及摘要须相符。重新下载候选来源、Manifest、Conversion Report、构建记录和 JSON／SRS，复核实际摘要、字节数、非空 term、用途及能力，并通过真实 1.14.4 编译、解码、加载和 SRS 字节比对。过去的成功标记不能独立放行。

回滚与普通激活共用提交实现：检查预期旧 head，以单次提交更新稳定文件和激活记录，拒绝覆盖并发激活；提交回复丢失时核实 attempted commit，不重复写入。回滚记录保存 `operation: rollback`、历史 commit、历史激活 ID、候选与此次原生验证身份。历史产物、Manifest、原有验证记录保持原样；回滚不重新转换来源、不查询 Release、不写 `update-state.json`，也不重新发布配置。

## 公开官方候选回滚

`test/acceptance/rollback.test.ts` 在新建的 `acceptance-issue-20` 分支执行，未写入生产分支。复用 #18 已发布的官方 Release `20261102130044`，候选 `6e76b4ef-883c-46d1-8058-ef3f803b347b`，输入摘要 `bfa4ab62d0f47216029ce6b777a2364978c3f28086060b592453684a0dd830ee`。

- 历史激活：[fbbf055f00dbaf98cb0cb674269905e5981dec07](https://github.com/wangyingang/sing-box-rule-artifacts/commit/fbbf055f00dbaf98cb0cb674269905e5981dec07)。
- 随后的当前激活：`6df00a10c1d7b37d13511c8940356edd784a7182`。
- 回滚提交：[150cdc2555aba1d1339537e0248bddc31af0895b](https://github.com/wangyingang/sing-box-rule-artifacts/commit/150cdc2555aba1d1339537e0248bddc31af0895b)。[激活记录](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/150cdc2555aba1d1339537e0248bddc31af0895b/stable/activation.json) 指向上述历史激活及候选。
- 回滚后历史稳定文件及激活记录仍与原字节相符；稳定分支 HTTPS 回读的 SRS 为 2164 bytes，SHA-256 `b66a1797d2850ba2c2c632ae6f61cb40184134a3d4bcb584dc07273361c167d5`，JSON 为 6316 bytes，SHA-256 `181b855217d871ed8f0ec40923a8606489c5ffb0fe0b14de3c47aeeb0a5a63d5`。
- 请求不存在的历史 commit 明确拒绝，隔离分支仍为回滚提交。Compiler `compileRecipe` 消费该稳定契约并通过真实 binary check。
- 生产 `main` 前后均为 `ae3cf588169226618eb30271f123c29608eb754a`。

公开验收中的两次激活使用同一官方候选，只证明真实提交、历史选择及 HTTPS 链路。版本间行为差异由下面明确标为 synthetic 的 A／B 测试证明，不把 HTTP 回读或 check 当作客户端更新证据。

## 同一客户端 A → B → A

`test/integration/activation-client.test.ts` 使用正式 `activateRules` 激活 A、B，再通过 `rollbackRules` 选择 A 的历史激活。内存 transport 保存不可变候选与提交，真实 loopback HTTPS 向真实 1.14.4 交付稳定规则。这里的提交身份不是公开 GitHub commit。

| 阶段 | 新 HTTP Route 请求 | 新 DNS TCP 请求 |
| --- | --- | --- |
| A | `route-fallback-A` | `192.0.2.10` |
| B 更新后 | `route-matched-B` | `192.0.2.20` |
| 回滚 A 更新后 | `route-fallback-A` | `192.0.2.10` |

同一 PID、同一 Compiler 配置及配置字节，过程中不改 Recipe、不重新发布配置、不重启客户端。DNS 缓存关闭，使用新连接及新 DNS 请求。测试用 `1s` 周期、CA 和 HTTPS 隧道只属于隔离进程，不修改 hosts、系统信任或实际客户端设置。临时进程和服务已清理。

## 拒绝、状态保护与回归

历史回滚测试覆盖缺失激活记录、缺失产物、摘要损坏、摘要同步修改后的坏 SRS、合法空 JSON、契约不兼容、陈旧 expected-head、历史稳定文件损坏。拒绝均在写入前发生，当前 head 和写入次数不变。成功回滚逐字节比较原存储中的全部候选、Manifest、验证与历史激活文件；CLI 测试核对 `update-state.json` 保持原样且独立写入 `active-version.json`。

回滚还注入回复丢失但已应用、结果未知、被其他提交替代及提交后回读待完成，检查与 #19 相同的分类和仅一次写入。回滚与激活竞争同一旧 head 时只允许一个提交成功。既有候选门禁、订阅约束及 transport 回归保持通过。

实际执行：

- Node 24.15.0、pnpm 10.33.2：`pnpm check`，Compiler 96 项、Pipeline 89 项，共 185 项通过；typecheck、build、workspace smoke 通过。
- `SING_BOX_TEST_BINARY=/Users/wangyg/.sbvm/versions/v1.14.4/sing-box-1.14.4-darwin-arm64/sing-box pnpm test:integration`，Compiler 27 项、Pipeline 66 项，共 93 项通过，无跳过。
- 指定 `RULE_ACTIVATION_BRANCH=acceptance-issue-20`、已发布候选、起始 head、证据路径及真实 binary，执行 `test/acceptance/rollback.test.ts`，1 项通过，无跳过。可通过 `pnpm --dir packages/rule-set-pipeline test:rollback` 复现；须使用已有隔离分支、其当前 head 和不存在的证据输出文件。该验收会在隔离分支新增两次激活与一次回滚。
- `git diff --check` 通过；检查日志 SHA-256 及统计保留于机器证据。

未修改生产入口、实际客户端配置或全局 binary；原工作区保持原状。未重新转换或发布官方来源，未执行实际设备全面验收、#21 的故障／缓存验收或 PR 合并。GitHub 缓存和客户端轮询存在传播延迟，受控更新周期不代表所有设备的更新时间保证。
