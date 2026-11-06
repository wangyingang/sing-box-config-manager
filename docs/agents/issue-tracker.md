# Issue tracker: GitHub

本仓库的 issues 和 specs 存放在 `wangyingang/sing-box-config-manager` 的 GitHub Issues，使用 `gh` CLI 操作。

在仓库内运行命令时，`gh` 从 Git remote 推断目标仓库；在仓库外运行时，显式指定 `--repo wangyingang/sing-box-config-manager`。

## 常用操作

- 创建：`gh issue create --title "..." --body-file <file>`。
- 读取：`gh issue view <number> --json number,title,body,labels,comments`。
- 列表：`gh issue list --state open --json number,title,body,labels,assignees`，按任务添加筛选条件；需要完整集合时处理结果数量限制。
- 更新正文：`gh issue edit <number> --body-file <file>`。
- 评论：`gh issue comment <number> --body-file <file>`。
- 添加或移除标签：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- 关闭：`gh issue close <number>`。
- 创建子工单：`gh issue create --parent <parent> --title "..." --body-file <file>`。
- 关联已有子工单：`gh issue edit <parent> --add-sub-issue <child>`。

多行正文写入临时文件，通过 `--body-file` 传递，保留真实换行和字面字符。

Skill 要求“发布到 issue tracker”时，创建 GitHub issue；要求“获取相关 ticket”时，读取对应 issue。

## 实施前核对

推荐或开始实施工单前，核对原始需求、相关已确认决策、未决问题及实际阻塞关系。判断每个未决问题是否影响当前工单的验收行为。事实问题先通过源码、文档或探针核实；影响行为的产品决定应先确认；范围外的问题注明依据，不作为当前工单的阻塞项。工单已标记就绪或前置工单已关闭，不替代上述核对。

## PR 关联与合并收尾

完整满足工单验收标准的 PR 使用 `Closes #编号`；部分实现使用 `Refs #编号`，并说明剩余工作。是否完成按验收证据判断，CI 全绿不能代替验收核对。

测试场景与验收边界随实现提交。最后一轮 CI、云端审查和合并结果更新到 PR 和工单交付记录，注明覆盖提交；仅刷新这些状态时，不再新增源码仓库提交。

合并前，显式列出本 PR 应关闭的全部工单，运行只读校验：

`node scripts/check-pr-delivery.mjs --pr <PR编号> --issue <工单编号> --phase before-merge`

多个工单重复传入 `--issue`；没有待关闭工单时，以 `--no-issues` 替代 `--issue`，校验自动关闭关联为空；仓库外运行时加 `--repo owner/name`。校验要求 PR 打开、非草稿且面向默认分支，预期工单仍为 open，自动关闭关联与预期工单完全一致。发现缺失或意外关联时，修正后再合并。

获得合并授权后，按实际证据更新验收清单与交付记录，保留未执行项和范围限制。完整完成的工单应以 completed 关闭；未自动关闭时补做关闭。部分完成或用户要求保留 open 的工单，记录剩余工作或保留原因，不列入预期关闭集合。

对预期关闭的工单运行合并后只读校验：

`node scripts/check-pr-delivery.mjs --pr <PR编号> --issue <工单编号> --phase after-merge`

校验要求 PR 已合入默认分支，预期工单均已以 completed 关闭。校验失败时报告具体差异，不宣称工单收尾完成。脚本只读取 GitHub 状态，不修改 PR 或工单，也不判断代码是否满足验收标准。

清理已获授权删除的分支和 worktree 前，归档必要的验证证据。收尾报告列出工单最终状态；仍为 open 时说明原因。

## Pull requests as a triage surface

**PRs as a request surface: no.**

若以后改为 `yes`，外部 PR 使用与 issues 相同的 triage 标签和状态：

- 读取正文与评论：`gh pr view <number> --comments`；读取变更：`gh pr diff <number>`。
- 查询外部 PR：使用 `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open'`，筛除 `author_association` 为 `OWNER`、`MEMBER`、`COLLABORATOR` 的条目。
- 评论、标签和关闭分别使用 `gh pr comment`、`gh pr edit`、`gh pr close`。

GitHub 的 issues 和 PRs 共用编号空间。编号类型不明时，先用 `gh pr view <number>` 解析；确认不是 PR 后再用 `gh issue view <number>`。

## Wayfinding 操作

`/wayfinder` 使用一个 map issue 组织子工单。

- Map：使用 `wayfinder:map` 标签，正文维护 Notes、Decisions-so-far 和 Fog。
- 子工单：以 GitHub sub-issue 关联到 map，使用 `wayfinder:<type>` 标签，type 为 `research`、`prototype`、`grilling` 或 `task`。若无法使用 sub-issues，在 map 正文维护任务列表，并在子工单正文顶部注明 `Part of #<map>`。
- 阻塞关系：优先使用 GitHub 原生 issue dependencies，通过 `gh issue edit <child> --add-blocked-by <blocker>` 添加。若服务不支持，在子工单正文顶部维护 `Blocked by: #<number>, #<number>`。
- Frontier：读取 map 的全部未关闭子工单，排除有未关闭 blocker 或已有 assignee 的工单，按 map 顺序选择第一个。原生依赖的 `issue_dependencies_summary.blocked_by` 表示未关闭 blocker 数量；使用正文回退时逐个核实 blocker 状态。
- Claim：选定工单后，以 `gh issue edit <number> --add-assignee @me` 作为该工作会话的首次写入。
- Resolve：评论交付结果，关闭已完成工单，并在 map 的 Decisions-so-far 中追加简述和链接。
