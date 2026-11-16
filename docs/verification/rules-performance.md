# 规则交付提交与读取优化验收

日期：2026-11-17。基线：`003cc39a8bf5ae780e40edf81f56ff73fd260bc9`。本次需求来自管理者确认的七阶段方案，延续 [Spec #90](https://github.com/wangyingang/sing-box-config-manager/issues/90) 的候选恢复与最新输入选择契约。

## 交付范围

- 四集正常首次交付由 45 次提交变为 29 次：1 次正式配置状态及每集 7 次持久阶段。阶段文件与 journal 合并保存，返回的 commit 指针在下一阶段登记；固定路径与字节核验负责恢复指针缺失。
- verified 与 pendingDelivery 只在候选验证和交付准备均成功时合并。恢复后未选中、或交付准备失败的完整候选独立保存。已有 current 时恢复证据后仍检查最新上游，不直接交付旧候选。
- 复用完整 Git SHA 的 blob、tree、commit 和固定修订配置正文；不缓存分支、latest、仓库可见性和失败请求。缓存有界，调用方修改不污染后续读取。
- 移除 session.save 的第三次重复预检，实际提交仍在对象创建前和 ref 更新前执行 guard；每次读取最新配置修订与 journal head，检查维护及规则身份边界。目标 ref 更新前另核对目标 head，保留预期 parent、非强制更新、writeId 与回执核实。
- CLI/Actions 在 stderr 报告阶段、规则及累计时间，长阶段每 15 秒提示。Node 请求提供可选 onProgress。stdout 最终结构不变，observer 失败不能改变业务结果。
- 沿用现有 schema、分支布局、稳定 URL；不重写生产历史，不修改 agent-facing 文档。

## 验收覆盖

| 场景 | 证据入口 |
| --- | --- |
| 正式四集 29 次提交，逐步核对 building、publishing、指针、证据、verified/pending、回执、完成 | `test/integration/rules-performance.test.ts`；修改前同一断言失败：45 !== 29，修改后通过 |
| 单/双分支七阶段提交后中断，以及七阶段提交成功但响应丢失 | 同上，28 个参数化场景；新 context 沿用原身份与已有字节，重复执行无额外提交 |
| 候选合格但交付准备失败 | 同上；verified 单独持久化，无 pending、无稳定写入，恢复选择原候选 |
| 与 sync、pin、换源、删除及真实 cleanup 争用 | 同上；对方提交后旧任务不覆盖最新状态；cleanup 使用真实隔离与 ref 切换 |
| 旧候选补证据但 latest 失败、A→B→A、不按多候选遍历顺序选择、工具变化、版本身份冲突 | `test/integration/rules-recovery.test.ts`，沿用 #90 反例 |
| Metadata/evidence 指针中断、换机 binary 路径、稳定回读失败及原回执恢复 | `test/integration/rules-operations.test.ts` |
| 不可变缓存去重、失败重读、分支/权限不缓存、最终 head 变化拒绝 PATCH、两次实际写 guard | `test/immutable-github.test.ts` 与 `test/publication-repository.test.ts` |
| stderr 先于写入输出、JSON 仅最终一次、长阶段定时提示、observer 抛错隔离 | `test/integration/rules-cli.test.ts` 与 `test/rules-progress.test.ts` |

测试使用真实应用服务和 sing-box 1.14.4；Git、上游 HTTP 及时间由既有外部边界 fixture 提供。提交次数指可达分支提交，不是 HTTP 请求次数，也不是耗时比例。

## 已执行验证

- 新增阶段/并发及 CLI 定向集成：37 项通过，0 失败、0 跳过。
- Pipeline 单元测试，配置真实 native binary：182 项通过，0 失败、0 跳过。
- Pipeline typecheck、build、`git diff --check` 通过。
- 全模块集成及 PR CI 的最终结果随交付记录更新；上面的定向结果不替代它们。

## 只读实测

在相同生产 `candidates@ea08a99a4a485ce479691f351626cbf6ab20d304` 与 `main@5dc92dbaa1a25b43eef79ff02fe760c90b1c52de` 上，原实现 status 为 131 次 GitHub API、28 次 HTTPS 读取、115.2 秒；本次实现为 41 次 API、28 次 HTTPS 读取、41.7 秒。四集当前版本及可选候选数一致。请求与时间证据归档于本机 `Documents/Codex/verification/rules-sync-performance-20261117/`，不含凭据或请求头。

此测量仅针对 status，没有重跑生产 sync 或执行远端写入。首次交付 29 次提交已由应用服务集成验证，不将提交减少比例、status 提速比例或本地 fixture 耗时换算为生产 sync 耗时保证。生产开关和产物 refs 保持原状；真实客户端加载、生产 schedule 与实际首次交付耗时不属于本次执行结果。
