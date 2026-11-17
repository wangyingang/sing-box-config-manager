# #97 真实客户端测试迁移

2026-11-17。实施起点 `598344366b28b68042e4d64676e9b8e0120f1784`，父 Spec #93 的 M7。本映射在编辑测试前保存。固定旧基线 `7075bfc3f6a900c67a07e32e53e5a8aabc4ed1b4` 复用 [#94 的同环境测量及原始归档](issue-94.md#整理前测量与验证)，不重复建立基线。

## 旧断言与当前覆盖

| 旧断言 | 当前契约及迁移落点 | 退役条件 |
| --- | --- | --- |
| activation-client：一次发布 v2 Recipe，同进程 DNS/Route 观察 A→B→旧版本→恢复 | `rules-domain-client.test.ts`：sync A、sync B、pin A、pinned sync、resume B；保持真实 HTTPS、sing-box、Recipe 发布与原稳定 URL | 替代客户端场景通过后删除旧 activation-client 流程 |
| activation-client：域名来源变化、旧来源恢复、逻辑 ID、来源和稳定字节身份 | 新客户端测试比较当前交付来源、versionId、订阅及下载摘要；换源失败与旧来源重选复用 `rules-operations.test.ts` 的“换源失败保留交付但撤销 pin；别名保持 pin；旧来源可明确重选” | 不再使用旧 synthetic candidate、历史 activation commit 选择与双暂停字段 |
| activation-client：Recipe、发布快照、配置文件不变，下载字节确实变化 | 新域名客户端测试逐项保留；只在隔离 harness 中加速轮询、关闭 DNS 缓存和重定向网络 | 不能只验证服务端写入或重新启动客户端 |
| china-ip-delivery：IPv4/IPv6 Route 与 DNS response 真实匹配；DNS query 不可用、用途复用同一 URL | `rules-cidr-client.test.ts` 保留四地址探针及编译拒绝断言，用当前 sync/pin/resume 驱动 | 替代通过后删除剩余旧 CIDR 文件；#94 已迁走该文件其他断言 |
| china-ip-delivery：自动 B、固定 B、固定跳过、回选 A、resume B | 新 CIDR 客户端测试按 versionId pin B/A，停止上游读取，resume 保留 B 的候选/版本身份 | 退役旧 activate/rollback/check/resume 入口及旧控制字段 |
| china-ip-delivery：HTTP 503、无效 SRS 后仍使用 B；有效缓存断网重启仍为 B | 新 CIDR 客户端测试保留原故障与缓存断言，保存实际探针、故障日志和两个进程身份 | 替代通过后删除旧段落 |
| 独立 client-failure-recovery：网络断开、503、截断 SRS、无效 SRS、恢复 B、有效缓存断网重启 B | 原测试原样保留，继续使用真实 buildNative 与 sing-box；为域名场景复用完整故障矩阵 | 不属于旧操作流程，无须迁移或删除 |

所有新测试从当前应用服务调用，仅替换上游网络和 Git 存储。域名与 CIDR 复用各自已有客户端 harness，不伪造 SRS、原生匹配或缓存。应用配置权威、heads、writeId 和交付回执仍由当前服务核实。原生 CI 的 `test/integration/*.test.ts` 与 typecheck 的 `test/**/*.ts` 覆盖新文件及独立故障测试。

## 验证记录

删除前两个新客户端场景及原有独立故障恢复测试共 3/3 通过，零失败、跳过、取消和 todo。域名测试 6.605 s、CIDR 测试 8.872 s、独立故障恢复 12.237 s，文件并发墙钟 12.386 s。typecheck 通过。最早执行曾因从根目录无法解析 tsx 和迁移中的 TypeScript 类型错误失败；已改从包目录执行并修正类型，未将这些失败计为通过。

负向验证仅将新域名 harness 的 HTTPS 响应固定为初始 A 字节，保留 sync B 的服务端成功结果。客户端继续返回 A 的 Route/DNS，测试在等待 B 时失败；恢复 harness 后 3/3 通过。运行时源码及 sing-box binary 均未改动。此验证证明客户端匹配断言能发现服务端已写入而客户端未采用的回归。

替代通过后删除旧 activation-client、剩余 china-ip-delivery 和仅被旧域名流程使用的 synthetic candidate fixture。其他工单的 configured-activation fixture、legacy workflow、清理与历史转换覆盖保留；独立故障恢复文件原样保留。完整验证结果见下文，最新 CI 状态记录到 PR／工单交付评论。

