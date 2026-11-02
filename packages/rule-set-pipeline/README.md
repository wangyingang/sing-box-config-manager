# Rule Set Pipeline

包名：`@sing-box-config-manager/rule-set-pipeline`。当前仅建立工作区骨架，没有采集、转换或发布实现，也没有占位测试。

后续职责：

- 获取系统维护的规则源，通过独立 Parser 转换为最小 Rule IR。
- 标准化、去重并报告不支持或无效规则。
- 按 DNS／Route 使用场景生成 JSON／SRS，执行质量检查。
- 发布版本化规则文件及来源、摘要、客户端能力等元数据。

Config Compiler 通过这些文件和元数据使用规则，不导入 Pipeline 源码，也不在配置请求中实时运行 Pipeline。

pnpm manifest 当前仅用于工作区识别；不限定后续使用 Python 或 TypeScript。现有 sing-box-geosite 仓库尚未迁入，本次没有改变其定时任务或发布流程。
