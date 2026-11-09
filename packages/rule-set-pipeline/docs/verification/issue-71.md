# #71 双来源检查与单集恢复

验收使用 [#71](https://github.com/wangyingang/sing-box-config-manager/issues/71) 的公开操作、受控来源和产物传输，以及真实 sing-box 1.14.4。仓库统一验证入口保存本次源码提交、工具摘要、日志和测试统计：

```sh
node scripts/verify.mjs --out /absolute/path/to/new-evidence --binary /absolute/path/to/sing-box-1.14.4
```

下表的验收编号对应[双栈 IP 规则集交付 Spec #66](https://github.com/wangyingang/sing-box-config-manager/issues/66)。

| 验收范围 | 测试观察 |
| --- | --- |
| A6–A7：按来源共享输入，按规则集判断交付变化 | 四集首轮各自激活；单独改变 CIDR 后只增加一个 `china-ip` 候选和激活；新 Git commit 只有注释变化时，摘要保留新检查 SHA，稳定版本和候选数不变；人工固定期间内容重复时也保留已核验候选 |
| A8：故障隔离 | 非法 CIDR、V2Fly 共同摘要错误和单列表非法分别注入；其他规则集仍能交付变化，失败集保留原版本 |
| A10：人工控制与恢复 | 人工指定仍可检查，回滚后不访问该集上游；恢复只检查 `china-ip`。恢复验证失败时仍交付旧版本，下次正常检查可激活，并保留 V2Fly 的人工固定 |
| A13：恢复与写入门禁 | 两类来源固定后丢失候选提交回复，新目录在调整同源别名声明顺序后仍使用原 Release 和 SHA；单分支及双分支均拒绝后来人工决定前启动的旧任务。现有检查测试继续验证维护代次和 head 门禁 |
| 状态与待核实 | 已提交的 CIDR 激活在 HTTPS 回读失败时显示已知提交和待核实状态；继续运行但回读仍不可用时，兄弟集不写入；回读恢复后不重复切换，兄弟集按已固定来源继续 |
| A14：同一真实客户端 | 用同一份配置、同一进程和稳定 URL 观察自动更新、固定、回滚和恢复。逐阶段探测 IPv4／IPv6 的目标地址与 DNS 响应地址；随后验证下载／加载故障与离线缓存恢复 |

双来源验收在 `test/integration/check-sources.test.ts`，真实客户端验收在 `test/integration/china-ip-delivery.test.ts`，Release 与维护门禁回归在 `test/integration/check-now.test.ts`。

测试不写 GitHub 产物分支。CIDR 当前版本参与历史清理由 [#72](https://github.com/wangyingang/sing-box-config-manager/issues/72) 处理；正式工作流接入四集与真实 GitHub 隔离验收由 [#73](https://github.com/wangyingang/sing-box-config-manager/issues/73) 处理。
