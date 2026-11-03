# #22 显式重建固定 Release 验收

2026-11-04，基于 `origin/main` 的 `03f506e`，在独立 `codex/issue-22` worktree 执行；未使用 #20 的未提交内容、状态、缓存或远程稳定入口。

## 实现行为

- CLI `rebuild --release <processed-tag> --state <directory> --binary <absolute-path>` 和 `rebuildRules` 只接受状态目录中已固定且成功处理的 Release，通过持久 Release ID 获取元数据，不解析 latest。
- 正常更新与重建共用来源复验、转换、真实原生验证、不可变发布和 HTTPS 回读门禁。
- 新候选记录操作类型、原成功候选与构建身份。构建记录包含固定来源、实际运行实现摘要、工具与 binary 身份、契约版本及产物摘要。同工具的重建复用确定性构建身份，每次尝试使用新的候选 ID。
- 重建成功或失败均保留原成功处理记录及历史候选，不写稳定入口；正常更新仍跳过已处理版本。

## 执行结果

- `pnpm --config.verifyDepsBeforeRun=false check`：通过，Compiler 96 项、Pipeline 89 项，类型、构建和 workspace smoke 均通过。
- `SING_BOX_TEST_BINARY=/Users/wangyg/.sbvm/versions/v1.14.4/sing-box-1.14.4-darwin-arm64/sing-box pnpm --config.verifyDepsBeforeRun=false test:integration`：通过，Compiler 27 项、Pipeline 60 项。Pipeline 包含 #22 独立的 8 项原生集成测试，覆盖字节确定性、历史保留、下载／native／上传／回读失败、资产身份／内容变化及 binary 身份变化。
- 新增 CLI 与输入保护测试使用独立文件，拒绝 latest、未知 Release、缺少必需参数与 update 固定 tag。
- 使用 `--config.verifyDepsBeforeRun=false` 是为绕过本机 pnpm 在运行前自动安装时生成 `allowBuilds` 占位值的行为；依赖已从本机 store 安装，未提交该无关配置迁移。实际脚本与 CI 保持不变。

真实远程验收命令：

```sh
RULE_REBUILD_STATE=/tmp/issue-22-20261104-state \
RULE_REBUILD_EVIDENCE=/tmp/issue-22-20261104-evidence.json \
RULE_REBUILD_BRANCH=acceptance-issue-22-20261104 \
SING_BOX_TEST_BINARY=/Users/wangyg/.sbvm/versions/v1.14.4/sing-box-1.14.4-darwin-arm64/sing-box \
pnpm --config.verifyDepsBeforeRun=false --dir packages/rule-set-pipeline test:rebuild
```

结果：1 项通过。完整记录见 [issue-22.evidence.json](issue-22.evidence.json)。凭据仅在内存传递，证据不含 token。

## 固定来源与远程证据

固定官方 Release `20261102130044`，ID `431467724`，源码 commit `328f6c5168653e809561c862757c966fc5012e5d`。YAML 实际 SHA-256 为 `bfa4ab62d0f47216029ce6b777a2364978c3f28086060b592453684a0dd830ee`，共 3,758,877 字节。

专属远程分支为 `acceptance-issue-22-20261104`；只追加候选文件，不复用共享候选分支，不写稳定文件或激活记录。

- 原成功候选：`2fd076eb-d65a-4088-809e-0316cfe76ece`，[HTTPS 回读证据](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/843b7a80b40b744cf70079bde067ca492c1c1b63/candidates/2fd076eb-d65a-4088-809e-0316cfe76ece/readback.json)。
- 重建候选：`0e83e2a7-6c13-4c7b-b76c-b0de444430e5`，[HTTPS 回读证据](https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/30970b57766fc7add45170befdded4358ba1333f/candidates/0e83e2a7-6c13-4c7b-b76c-b0de444430e5/readback.json)。
- 两次构建身份相同：`194d33f9d4f0a8a961839a5551480dff9456fe79b3aec3adce42d9f0b2b85969`。

| 文件 | 实际 SHA-256（两次相同） | 字节数 |
| --- | --- | --- |
| domains.json | `181b855217d871ed8f0ec40923a8606489c5ffb0fe0b14de3c47aeeb0a5a63d5` | 6316 |
| domains.srs | `b66a1797d2850ba2c2c632ae6f61cb40184134a3d4bcb584dc07273361c167d5` | 2164 |

真实验收先发布原候选，注入缺失 binary 的重建失败，再按原固定 Release 重试成功。重新下载原候选全部历史文件并核对摘要，成功处理记录与原值一致。正常更新跳过探针调用真实 `updateRules` 的 latest 路径，由验收适配器返回固定样本的真实 ID 元数据；只发生一次元数据查询，不下载资产或启动 binary。该探针不声称旧样本仍是官方 latest。

本工单不执行激活、客户端自动更新或回滚；已有显式激活流程保持原样，相关回归随集成检查通过。
