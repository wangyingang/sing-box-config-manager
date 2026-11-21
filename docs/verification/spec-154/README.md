# Spec #154 的串行同步验收证据

16 个规则集、6 个来源的四个场景各运行五轮。全部未变时，完整校验的逻辑读取从 1,216 次降到 48 次；两版的整次同步中位数分别为 1.352 秒与 1.378 秒。64 组逐集事实一致。Git、上游传输与产物读回均在本地隔离环境中执行，真实 GitHub 传输耗时留待另测。[基线与固定探针](../issue-155/README.md) · [复测与分阶段结果](../issue-156/README.md)

| 交付 | 经审查的 PR head | 合入 main 的提交 | CI |
| --- | --- | --- | --- |
| [#155](https://github.com/wangyingang/sing-box-config-manager/issues/155) · [PR #157](https://github.com/wangyingang/sing-box-config-manager/pull/157) | `62fb5c3` | `195a33a` | [快速检查](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44875963786) |
| [#156](https://github.com/wangyingang/sing-box-config-manager/issues/156) · [PR #158](https://github.com/wangyingang/sing-box-config-manager/pull/158) | `84e92e0` | `39480d0` | [快速检查](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44877348732) · [Linux 全量原生回归](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44877355482) |

两项 PR 的快速检查都通过。普通 PR 按配置跳过 Native sing-box；#158 在同一 head 单独执行了全量原生回归，全部 job 通过。云端 Codex 审查均覆盖表中的最终 head。顺序合并后的 `main@39480d0` 通过快速 CI。[合并后 CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/44878166989)

本地完整验收在干净的 `84e92e0eea7263493bc4774c06ca68b8c2cbbf7c` 上运行，范围为 `check-native`。443 项常规测试与 325 项原生集成测试全部通过，失败和跳过均为 0。该提交与合并提交的 pipeline 包树相同。[最终运行摘要](run/summary.json) · [文件清单与 SHA-256](run/files.json)

较早的 `8926b26` 在生成 TypeScript 声明时失败。最终修复导出了缺少的类型，60 个运行时 JavaScript 文件的字节均相同。较早的运行保留了当时的失败结果。[原始构建日志](prior-build/check.log) · [运行时文件摘要](runtime-identity.json)

从仓库根目录复核最终验收证据与四场景对照。证据检查需要一个尚不存在的输出目录。

```sh
mkdir -p .verification
node scripts/inspect-evidence.mjs --evidence docs/verification/spec-154/run --out .verification/spec-154-inspection
node docs/verification/issue-155/summarize.mjs docs/verification/issue-155/baseline.json docs/verification/issue-156/comparison.json
```
