# Spec #14 最终集成验收归档

验收日期：2026-11-04（Asia/Shanghai）。代码基线为 `6ec308a964fcce737ac3b627cc54aba27f7f0b42`。

本目录原样归档已执行的父 Spec 最终验收证据，不表示在归档提交上重新执行。此前发布的[验收总结](https://github.com/wangyingang/sing-box-config-manager/issues/14#issuecomment-6613968065)及原始需求、子工单历史保持不变。

| 文件 | 内容 |
| --- | --- |
| [summary.json](summary.json) | 固定提交、环境、命令及检查结果 |
| [check.log](check.log) | 187 项常规测试、类型检查、构建及 workspace smoke |
| [integration.log](integration.log) | 102 项真实 sing-box 1.14.4 集成测试 |
| [release.log](release.log) | 固定官方 Release 两次下载与确定性构建验收 |
| [client-update-rollback.json](client-update-rollback.json) | 同配置、同进程的 A → B → A Route／DNS 行为 |
| [client-failure-cache.json](client-failure-cache.json) | 四类更新失败、恢复更新及缓存离线重启行为 |
| [remote-readback.json](remote-readback.json) | 32 个已交付远程文件的实际摘要与字节数核对 |
| [install.log](install.log) | 隔离副本的锁文件依赖安装记录 |
| [SHA256SUMS](SHA256SUMS) | 上述文件在最终验收时保存的原始摘要 |

远程发布、激活和回滚的历史操作证据仍位于[各子工单验收目录](../../../packages/rule-set-pipeline/docs/verification/)。本次最终验收只重新构建、运行受控客户端并读取远程文件，没有生产切换或其他远程写入。真实路径、临时端口与 PID 是当次执行记录；其中的测试配置和网络对象属于隔离 fixture。
