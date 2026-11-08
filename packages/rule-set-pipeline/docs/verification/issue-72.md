# #72 双来源历史清理验收

对应 [#72](https://github.com/wangyingang/sing-box-config-manager/issues/72) 和 [Spec #66](https://github.com/wangyingang/sing-box-config-manager/issues/66) 的 A16、A17，以及 A13 的维护部分。

从仓库根目录运行完整验证：

```sh
node scripts/verify.mjs --out /absolute/path/to/new-evidence-directory \
  --binary /absolute/path/to/sing-box-1.14.4
```

也可单独运行双来源维护场景：

```sh
SING_BOX_TEST_BINARY=/absolute/path/to/sing-box-1.14.4 \
  pnpm --dir packages/rule-set-pipeline exec node --import tsx --test \
  test/integration/maintenance-sources.test.ts
```

| 场景 | 核验内容 |
| --- | --- |
| 四集清理预览 | 三集来自不同 Release，`china-ip` 使用固定 commit。预览列出当前来源、人工固定、候选文件和拟清理版本。 |
| 准备与切换 | 从产物仓库复制当前字节，用真实 sing-box 原生复验。准备中断后继续使用已有阶段。原子推送拒绝时两个 heads 都不变；推送回复丢失时核对两个 heads，避免重复切换。稳定 URL 回读和临时引用清理失败后均可续做。 |
| 两轮清理与恢复 | 屏蔽旧产物提交，每集仍可通过新基线核验稳定字节、订阅、候选和人工控制。第二轮前从新目录按保留的固定 commit 重建候选，稳定交付不变。 |
| 清理前后的历史 | 已清理的 commit 无法回滚或重建，重建失败前不请求上游。新基线后切换 `china-ip`，可回滚到清理保留的版本。 |
| 写入门禁 | 候选发布和人工激活在隔离期间被拒绝；稳定写入待核实的操作会使清理延期。 |

测试使用受控的 V2Fly Release、Git 文件与 Git／HTTPS transport，分别覆盖单分支与双分支布局。用真实 sing-box 编译、解码和加载当前规则。正式 Actions 与隔离 GitHub 目标的完整跨流程验收由 [#73](https://github.com/wangyingang/sing-box-config-manager/issues/73) 覆盖。
