# Issue #85：候选保留与一键历史清理验收

日期：2026-11-16。需求：[Spec #85](https://github.com/wangyingang/sing-box-config-manager/issues/85)。本次实施基于 `origin/main@30b8c7193eac91253d52502518665bdc629a0f89`，在 `codex/issue-85` 独立 worktree 完成。交付停在 PR 待审阅，不执行生产转换、历史重写或开关变更。

## 行为覆盖

| 验收 | 实际检查 |
| --- | --- |
| B01 保留范围 | 30 天窗口包含等于 cutoff 的非当前候选；过期且无保护候选移除；单分支和 candidates/main 双分支均验证 |
| B02 当前豁免 | 长期 pin 与换源失败仍交付的旧候选受保护；退出当前后按原发布时间判断；cleanup 不访问上游、不改变控制与稳定字节 |
| B03 清理后可用 | 旧 Git/HTTPS SHA 全部禁止访问后，status 仍列保留候选，非当前版本可 pin；两轮清理保持 versionId/publishedAt 和明确的实际当前指针 |
| B04 单入口恢复 | 切换前中断，以及切换回复丢失后 HTTPS 回读中断，均用 cleanup 恢复；跨日、配置改成 1 天仍沿用原计划；隔离期间其他操作无法写入 |
| B05 只读与职责 | dry-run 不写状态、不建 stages、不动 refs；输出截止边界和原因，标明尚未执行的验证；无变化重复 cleanup 不建立新基线；Node API 拒绝草稿清理 |
| B06 历史与报告 | 核对受管 refs 的可达历史不含旧图；未知分支和标签保留并报告；保留数据逻辑字节数可见；未完成/未知时间阻塞，明确失效残留可回收 |

核心证据为[清理集成测试](../../packages/rule-set-pipeline/test/integration/rules-cleanup.test.ts)、[基线迁移回归](../../packages/rule-set-pipeline/test/integration/rules-cleanup-baseline.test.ts)与[CLI/Action 集成测试](../../packages/rule-set-pipeline/test/integration/rules-cli.test.ts)。基线迁移回归覆盖有原始发布时间、版本身份由已确认转换规则回填的候选。恢复记录校验拒绝把任意分支加入可删除引用集合。

## 本地验证

针对清理与迁移基线的真实 sing-box 测试 7 项通过，0 失败、0 跳过；入口常规测试 10 项、CLI 原生集成 1 项通过。使用 sing-box 1.14.4；日志位于任务 worktree `.verification/issue-85-cleanup-tests.log` 与 `.verification/issue-85-surface/`。

统一入口的源码身份、范围与统计在完整验证结束后补录。PR 最新 CI 和云端审查结果在 PR／工单交付记录中更新，不为状态刷新追加源码提交。

## 真实 GitHub 隔离验收

隔离探针使用唯一 acceptance-issue-85-* 分支、受限维护 refs 和固定官方 Release 输入，检查真实引用切换、保留版本查询和 pin、稳定 HTTPS 字节及生产 refs／Actions variables 前后不变。执行结果与临时引用清理记录在探针完成后补录；当前不将其记为已通过。

## 范围限制

正式保留期沿用已确认的 30 天。#86 的自动调度与 GitHub 失败通知尚未交付；本次 Action 仍仅支持手动 acceptance-* 隔离目标。旧状态转换不随代码合并或 cleanup 自动执行，未知历史时间和旧维护未决项保持可见。保留数据规模是候选与当前稳定文件的逻辑字节数，不是 Git 对象磁盘占用；不承诺未知 refs 不再引用旧历史、GitHub 立即物理回收或旧 SHA 立即失效。
