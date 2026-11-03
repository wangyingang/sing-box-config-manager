# #18 不可变候选发布与远程回读

2026-11-04，实施 [#18](https://github.com/wangyingang/sing-box-config-manager/issues/18)，基于 `2c8209b`，独立 worktree `sing-box-config-manager-issue-18`、分支 `codex/issue-18`。需求及边界来自 #18、父 Spec #14 和 ADR 0006。用户另行授权创建公开产物仓库及真实候选发布；未授权激活、稳定入口修改或实际客户端配置修改。

[机器可读证据](issue-18.evidence.json)包含实际来源、最终候选、七份文件的真实 HTTPS 回读摘要／字节数、后续 CLI 恢复状态、无新版本请求记录、执行检查摘要及审查基线。

## 更新、状态与失败恢复

正常 CLI 只在开始查询一次 latest，固定该响应的 Release、tag 和资产身份后复用 #15／#16 全部校验、转换、投影与原生构建。来源身份在下载前保存；摘要验证通过后、转换前保存内容记录。重试检测到已固定身份或内容变化时拒绝，不覆盖原来源。

`update-state.json` 原子保存来源、候选和成功处理记录；`active-version.json` 独立读取，update 不写入。同一目录通过排他锁拒绝并发；异常终止遗留锁的恢复方法见 README。获取、转换、原生验证、上传或回读失败均保留失败候选且不记录成功；重试创建新候选，重新获取和验证。

顺序发布规则文件、Manifest／来源／报告／构建记录、远程回读证据。Manifest 物理 ID 绑定候选 revision，URL 固定完整 commit，避免自引用。七份文件分别通过 HTTPS 回读，核对 SHA-256、字节数和逐字节内容。下载 JSON 再经真实编译、解码及加载，所得 SRS 对比下载 SRS；最终证据文件也回读成功后才记录成功。

## 真实公开交付

复用现有 `gh` keyring 身份 `wangyingang`，确认指定仓库不存在后创建 [wangyingang/sing-box-rule-artifacts](https://github.com/wangyingang/sing-box-rule-artifacts)，visibility 为 PUBLIC，无需新增权限。只向 `candidates` 分支追加；`main` 仍为初始化提交 `ae3cf588169226618eb30271f123c29608eb754a`，仅含 README，没有稳定规则路径。

| 验收路径 | Release | 最终候选 | 完整 commit 固定记录 |
| --- | --- | --- | --- |
| 固定官方样本 | `20261102130044` / `431467724` | `6e76b4ef-883c-46d1-8058-ef3f803b347b` | [Manifest](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/559b0667e1485b911529c6810a437545e174237e/candidates/6e76b4ef-883c-46d1-8058-ef3f803b347b/manifest.json) · [HTTPS 回读证据](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/3f06056ee6f1c6336936d3b1e7b776215c8b2ded/candidates/6e76b4ef-883c-46d1-8058-ef3f803b347b/readback.json) |
| 正常 latest CLI | `20261103081536` / `432424665` | `a6f6d8c2-7c99-4ee9-b5a4-4026ac2af44a` | [Manifest](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/41054c67ddec80ea98c74f4b9ec95a942cee7d82/candidates/a6f6d8c2-7c99-4ee9-b5a4-4026ac2af44a/manifest.json) · [HTTPS 回读证据](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/8eb83fc26954c6bd6e4bf514a9473568085b8961/candidates/a6f6d8c2-7c99-4ee9-b5a4-4026ac2af44a/readback.json) |

固定样本源码 commit `328f6c5168653e809561c862757c966fc5012e5d`，YAML／摘要资产 ID `701778045`／`701778047`。完整 YAML 为 3,758,877 字节，SHA-256 `bfa4ab62d0f47216029ce6b777a2364978c3f28086060b592453684a0dd830ee`。真实下载通过官方摘要核对，214 条全部转换，13 条属性记录保留，无不支持、无效、重复或静默丢弃。正常 latest 的完整来源身份在 JSON 证据中；两个 Release 的目标规则字节一致。

| 文件 | 字节数 | term 数 | HTTPS 实际回读 SHA-256 |
| --- | --- | --- | --- |
| [domains.json](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/6000355c8f6932610eee0be23dc11311e969df0c/candidates/6e76b4ef-883c-46d1-8058-ef3f803b347b/domains.json) | 6316 | 214 | `181b855217d871ed8f0ec40923a8606489c5ffb0fe0b14de3c47aeeb0a5a63d5` |
| [domains.srs](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/6000355c8f6932610eee0be23dc11311e969df0c/candidates/6e76b4ef-883c-46d1-8058-ef3f803b347b/domains.srs) | 2164 | 214 | `b66a1797d2850ba2c2c632ae6f61cb40184134a3d4bcb584dc07273361c167d5` |

Route／DNS 请求复用文件，DNS 响应为 `unavailable: empty`；target 1.14.4、Source Format v4、额外能力为空。

首次真实发布因 API 多余尾部斜杠返回 404，没有成功记录；修复后从已固定来源重试成功。早期两份调试候选的 Manifest 物理 ID 未绑定候选 revision，自查修正后生成上述最终候选。早期文件未覆盖，已另追加 `superseded.json` 指向替代 Manifest，完整地址见 JSON 证据 `earlyCandidates`。没有激活任何候选。

## 无新版本与故障证据

成功后在新进程运行 `update --state /tmp/issue-18-normal-final --binary /not-an-executable` 返回 `skipped`，恢复相同候选 ID 和证据 URL。fetch 观察器实际只记录一次官方 `releases/latest` 请求及 HTTP 200，没有 YAML／摘要下载；不存在的 binary 没有执行。独立 `status` CLI 恢复成功处理与 verified 候选。隔离目录激活记录为 null，不表示实际设备没有版本。

受控真实 binary 测试分别注入三个上传阶段失败、回读离线，以及 JSON、SRS、Manifest、来源、转换报告、构建记录和回读证据损坏。每项先失败且无成功记录，再解除故障、创建新候选通过，不复用残留。另覆盖下载、转换、binary 失败及固定身份／内容变化，确认保留原来源。transport 测试覆盖二进制 base64、保留父 tree、历史路径拒绝、tree 截断、稳定路径拒绝及并发非快进拒绝。

## 检查与审查

明确 binary 为 `/Users/wangyg/.sbvm/versions/v1.14.4/sing-box-1.14.4-darwin-arm64/sing-box`，SHA-256 `6546126c1759683fe85798da92409215d53c50e0f2b346b4f74a61babc8dbec2`。按 `sbvm` direct-run 路径使用，没有运行 `sbvm use`；前后当前版本均为 v1.14.4。

通过 `npx --yes pnpm@10.33.2` 使用仓库锁定版本，实际执行：

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | Pipeline 56、Compiler 96 项通过；typecheck、build、workspace smoke 通过 |
| `SING_BOX_TEST_BINARY=<binary> pnpm test:integration` | Pipeline 25、Compiler 27 项通过，无失败或跳过 |
| 显式授权环境下 `test:publication` | 固定完整官方样本真实发布、七份 HTTPS 回读与持久成功状态，1 项通过，无跳过 |
| 正常 `update` + 新进程 `update` / `status` | latest 发布、无新版本跳过及磁盘恢复证据通过 |
| `git diff --check` | 通过 |

`2c8209b...93071e2` 由独立 Standards／Spec subagents 完整审查，各为 0 findings；审查者未额外重跑测试或发布。随后增加排他锁断言并重跑 `pnpm check`，补充本次实测证据。增量 Standards 审查发现文档误写 Compiler native 数量为 26；已按原始日志及 JSON 修正为 27，无遗留问题。PR 远程 CI 以最新提交为准，本机结果不能替代它。

显式激活、稳定入口、实际客户端配置及客户端更新／缓存／回滚未执行，由 #19 及后续工单交付。未手动关闭 #18、未合并实现 PR。
