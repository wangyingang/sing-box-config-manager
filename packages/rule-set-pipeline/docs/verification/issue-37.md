# Issue #37：批量候选发布验收

2026-11-06，在公开 `updateRules` 操作边界用官方 V2Fly Release `20261104112839` 完成隔离发布。目标是产物仓库的 `acceptance-issue-37-20261106` 分支；未执行激活或稳定入口切换。完整候选 ID、固定地址、摘要、长度和来源见 [机器可读证据](issue-37.evidence.json)。

| 逻辑 ID | 输入／输出条目 | JSON 字节 | SRS 字节 | 候选证据 commit |
| --- | ---: | ---: | ---: | --- |
| `ai-openai` | 25／25 | 1036 | 485 | `cac75305b2b3355d35df6d4193e5a3b24e94ffd6` |
| `ai-anthropic` | 19／19 | 618 | 272 | `c6e34c97f9219db2ce1e3b47d81f9fd73366adcc` |
| `ai-google-deepmind` | 49／49 | 1830 | 594 | `57fdc67bc4152675cc516df5849edf719fb11a11` |

**实际检查：** 该批次的 YAML 与摘要文件各请求一次；完整资产摘要与固定来源身份经 Pipeline 校验。三个候选分别取得 Manifest、来源、转换报告、构建记录和回读证据。对各候选从固定 HTTPS 地址重新取得 Manifest、报告、构建记录、JSON、SRS 和回读证据，核对逻辑 ID、列表、来源摘要、目标版本、Source Format、用途映射、文件集合、摘要、长度和条目数。`route` 与 `dns-query` 共用同一对文件，`dns-response` 为 `unavailable: empty`，能力要求为空。Pipeline 对回读 JSON 执行 sing-box 1.14.4 原生编译、解码、加载，并与回读 SRS 逐字节比较；三集均通过。

受控集成测试分别注入 Anthropic 缺表、非法条目、候选回读失败，确认逐集失败且兄弟候选保留。修复暂时回读故障后只重试 Anthropic，成功兄弟集的候选记录不变；即使 `latest` 已前进，也能用已固定 Release 重试。共同摘要损坏或 YAML 文档无效时无候选发布；固定来源摘要变化时拒绝重试。CLI 测试确认逐集失败返回退出码 1，并用新命令进程读取真实持久状态。

**环境条件：** 本次具备 sing-box 1.14.4、GitHub 认证、网络与隔离分支，因此真实发布和原生检查均未跳过。故障注入和重试采用受控传输；未向真实 GitHub 分支注入故障，也未执行生产激活。

首次发布后，将新旧路径的发布门禁合并，并修复固定 Release 重试。上表和机器可读证据取自最终代码的第二次真实发布；隔离分支从初始 head 到本次验收后的 18 个提交只新增 `candidates/` 文件，未修改 `stable/`。