本地两轴审查发现统一验证入口仍向旧客户端变量写证据，会漏归档迁移后的场景。先修改已有 verify 脚本测试，确认旧入口失败，再接入由本轮覆盖的 domain/cidr 路径并清除继承变量；脚本测试通过后重跑统一验证。旧轮主动终止，不计入完整通过统计。

默认 CI 与本地验证不执行远端写入验收；本票不修改生产行为、profile、生产开关、更新周期或缓存设置。

## 完整本地结果与测量

统一入口在干净提交 `9080526678a74efe3e62817924940330f6755a70` 上通过，范围 `check-native`，tracked diff SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`：

```sh
node scripts/verify.mjs --out .verification/issue-97/final --binary /absolute/path/to/sing-box-1.14.4
```

常规 390 项（工具 115、Compiler 99、Pipeline 176），原生 271 项（Compiler 28、Pipeline 243），共 661 项全部通过，失败、跳过、取消和 todo 均为 0。typecheck、build、工作区及浏览器打包 smoke 由同一入口执行。两份迁移后的客户端证据及独立故障证据均列入 `final/files.json`；证据读取器核验大小与摘要通过 1/1。

工具为 Node v26.13.0、pnpm 10.33.2、sing-box 1.14.4，binary SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。环境仍为 macOS arm64、Apple M2 Max，与 #94 固定旧基线相同；完整绝对路径与版本输出在 summary 和进程明细中。没有切换全局 binary 或增加原生缓存。

| 本机测量 | 固定旧基线 `7075bfc` | 本轮 `9080526` |
| --- | ---: | ---: |
| 常规文件（tools / Compiler / Pipeline） | 6 / 12 / 21 | 6 / 12 / 20 |
| 原生文件（Compiler / Pipeline） | 8 / 26 | 8 / 19 |
| 常规 / 原生用例 | 396 / 307 | 390 / 271 |
| 真实路径或副本原生调用 | 16,070 | 13,700 |
| 故障 wrapper 调用 | 114 | 114 |
| 常规检查 / 原生阶段耗时 | 43.497 / 251.773 s | 46.506 / 161.388 s |
| 总墙钟 | 295.514 s | 208.113 s |

| 原生调用用途 | 固定旧基线 | 本轮 |
| --- | ---: | ---: |
| version | 3,264 | 2,790 |
| rule-set compile | 3,113 | 2,638 |
| rule-set decompile | 3,114 | 2,639 |
| rule-set match | 6,423 | 5,473 |
| schema | 74 | 76 |
| check | 77 | 79 |
| run | 5 | 5 |

沿用旧基线的进程观测器及调用归类脚本，suite 统计脚本仅调整输出位置。比较的是相同统一入口和工具下不同测试集合的一次测量，累计包含 #94—#97，不能将调用减少 2,370 次或墙钟减少 87.401 s 归因于本票，也不能承诺固定降幅。相对 #96 的 13,659 次调用，本轮增加 41 次；当前应用服务验证和 CIDR 配置发布检查继续真实执行，没有用伪造 SRS 换取下降。故障 wrapper 的 version/compile/decompile/match 仍分别为 28/25/24/37。

本轮域名、CIDR、独立故障恢复三个测试体分别为 9.103、12.488、12.461 s，各 1 项，全部由全量原生入口执行。文件并发运行，测试体之和不是总体墙钟。替换前后本票客户端场景数均为 2，独立故障场景仍为 1；没有用统计数量下降代替覆盖迁移。

[local.tar.gz](issue-97/local.tar.gz) 保存完整统一验证、源码 diff、工具与环境身份、进程统计、文件清单、实际客户端观测、独立故障日志、定向测试、负向验证、证据入口的 red/green、本地主动终止的非通过轮次及两轴审查报告。大小与 SHA-256、源码和范围见 [manifest.json](issue-97/manifest.json)。历史旧基线仍引用 #94 原始归档，不复制或改写。

## Standards

首轮 1 项 P2：统一验证入口未接入新客户端证据路径。`9080526` 修复并扩展已有脚本测试，先失败、后 10/10 通过；复核全部 diff 后无未解决问题。

## Spec

0 项未解决 findings。复核旧断言去向、同进程真实匹配、稳定 URL、Recipe／发布快照、CIDR 双栈和独立故障矩阵；统一证据接线修复也已复核。两轴范围均为 `5983443...9080526`。

云端首轮 Codex review 覆盖 `9080526`，已完成且无 findings；review 正文、行内 comments 与 review threads 均已核对，后两者为 0。此后的源码提交仅补本文及证据归档。最新 CI、其实际覆盖提交和 PR／工单状态更新到交付评论，不为刷新这些状态新增源码提交。PR 待审期间 #97 保持 open，不代表父 Spec #93 或其他迁移工单完成。
