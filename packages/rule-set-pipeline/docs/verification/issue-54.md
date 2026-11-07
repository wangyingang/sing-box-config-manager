# Issue #54 基线切换验收

[工单 #54](https://github.com/wangyingang/sing-box-config-manager/issues/54) 增加 `maintenance-switch`，以及 `maintenance-resume` 在切换后的恢复路径。生产自动更新和清理的启用属于独立操作。

| 场景 | 验收行为 |
| --- | --- |
| 原子推送失败或预期 head 冲突 | 旧发布状态保持，临时新基线可继续核验。 |
| 推送回复丢失、稳定 HTTPS 回读失败、核验记录回复丢失或临时引用清理失败 | 新调用根据远端 heads 和核验记录继续。核验前保留新旧临时引用，恢复过程中不会重复切换。 |
| 两轮清理及夹在两轮之间的更新和回滚 | 第一轮保留 A，更新到 B 后仍可回滚 A。第二轮以 B 为基线时，回滚 A 或使用其旧证据重建明确失败。屏蔽旧产物 SHA 后仍可从新目录查询并立即检查。 |
| 维护代次变化及其他任务引用 | 旧检查无法提交，旧本地候选缓存从远端刷新。仍存在的其他引用出现在 `otherRefs`，当前规则字节、稳定 URL 和人工固定状态均保持。 |

从仓库根目录执行统一验证，证据目录必须是新目录：

```sh
node scripts/verify.mjs --out <新证据目录> --binary <1.14.4绝对路径> --release
```

[原生集成测试](../../test/integration/check-now.test.ts) 通过公开操作覆盖两轮清理、真实 sing-box 和故障注入。Git refs 与 HTTPS 在测试 transport 中隔离。

真实 GitHub 验收会在产物仓库创建随机命名的 `acceptance-*` 分支和配套维护引用，测试结束后按当前 heads 清理这些引用。它需要具有相应隔离分支写权限的 `gh` 登录。测试输入使用受控 Release fixture，Git 推送、远端 refs、HTTPS 及 sing-box 均使用真实接口。从 `packages/rule-set-pipeline` 目录执行：

```sh
RULE_MAINTENANCE_SWITCH_PROBE=1 RULE_MAINTENANCE_REF_PROBE=1 \
  SING_BOX_TEST_BINARY=<1.14.4绝对路径> \
  node --import tsx --test test/acceptance/maintenance-{switch,refs}.test.ts
```

真实切换测试在隔离分支上注入推送回复丢失及回读中断，再通过远端日志恢复并复验稳定规则。独立的双引用探针用陈旧租约验证服务端拒绝半切换。
