# Issue #67：正式配置和三集更名验收

[工单 #67](https://github.com/wangyingang/sing-box-config-manager/issues/67) 对应 [Spec #66](https://github.com/wangyingang/sing-box-config-manager/issues/66) 的 A18、A19。正式配置从空状态初始化 `openai`、`anthropic`、`google-deepmind`。本验收不迁移旧配置、历史或客户端，不启用生产更新和清理。以下三集探针对应 #67 的源码版本；当前四集探针见 [#73](issue-73.md)。

- **规则内容与用途：** 旧定义（`e144fff`）与正式配置使用 V2Fly Release `20261104112839` 和同一个 sing-box 1.14.4。比较三集的转换报告、用途映射和六个 JSON／SRS 文件。固定 Release 测试复核原 JSON 摘要，并验证新构建的 JSON／SRS 可重复。运行 `node scripts/verify.mjs --out <新目录> --binary <绝对路径> --release`，证据记录完整来源、工具身份及产物摘要。
- **受控故障：** 原生集成测试使用受控 Release 和隔离 transport 验证错误摘要、单列表失败、人工与自动操作并发、发布中断后换目录、提交后回读中断和维护恢复。客户端测试使用真实 sing-box 验证稳定 URL 更新和缓存恢复。
- **真实 GitHub：** 下列探针从空的随机 `acceptance-issue-67-*` 分支初始化，发布三集候选，并依次验证首次激活、第二个固定官方 Release 只更新 Anthropic、回滚暂停、恢复检查、重新人工固定和清理。清理后从新目录复验三集的 HTTPS 内容、人工状态及已删除的回滚历史。探针将两次检查的 `latest` 查询固定到指定官方 Release，避免结果随上游发布漂移；仍经真实 GitHub 获取输入、写入隔离引用并通过 HTTPS 回读。

```sh
cd packages/rule-set-pipeline
RULE_OFFICIAL_CONFIG_PROBE=1 SING_BOX_TEST_BINARY=/absolute/path/to/sing-box \
  pnpm exec node --import tsx --test test/acceptance/official-rulesets-lifecycle.test.ts
```

探针需要具有产物仓库隔离分支写权限的 `gh` 登录。运行结束删除本次创建的临时引用，并确认产物仓库的 `main` 和 `candidates` heads 没有变化。GitHub 定时触发和生产命名切换不在本验收范围。
