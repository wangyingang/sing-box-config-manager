# #48：远端候选恢复与状态查询

2026-11-07。对应 [Issue #48](https://github.com/wangyingang/sing-box-config-manager/issues/48) 和父 [Spec #47](https://github.com/wangyingang/sing-box-config-manager/issues/47)。本次实现候选恢复基础；`update`／`rebuild` 仍只发布候选。

## 实现结果

- 发布分支保存初始化标识、固定来源、操作 ID、原配置与选择、维护代次、目标及起始 head、候选阶段和成功处理索引。本地目录只保存缓存。
- 候选三个阶段与各自进度在同一次预期 head 提交中保存。维护、代次或 head 变化阻止旧写入；不强推、不自动换 head 重放。
- 新目录恢复原 Release 和同一候选 ID。完整候选直接复验，残缺候选补齐未完成阶段；已提交阶段不重复发布。
- `status` 查询远端当前规则、候选可用性、待核实操作与仍可用的回滚目标。已处理记录与候选是否仍保留分别判断。
- 初始化、状态缺失、损坏及读取故障分别处理；普通更新不会隐式重建远端状态。

## 验证

环境：Node.js 24.22.1、pnpm 10.33.2、原生 sing-box 1.14.4。测试使用独立临时目录，仓库写入由受控 transport 模拟；原生规则编译、解码和加载使用真实 binary。

| 检查 | 结果 |
| --- | --- |
| `SING_BOX_TEST_BINARY=... pnpm check` | 通过：工具测试 21、Compiler 测试 99、Pipeline 测试 160，共 280 项通过、0 跳过；typecheck、build 与 workspace smoke 通过 |
| `SING_BOX_TEST_BINARY=... pnpm test:integration` | `35fc708` 上 186 项通过，0 跳过；包含既有客户端同进程更新、回滚与缓存恢复 |
| `node --import tsx --test test/integration/remote-*.test.ts test/integration/activation-client.test.ts` | 最终恢复、binary-only 状态查询及客户端回归 37 项通过，0 跳过 |
| `node --import tsx --test test/acceptance/configured-release.test.ts` | 固定官方 Release `20261104112839` 的三集构建、重复字节一致性及原生验证通过 |
| `git diff --check` | 通过 |

官方来源验收首次匿名读取返回 HTTP 403；使用现有 GitHub 登录提供进程内认证后重试通过。凭据未写入产物或日志。

主要可复查测试：

- [`remote-recovery.test.ts`](../../test/integration/remote-recovery.test.ts)：文件阶段中断、新目录原 Release 恢复、批次失败集单独重试、完整候选不依赖上游恢复，以及 `status` 原生复验。
- [`remote-faults.test.ts`](../../test/integration/remote-faults.test.ts)：三阶段提交回复丢失且核实失败、本地缓存写失败、维护／代次／head 竞争、候选移除及远端读取故障。
- [`remote-legacy-recovery.test.ts`](../../test/integration/remote-legacy-recovery.test.ts)：旧单集 update/rebuild 的同等恢复、幂等与保留门禁。
- [`remote-state.test.ts`](../../test/remote-state.test.ts)、[`remote-status.test.ts`](../../test/remote-status.test.ts)：初始化、损坏状态、当前激活事实、候选完整性及历史回滚目标。
- [`remote-status-binary.test.ts`](../../test/integration/remote-status-binary.test.ts)：真实原生候选经 `activateRules` 仅激活 SRS 后，`status` 核验当前版本和历史回滚目标。
- [`publication-repository.test.ts`](../../test/publication-repository.test.ts)：Git API 的唯一父提交、非强制更新、不可变候选、未知提交身份及可靠 tree/blob 读取。
- [`cli.test.ts`](../../test/cli.test.ts)：初始化与状态查询的分支/config 路由、错误退出和远端权威标识。

测试先复现了原实现换目录后读取 latest、完整候选恢复仍重取上游、批次不能单独重试，以及来源资产身份校验不完整的问题；修复后相关测试通过。

本地双轴审查发现的 2 项 Spec 问题已修复：元数据阶段跨 binary 安装路径恢复保留原构建记录；缺失、改写操作 ID 或候选索引时停止恢复，不另发候选。Standards 轴的 1 项判断性重复代码问题也已处理，完整候选复验共用实现并统一返回七份回读证据。新增隔离回归验证了这些行为，以及旧单集在 `acceptance-*` 目标上的更新与重建。

[PR #56 首轮云端审查](https://github.com/wangyingang/sing-box-config-manager/pull/56#discussion_r4498127822) 发现的 binary-only 状态查询问题已修复：根据已验证的订阅推导实际文件集合，不再固定要求同时激活 JSON 与 SRS。v1/v2 当前版本和历史目标均覆盖；损坏订阅、错误仓库／分支／路径及冲突映射继续被拒绝。独立复核无新增问题，状态单测 35 项与新增原生回归 1 项均通过。

## 尚未执行及范围边界

没有执行真实产物分支的初始化、候选发布、激活、回滚或历史重建；因此未将 GitHub 服务器上的真实发布恢复记为通过。上述外部写入需另行安排隔离验收。本次官方 Release 验收只读取来源并本地构建。

没有启用生产自动更新、人工 pin/resume、调度或历史清理，没有修改稳定 URL、订阅契约或客户端配置。旧阶段 A 本地操作不会自动导入远端成功记录；新环境必须显式初始化，已有远端状态不能由旧缓存覆盖。
