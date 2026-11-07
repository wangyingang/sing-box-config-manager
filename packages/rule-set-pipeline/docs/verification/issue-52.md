# Issue #52 清理预览与维护隔离验收

[工单 #52](https://github.com/wangyingang/sing-box-config-manager/issues/52) 的公开入口是 `@sing-box-config-manager/rule-set-pipeline/maintenance` 的 `manageMaintenance` 和 `maintenance-*` CLI。

| 场景 | 可观察结果 |
| --- | --- |
| 未配置周期、尚未到期、到期且没有可清理内容 | 分别报告 `disabled`、`not-due` 和 `no-cleanup`。预览以及这三种结果都不提交远端状态。 |
| 同时存在 v1 和 v2 当前稳定入口 | 预览列出两种入口的当前记录、规则文件、人工固定、证据路径和最近检查结果。近期历史和未激活的完整候选可进入清理范围。 |
| 预览后手动指定版本 | 获取隔离时记录实际旧 heads，隔离后重新核实当前版本。保留集合包含新的 pin 和对应候选证据。 |
| 候选文件、元数据和回读证据提交期间请求维护 | 三个阶段分别返回延期。写入方断线后，另一运行仍能看到远端待恢复登记。 |
| 已登记的双分支激活尚可提交 | 维护提交在 Git transport 处拒绝变更代次。当前稳定 head 仍可接受旧请求时，取消任务不能证明安全。 |
| 更新跨越维护、恢复和安全退出 | 隔离时稳定字节和 pin 保持。旧任务的预期 head 和代次过期。新任务可读取远端状态并继续工作。 |
| 隔离提交后回复丢失 | 新调用从远端取得同一维护 ID、旧 heads 和阶段，重新核实并记录保留集合。ID 不符或稳定 head 改变时保持隔离。 |
| 其他任务的分支与 tag | 清点 Git 服务器公开的其他引用。维护命令不修改这些引用。 |

原生场景复用 `test/integration/check-now.test.ts` 的 sing-box 1.14.4 和内存 Git transport。使用仓库根目录的统一入口 `node scripts/verify.mjs --out <新证据目录> --binary <1.14.4 绝对路径> --release`。

原子多 ref 更新探针使用真实产物仓库和当前 `gh` 凭据，仅创建随机命名的 `acceptance-issue-52-*` 分支。2026-11-07 的探针确认了两个不相干根提交之间的原子强制更新。一次陈旧租约被拒绝后，两条分支均仍指向旧提交。有效租约同时更新两条分支，随后按精确租约清理本次探针的引用。该结果覆盖隔离分支及本次凭据。生产分支保护与工作流凭据由后续上线验收核对。

```sh
cd packages/rule-set-pipeline
RULE_MAINTENANCE_REF_PROBE=1 node --import tsx --test test/acceptance/maintenance-refs.test.ts
```

生成新基线和切换由 [#53](https://github.com/wangyingang/sing-box-config-manager/issues/53) 与 [#54](https://github.com/wangyingang/sing-box-config-manager/issues/54) 交付。
