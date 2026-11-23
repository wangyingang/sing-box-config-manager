# #170 v4 配置校验与共享发布目录验收

[PR #178](https://github.com/wangyingang/sing-box-config-manager/pull/178) 基于 `main` 的 `21546dd` 复验，包含 #171 的固定 URL、#172 的 GitHub 分支文件和 #173 的原生组合规则改动。最终受测 PR 提交为 `f818875`。Squash 合并提交为 `8a04d0e3c8599138805fcc835ccc237ad33510b5`，文件树与受测提交一致。[工单 #170](https://github.com/wangyingang/sing-box-config-manager/issues/170)

- Red Hat YAML 1.24.0 实测字段补全、获取方式对应的格式补全、悬停说明和结构诊断。同步入口为跨 source 引用、列表和过滤条件、重复输出提供行列号和字段路径。
- 独立目标 `acceptance-issue-170` 使用受控上游、内存 Git 和 sing-box 1.14.4。两集共享发布目录时四个文件可读，移除一集并执行历史清理后，另一集保留原版本和文件字节。实际产物发布和正式 16 集配置迁移由后续工单跟踪。
- 最终提交通过 61 项定向测试。统一验收入口的 `check-native` 在干净工作区通过 468 项常规测试和 362 项原生集成测试，零失败、零跳过。
- 常规 CI、Linux 原生 CI 和云端复审均覆盖 `f818875`，无审查 findings 或未解决讨论。 [常规 CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45163943637) · [Linux 原生 CI](https://github.com/wangyingang/sing-box-config-manager/actions/runs/45163991882) · [云端复审](https://github.com/wangyingang/sing-box-config-manager/pull/178#issuecomment-7099471330)

[证据包](evidence.tar.gz) 的 SHA-256 为 `90420b2486f429cb6f940c4885034b1f192672da3f18eadaafb78d214c050f84`。包内 `files.json` 记录每份证据的长度和 SHA-256。最终验收由 `evidence/latest-main/check-native-f818875/` 保存，编辑器只读探针输出和定向测试日志同在 `evidence/latest-main/`。早期复现和验收日志保留各自的源码身份与结果。
