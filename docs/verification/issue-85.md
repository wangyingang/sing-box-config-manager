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

统一入口 `node scripts/verify.mjs --out .verification/issue-85-local-1 --binary <sing-box 1.14.4 绝对路径>` 已通过，scope=`check-native`。summary 中源码身份为 base commit `30b8c7193eac91253d52502518665bdc629a0f89`、`clean=false`、tracked diff SHA-256 `cf94afac12f4d14f95c5e589da9089745d3626d084fa3948375e7db2a9bfb44d`；该实现和测试随后提交为 `4932d0f`。工具为 Node.js `v26.13.0`、pnpm `10.33.2`、sing-box `1.14.4`，binary SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。

- 常规检查：工具 115、Compiler 99、Pipeline 157，共 371 项通过；类型检查、构建和 workspace smoke 通过。
- 原生集成：Compiler 28、Pipeline 226，共 254 项通过。
- 合计 625 项通过，0 失败、0 取消、0 跳过；summary、日志与完整性清单保留在上述目录。
- 未额外运行 `--release` 固定官方全量构建套件；真实 GitHub 探针单独记载，不计入 625 项。

## 本地审查与补充回归

对 `30b8c71...4932d0f` 分别进行 Standards 和 Spec 审查：Standards 无 finding；Spec 发现 1 项 P2。证据阶段已保存后若中断，换机使用 SHA 不同的 sing-box 1.14.4 会重建不同证据字节，无法继续同一维护。修复改为严格比对并采用已有 evidence 原始字节，当前主机仍执行原生复验；保留业务版本、发布时间及原工具记录。

修复后追加单／双分支换工具 SHA 恢复回归，并复跑迁移基线与 CLI/Action 集成，共 4 项通过、0 跳过；typecheck、diff 格式检查通过。日志为 `.verification/issue-85-review-regression.log`。同时修正 cleanup 预览文案，并让人类可读输出显示尚未验证的条件。Spec 审查者已只读确认修复覆盖原 finding。统一 625 项验证早于这些补充修复；最终提交的 CI 和云端审查覆盖以 PR／工单交付记录为准。

现行文档检查 6 个 Markdown、63 个本地链接／锚点通过。PR 最新 CI 和云端审查结果只更新交付记录，不为状态刷新追加源码提交。

## 真实 GitHub 隔离验收

隔离探针使用唯一 acceptance-issue-85-* 分支、受限维护 refs 和固定官方 Release 输入，检查真实引用切换、保留版本查询和 pin、稳定 HTTPS 字节及生产 refs／Actions variables 前后不变。GitHub 存储、引用、HTTPS 和官方来源字节均真实；候选时间由隔离测试时钟控制，以在一次运行中验证 30 天窗口，不代表来源的历史发布时间，也不改写生产记录。本次 1 项通过、0 失败/跳过，约 771.77 秒，结束时间 `2026-11-16T15:41:48.757Z`。

探针目标 `acceptance-issue-85-abd5641d-56eb-4f5e-abea-ac6aa15b0be1`，维护身份 `4e2dcfd7-652a-4809-8bc4-ae651b066e5b`。测试时钟观察时间为 `2026-11-16T00:00:00.000Z`，cutoff 为 `2026-10-17T00:00:00.000Z`。

| 观察 | 实际结果 |
| --- | --- |
| 保留版本 | `5678ef0c-514e-4e39-9fb5-e1f048e3764f`（11-01，清理后 pin 成功）与 `f65d937c-52df-4d0b-8e66-9e91a205985b`（11-16，清理时当前） |
| 移除版本 | `d7971cd3-1a33-41e7-8e3d-436376e77520`（09-01，过期且无保护） |
| 可达历史 | 37 → 6 个提交，新旧集合无交集；新 root `441cf3b4df48a83dddc2932e161dff3f39fed85f` |
| 受管 head | 清理前 `5ac4134e5319e1a7fadf4ccc597a3b58c5cdb74e`，恢复写入后 `987af04a5b72bc033508296007b49d6508309bb9` |
| 保留规模与上游 | 保留逻辑数据 31,182 字节；cleanup 与后续 pin 未增加上游请求 |
| 引用收尾 | 5 个本次维护临时/旧引用由 cleanup 清理，最后删除探针目标；`remaining=[]`，另行匹配引用查询确认无残留 |

生产 refs 和源码仓库 Actions variables 前后一致：产物 main 为 `ae3cf588169226618eb30271f123c29608eb754a`，candidates 为 `2b74039505116d84688a379bfe04d25ae76f4350`；变量为空列表。完整证据保留在 `.verification/issue-85-github/attempt-2.json` 和 `attempt-2.log`。`attempt-1.log` 保留从仓库根目录启动时缺少 tsx 的失败，该次未进入远端操作；之后从 Pipeline package 执行并通过，没有覆盖失败记录。探针执行了 `4932d0f` 的正常清理路径；后续 `5ea5513` 的跨机器恢复修复由单独针对回归验证。

## 范围限制

正式保留期沿用已确认的 30 天。#86 的自动调度与 GitHub 失败通知尚未交付；本次 Action 仍仅支持手动 acceptance-* 隔离目标。旧状态转换不随代码合并或 cleanup 自动执行，未知历史时间和旧维护未决项保持可见。保留数据规模是候选与当前稳定文件的逻辑字节数，不是 Git 对象磁盘占用；不承诺未知 refs 不再引用旧历史、GitHub 立即物理回收或旧 SHA 立即失效。
