# #21 客户端更新故障与缓存离线恢复验收

验收日期：2026-11-04（Asia/Shanghai）。依据 [#21](https://github.com/wangyingang/sing-box-config-manager/issues/21)、父 [Spec #14](https://github.com/wangyingang/sing-box-config-manager/issues/14) AC15、AC16，并回归 AC14 的故障后恢复更新。[机器证据](issue-21.evidence.json) 分别保存内存保留和跨重启恢复结果。

## 环境与隔离

从 `origin/main` 的 `03f506ee950631ebd7c2845344b6ed94b35fde84` 创建 `codex/issue-21` 与独立 worktree `sing-box-config-manager-issue-21`。不读取、修改或依赖 #20 的任务内容。

新增独立文件 `test/integration/client-failure-recovery.test.ts`，复用 #19 已打通的公开 Compiler `compile`、规则订阅和真实客户端受控网络方式。A、B 是使用 Pipeline `buildNative` 生成并经真实 1.14.4 编译、解码、加载验证的合成 SRS，不声称来自官方 Release，不重复 #19 的真实发布验收。

规则 URL 使用专属 `acceptance-issue-21` 路径，受控实例通过配置中的 HTTP 隧道将下载导向 loopback HTTPS 服务；临时 CA 仅在本次配置中受信。全部目录、缓存、监听端口和服务均为本测试独立创建；不访问或写入远程规则分支、不修改生产入口、hosts、系统信任或实际客户端，也无需与其他任务串行写远端。

Compiler 只生成一次配置，测试启动前设置 `update_interval: 1s`、独立 `cache_file` 路径和 DNS 缓存禁用。运行与重启期间比较配置字节及 SHA-256。缓存和短周期只属于测试条件，不成为实际客户端统一要求或全部设备更新时限承诺。

## 更新失败时保留内存规则

两个域名均发起新 HTTP Route 与 DNS TCP 请求，连接不复用，DNS 缓存禁用。每个版本必须同时通过正反匹配，防止把默认回退或空规则误判为成功。

| 已加载版本 | `updated.issue21.test` Route／DNS | `other.issue21.test` Route／DNS |
| --- | --- | --- |
| A | `route-matched`／`192.0.2.20` | `route-fallback`／`192.0.2.10` |
| B | `route-fallback`／`192.0.2.10` | `route-matched`／`192.0.2.20` |

DNS 的域名条件与规则订阅使用显式 logical AND；Route 则由规则订阅直接选择匹配出口。

每类故障执行完整 A → 故障 → B：先证明 A 的上述行为；注入故障，等待规则服务确实收到该模式请求且原生更新失败，并断言错误原因；随后发新请求证明 A 仍有效；恢复服务提供合法 B，等待新请求出现 B 的正反行为。四轮始终是相同 PID 和配置，下一轮先恢复 A 再注入故障。

| 注入 | 实际原生错误 | 故障后／恢复后 |
| --- | --- | --- |
| 服务端断开连接，不返回 HTTP 响应 | 下载 `EOF` | A／B |
| HTTP 503 | `unexpected status: 503 Service Unavailable` | A／B |
| 完整 HTTP 响应中只有半份 SRS | `read rule[0]: unexpected EOF` | A／B |
| 非法 SRS 字节 | `invalid sing-box rule-set file` | A／B |

截断场景验证规则内容加载失败；不声称同时覆盖所有 HTTP framing 或中途断流情形。错误日志用于确认故障已到达客户端，保留与恢复结论来自其后的新请求行为。

## 持久缓存与断网重启

最后一轮恢复到 B 后正常停止客户端，读取已写出的非空缓存文件，保存实际文件字节数与 SHA-256。随后关闭 HTTPS 规则服务并销毁现存隧道连接，再以相同配置和缓存路径启动新进程。

规则服务不再交付任何字节，新 PID 的正反 Route／DNS 请求仍体现 B。测试还等待断网后的原生更新确实报错，再次发新请求确认 B 保持有效。这证明已持久化的 B 被新进程恢复，不能由原进程的内存保留解释，也不能由仅有 A 或空规则解释。缓存文件存在与文件摘要仅为辅助证据，实际匹配是恢复成功的依据。

测试在 finally 中终止客户端、关闭 DNS／HTTP／HTTPS 服务、销毁隧道连接并删除临时目录；指定输出路径保留机器证据，CI 日志保留每次运行的结果。

## 原生边界

依据固定 [sing-box v1.14.4 远程规则实现](https://github.com/SagerNet/sing-box/blob/v1.14.4/route/rule/rule_set_remote.go)：

- 下载、读取、解析和规则元数据兼容性检查成功后才替换内存规则；本次动态注入覆盖上表四类，不把它扩大成所有故障的运行时验证。
- 客户端不额外校验 Artifact Manifest 摘要。合法但内容被替换的 SRS 不由本测试提供摘要防护。
- `loadBytes` 先使内存规则生效，再写缓存；缓存写入失败会记录错误，不回滚已生效的内存规则。该边界经源码核对，本次未注入真实磁盘写入失败。
- 跨重启保证依赖有效且成功持久化的缓存；首次启动没有有效缓存、缓存损坏、缓存不可写均不具有无条件旧规则保证。本次只验证成功缓存的离线恢复，没有声称这些反例可恢复。
- 不依赖客户端拒绝合法空 SRS；非空与完整性约束由 #19 的发布端激活门禁承担。本次未修改该门禁。

## 检查结果

Node 24.15.0、pnpm 10.33.2，直接运行已安装的真实 sing-box 1.14.4 绝对路径，不切换全局版本：

- `pnpm check`：Pipeline 87 项、Compiler 96 项，共 183 项全部通过；typecheck、build、workspace smoke 通过。
- `SING_BOX_TEST_BINARY=<absolute 1.14.4 path> pnpm test:integration`：Pipeline 53 项、Compiler 27 项，共 80 项全部通过，无跳过。包含本次独立故障与离线恢复测试。
- 专用测试可按包 README 中的命令重跑并设置 `RULE_CLIENT_FAILURE_EVIDENCE`；已有 native CI 通过文件通配符自动纳入该测试，无需修改 workflow 或共享 fixture。
- 完整检查日志的 SHA-256 及 binary 身份保存在机器证据中。未重跑真实 Release 发布、远程激活或 #20 回滚验收；本工单无远程规则写入。

## 本地双轴审查

固定基线 `03f506e`，实现提交 `dd021d4`，两个独立 subagents 完整审查本次 diff。

### Standards

无硬规范违规。发现异常清理路径重复停止进程但缺少超时保护：已改为统一调用停止函数，SIGTERM 后最多等待 5 秒再发 SIGKILL，避免异常分支一直等待退出。修正后重跑完整 `pnpm check` 与真实 binary 集成检查均通过，数量仍为 183 项与 80 项。

### Spec

无发现。审查核对 #21、#14 AC14–AC16 和 #19；独立重跑专用测试，1 项通过、0 失败、0 跳过。确认四类故障的新请求行为、缓存跨进程恢复、独立资源及原生边界符合要求。
