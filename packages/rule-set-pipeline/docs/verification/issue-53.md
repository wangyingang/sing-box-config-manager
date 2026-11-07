# Issue #53 当前版本新发布基线验收

[工单 #53](https://github.com/wangyingang/sing-box-config-manager/issues/53) 使用 `manageMaintenance({ action: 'prepare', ... })` 和 `maintenance-prepare` 验收准备阶段。测试通过公开更新、人工固定、维护和远端状态查询入口运行真实 sing-box 1.14.4。Git 和 HTTPS 在隔离的测试 transport 中模拟。

| 场景 | 验收结果 |
| --- | --- |
| 三个 v2 当前版本跨两个 Release，OpenAI 已固定且现行定义演进 | 保留当前激活 ID、原来源、构建记录、规则字节、订阅契约和控制修订。准备阶段没有上游请求和业务激活。 |
| 共享分支同时交付 v1 和 v2，或稳定分支与 journal 分离 | 新基线覆盖各入口。候选证据链和稳定提交只使用新父链；原稳定入口继续交付。 |
| 缺少 binary 或新 HTTPS 地址暂时不可读 | 分别报告延期和失败；旧稳定 head 和 pin 保持。重新执行准备可复用已写入的阶段。 |
| 屏蔽所有旧产物 SHA 地址后恢复 | 从远端记录读取并复验新 heads、原生证据和稳定规则。保留旧 Release 的处理记录，移除已清理候选的证据地址和回滚历史。 |

从仓库根目录使用统一验收入口。证据目录须是新目录。

```sh
node scripts/verify.mjs --out <新证据目录> --binary <1.14.4绝对路径> --release
```

定向场景位于 [check-now.test.ts](../../test/integration/check-now.test.ts)。真实产物仓库的原子切换、切换后验收和临时引用清理由 [#54](https://github.com/wangyingang/sing-box-config-manager/issues/54) 交付。
