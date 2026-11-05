# Issue #38：同一 Release 增选与显式重建

2026-11-06，使用官方 V2Fly Release `20261104112839`、sing-box `1.14.4` 和 Source Format `4`，在产物仓库的 `acceptance-issue-38-20261106` 隔离分支通过真实验收。入口为公开 `updateRules`、`rebuildRules`，并由独立 CLI 进程查询 `status`。未执行激活。

## 验收行为

1. 仅处理 `ai-openai`，随后在同一 Release 下选择 OpenAI 与 Anthropic。OpenAI 返回 `skipped`，Anthropic 返回 `processed`。
2. 使用不存在的 binary 重建 OpenAI。该集返回 `failed`，原成功记录保留。
3. 恢复有效 binary，按固定 tag 单独重建 OpenAI。新候选记录 `operation: rebuild` 和原成功候选 ID；原成功记录、原候选与 Anthropic 候选保持不变。
4. 从原 OpenAI、Anthropic 与重建 OpenAI 的固定 HTTPS 地址重新取得全部文件，核对实际 SHA-256 与字节数。核对 Manifest 的逻辑 ID、格式、用途复用、目标版本及条目数，并读取已通过的构建与远程原生验证证据。重建后的 OpenAI 与原候选具有相同构建身份及规则字节，各自保留独立候选 ID 和固定地址。
5. 用固定官方样本元数据替代 `latest` 响应验证正常更新跳过：不下载资产、不执行 binary，仍指向原成功候选。此探针不表示历史样本是当前真实 latest。

## 本地验证

- `pnpm check`：通过。21 项工具测试、99 项 Compiler 测试、99 项 Pipeline 测试全部通过，类型检查、构建与工作区冒烟检查通过。
- `SING_BOX_TEST_BINARY=<1.14.4> pnpm test:integration`：通过。Compiler 28 项、Pipeline 92 项，共 120 项，无跳过。
- 新测试先复现配置驱动重建缺失，随后通过。集成测试还覆盖回读失败后的重试、已存在的激活回执不变、兄弟集保留、变更定义重新处理、未知或重复 ID 拒绝，以及 Release、资产、源码 commit 和实际来源摘要变化时拒绝重建。
- Standards 与 Spec 两项独立代码审查：均无发现。

## 证据与执行边界

真实验收 1 项通过，无跳过。完整固定地址、来源、构建记录、状态与逐文件摘要见[机器可读证据](issue-38.evidence.json)。

| 操作 | 逻辑 ID | JSON／SRS 字节 | 条目 | 候选证据 commit |
| --- | --- | ---: | ---: | --- |
| 初次更新 | `ai-openai` | 1036／485 | 25 | `b9f666fd3584b1b44f1d05d012c7d01b4ecc3eea` |
| 增选 | `ai-anthropic` | 618／272 | 19 | `1c24861bd12cca5330c2fa5c522cd0c1acbeaab0` |
| 显式重建 | `ai-openai` | 1036／485 | 25 | `e0a813e3f9cd19132505142025c66d6698539295` |

隔离分支基于产物仓库初始 head `ae3cf588169226618eb30271f123c29608eb754a`。与验收最终 head `e0a813e3f9cd19132505142025c66d6698539295` 比较，18 个提交只新增 42 个 `candidates/` 文件，无稳定文件修改。第一次运行在候选发布后因测试直接比较内存中的 `undefined` 字段与 JSON 落盘对象而失败；修正断言后，使用新的状态目录重跑全部真实场景并通过。上表及机器证据来自第二次运行，第一轮候选同样保留。

本次具备原生 binary、网络、GitHub 认证与隔离发布条件。受控回读故障在内存传输中注入；真实验收注入缺失 binary，不向真实远程注入篡改或并发故障。没有执行生产激活或多集激活／回滚验收，后者属于 #39。
