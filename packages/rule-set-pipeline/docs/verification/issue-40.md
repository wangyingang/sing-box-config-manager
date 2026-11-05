# Issue #40：单集 v2 回滚与同进程客户端换源验收

2026-11-06（Asia/Shanghai），通过 Pipeline 公开操作验证三集独立回滚，通过 Recipe 发布与交付验证运行中的 sing-box 跟随原稳定 URL。范围依据 [#40](https://github.com/wangyingang/sing-box-config-manager/issues/40)、父 Spec [#34](https://github.com/wangyingang/sing-box-config-manager/issues/34) 和 ADR 0006。[机器证据](issue-40.evidence.json)区分真实 GitHub 提交与受控客户端的模拟提交。

## 回滚入口与兼容性

`rollback --config <YAML> --id <logical-id> --activation <historical-commit>` 与 `rollbackRules` 读取所选集的历史 `stablePath/activation.json`，核对逻辑 ID、候选归属及当前完整 v2 订阅。历史构建按原定义校验，来源列表可以不同于当前配置；逻辑 ID、稳定路径及目标分支必须一致。正常激活仍要求候选与当前完整定义一致。

候选证据、Manifest、实际摘要、原生编译／解码／加载及历史稳定文件均重新校验。成功回滚复用受并发保护的激活提交，追加该集历史并保存本地回执。候选、历史提交及其他集的文件、版本和历史保持不变。

## 三个真实样本逐集回滚

`test/acceptance/configured-rollback.test.ts` 固定官方 Release `20261104112839`，在产物仓库隔离分支 `acceptance-issue-40-20261106` 发布并激活 OpenAI、Anthropic、Google DeepMind。随后分别切换为明确标为 synthetic 的可区分候选，再通过真实 CLI 逐集回滚至各自官方历史。

每次从固定 commit HTTPS 地址核对被选集的 JSON／SRS 恢复历史字节且区别于切换后字节；核对另外两集的稳定文件、激活记录、当前版本和历史均不变。最终从无查询参数的原稳定 URL 回读所有恢复后的文件。真实提交与稳定回读记录见机器证据。该验收耗时约 447 秒，1 项通过，无跳过；原稳定 URL 最终回读时间为北京时间 2026-11-06 04:53:43 至 04:53:44。产物仓库生产 `main` 前后均为 `ae3cf588169226618eb30271f123c29608eb754a`。

| 逻辑 ID | 历史激活 commit | 回滚 commit | SRS／JSON 字节 |
| --- | --- | --- | ---: |
| `ai-openai` | `058da8e1d3b913a96c0a83848f85f137c029d68f` | `41f2720fa45bd6bb0913ee174c51683d860d92c3` | 485／1036 |
| `ai-anthropic` | `f88557d006e83a990cf74768bf9418f457746a05` | `a40b430322604a8faf362384ca2e49cd691721c0` | 272／618 |
| `ai-google-deepmind` | `878d4fe6d0134a4ee0f00ed782554422285d6509` | `c2142bc02e57c37b701b9c0e80c1151c392f139e` | 594／1830 |

## 一次配置发布，同一进程 A → B → A

`test/integration/activation-client.test.ts` 为 `ai-openai` 准备 A、B 两份受控候选。两者的来源描述、来源修订、列表选择和匹配域名均可区分，不宣称来自第二个真实上游。A 使用 `openai` 定义，B 使用 `anthropic` 定义；逻辑 ID、稳定路径和 v2 订阅保持一致。

测试只调用一次 `publishRecipe`，经过真实 1.14.4 配置检查，再由 `readPublication` 与 `renderSubscription` 取得配置。激活 A、换源激活 B、按 B 的当前 Pipeline 配置回滚 A 后，每一步都建立新 HTTP 连接和 DNS TCP 请求。

| 阶段 | 新 Route 请求 | 新 DNS 请求 |
| --- | --- | --- |
| A | `route-fallback-A` | `192.0.2.10` |
| B | `route-matched-B` | `192.0.2.20` |
| 回滚 A | `route-fallback-A` | `192.0.2.10` |

A 包含另一个域名，因此表中的探测域名在 A 回落，在 B 命中。HTTPS 服务实际记录同一原 URL 下载所得摘要 A／B／A；客户端 PID、启动配置字节、逻辑 ID、订阅和已发布配置快照保持不变。激活记录分别关联两份候选的受控来源，回滚后恢复 A 的来源。

隔离进程启动前，测试给交付配置添加一次性网络夹具：本地 HTTPS 隧道、临时 CA、loopback 请求目标、`1s` 更新周期及关闭 DNS 缓存。Recipe 的匹配条件和出站选择保持原样。该夹具不表示真实设备按此周期更新；运行中没有改配置或重启客户端。临时进程、证书和服务在测试结束时清理。

## 拒绝、回归与审查

受控 Pipeline 测试逐项验证其他集的历史、错误逻辑 ID、损坏历史 JSON、损坏历史规则、缺失候选、候选篡改、当前订阅不兼容、历史候选身份错配、原生验证失败和过期 head。拒绝后远端 head、写入次数、三集状态及当前文件保持不变。成功回滚还逐字节核对不可变候选及旧提交未被修改。

本地 Standards 审查发现一处仍称多集回滚待交付的 README 描述，已同步。Spec 审查发现历史候选曾被要求与当前列表定义全等，导致换列表后无法回滚；新增先失败、修复后通过的回归测试，并将同进程客户端验收升级为不同列表的两任受控来源。两项均已处理，`49f363d` 的 Standards 与 Spec 复核均无未解决 findings；Spec 复核还独立运行了 12 项回滚测试，全部通过。

已执行：

- Node 24.22.1、pnpm 10.33.2、sing-box 1.14.4。
- 设置 `SING_BOX_TEST_BINARY` 后执行最终 `pnpm check`：工具测试 21、Compiler 常规测试 99、Pipeline 常规测试 101，全部通过，无跳过；类型检查、构建及 workspace smoke 通过。
- 最终 `pnpm test:integration`：Compiler 28、Pipeline 127，全部通过，无跳过。
- 独立 CLI 测试 11 项通过；换列表回滚测试记录了 `Configured build identity or target mismatch` 的失败及修复后通过。
- `git diff --check` 通过。

首次常规检查未传入 native binary，Pipeline 的 3 项原生相关测试跳过；随后最终完整检查显式传入 binary，全部实际执行。最终验收无环境跳过项。

## 复现与环境边界

真实验收需要已创建的隔离分支、全新状态目录、尚不存在的证据文件、GitHub 认证及网络。它会在隔离分支发布候选、激活并回滚三集；不能用生产分支替代。

```sh
cd packages/rule-set-pipeline
RULE_CONFIGURED_ROLLBACK_BRANCH=acceptance-issue-40-<unique-suffix> \
RULE_CONFIGURED_ROLLBACK_STATE=/tmp/issue-40-fresh-state \
RULE_CONFIGURED_ROLLBACK_EVIDENCE=/tmp/issue-40-real.json \
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
node --import tsx --test test/acceptance/configured-rollback.test.ts
```

真实发布／回滚与 HTTPS 回读使用公开 GitHub 隔离分支。坏历史与不兼容候选在受控 transport 注入；同进程客户端使用真实 sing-box 和 loopback HTTPS，提交身份为内存 transport 的模拟值。未向生产分支写入，未切换实际客户端，未接入第二个真实上游，未验证全部平台设备。
