# #18 不可变候选发布与远程回读

2026-11-04，实施 [#18](https://github.com/wangyingang/sing-box-config-manager/issues/18)，基于 `2c8209b`，独立 worktree `sing-box-config-manager-issue-18`、分支 `codex/issue-18`。需求及边界来自 #18、父 Spec #14 和 ADR 0006。用户另行授权创建公开产物仓库及真实候选发布；未授权激活、稳定入口修改或实际客户端配置修改。

正常 CLI 查询一次 latest，再固定 Release 与来源，复用 #15／#16 的完整验证路径。来源固定、候选及成功处理记录持久化；激活状态单独读取。发布采用规则文件、Manifest／构建记录、HTTPS 回读证据三个提交，文件 URL 使用完整 commit。只有最终证据也回读成功后才记录成功，失败候选保留且重试创建新身份。

真实发布及最终验证证据在本次验收结束后填入本页和相邻 JSON 文件。
