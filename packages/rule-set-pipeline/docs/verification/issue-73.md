# #73 四集工作流与隔离验收

[工单 #73](https://github.com/wangyingang/sing-box-config-manager/issues/73) 对应 [Spec #66](https://github.com/wangyingang/sing-box-config-manager/issues/66) 的 A20，并汇总 A1–A19 的验证入口。工作流和 CLI 共用 [正式配置](../../config/rulesets.yml)：`openai`、`anthropic`、`google-deepmind` 和 `china-ip`。隔离运行只更改目标分支。日常入口检查四集，然后按计划评估维护；手动入口可分别检查和清理。每次运行的逐集结果和维护摘要保存在 GitHub Actions Summary 和 `rule-maintenance-summary` artifact 中。

| 证据 | 验证范围 |
| --- | --- |
| 统一验证入口 `scripts/verify.mjs --release` | 保留源码身份、工具身份、命令、测试统计和日志摘要。固定官方 Release 构建回归复核新命名下的三集用途和产物；不写产物仓库。 |
| 受控来源及传输、真实 sing-box | [双来源检查](issue-71.md)覆盖来源隔离、内容去重、固定来源续做和自动写入门禁。[双来源清理](issue-72.md)覆盖维护代次、两轮清理、原子提交及回读失败后的恢复。 |
| 真实客户端、受控上游及本地 HTTPS | `test/integration/china-ip-delivery.test.ts`验证 Route 和 DNS Response 共用稳定 SRS，实测 IPv4／IPv6 命中与不命中、DNS Query 拒绝，以及同一配置在更新、固定、恢复、下载或加载失败和离线缓存重启时的行为。 |
| 真实 GitHub 和固定官方上游 | 四集探针从空的 `acceptance-issue-73-*` 分支初始化。先发布候选并核验 HTTPS 字节，确认稳定路径尚不存在；随后自动激活、检查第二组来源，回滚、从新目录恢复并人工固定 `china-ip`。执行有内容的清理，再核验四集稳定文件、人工状态及已清理版本不可回滚。 |
| GitHub Actions 实际运行 | 用手动 `check` 和 `cleanup` 验证 runner、工作流凭据及摘要产物。定时触发逻辑由本地 `daily` 入口覆盖；只有默认分支实际触发记录可证明 GitHub 调度。 |

从仓库根目录运行统一验证：

```sh
node scripts/verify.mjs --out /absolute/path/to/new-evidence \
  --binary /absolute/path/to/sing-box-1.14.4 --release
```

另存真实 GitHub 探针的 TAP 日志。探针固定 V2Fly Release `20261104112839` 和 `20261108011013`，并验证 Git commit `f162630c8cdad6ced5ef59e606cc93919123ac57` 与 `62bc1fc8b015bece77271b568e10d6337915bc96` 属于 `ip-lists` 历史。只固定版本发现，实际 GitHub 输入、产物写入和 HTTPS 回读均通过网络完成。日志记录来源摘要、构建工具、候选证据和清理结果。

```sh
RULE_OFFICIAL_CONFIG_PROBE=1 SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
  pnpm --dir packages/rule-set-pipeline exec node --import tsx --test --test-reporter=tap \
  test/acceptance/official-rulesets-lifecycle.test.ts
```

探针需要可写产物仓库隔离引用的 `gh` 登录。探针在删除专用分支和维护引用前记录验证结果，删除后复核引用及生产 `main`、`candidates` heads。删除分支后旧 Git 对象仍可能暂时可访问；恢复验收依据远端基线状态和公开操作的结果。测试不启用生产更新或清理，不切换生产规则 URL，也不迁移现有客户端。本次执行记录及尚未验证的项目见交付 PR。
