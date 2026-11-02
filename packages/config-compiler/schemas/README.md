# 固定的上游 Schema

`sing-box-1.14.4.json` 是 `schemas/build.json` 所记录 binary 执行 `sing-box schema` 的原始输出。保留原始字节以核对 SHA-256；不得直接编辑生成的 Schema。

来源：[SagerNet/sing-box v1.14.4](https://github.com/SagerNet/sing-box/tree/v1.14.4/schema)。上游许可证声明原样保存在 `LICENSE.sing-box`。本目录不为整个项目另行指定开源许可证。

在 Config Compiler 模块目录执行 `pnpm generate:validator`，会核对摘要并使用锁定版本 Ajv 生成 standalone validator。构建产物不入库。目标版本或构建能力变化时，需要一起审阅 Schema、构建信息、Compiler 版本、Profile 能力和回归样本；不能只替换官网 Schema。
