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

替代通过后删除旧 activation-client、剩余 china-ip-delivery 和仅被旧域名流程使用的 synthetic candidate fixture。其他工单的 configured-activation fixture、legacy workflow、清理与历史转换覆盖保留；独立故障恢复文件原样保留。完整验证与 CI 结果待补充。

默认 CI 与本地验证不执行远端写入验收；本票不修改生产行为、profile、生产开关、更新周期或缓存设置。
