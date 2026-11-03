# #17 稳定规则订阅消费验收

日期：2026-11-04。工单：[让 Recipe 通过规则订阅生成稳定远程规则配置](https://github.com/wangyingang/sing-box-config-manager/issues/17)。父 Spec：[Spec #14](https://github.com/wangyingang/sing-box-config-manager/issues/14)。

## 基线与独立性

从最新 `origin/main` 的 `0c92452` 创建同级 worktree，分支 `codex/issue-17`。
不读取或引入 #16 的实现，不修改原工作区分支。新增 Pipeline 内容仅为订阅契约数据与文档，
没有编译、远程获取、候选上传、激活或回滚运行时代码。

[Rule Subscription v1](../../../rule-set-pipeline/contracts/rule-subscription.md)
与不可变 Artifact Manifest 分别管理。Recipe／Template v2 显式选择稳定订阅；
v1 固定产物仍保持原义。后续激活须遵守契约中的用途、格式、版本和能力约束。

## 命令与结果

使用仓库声明的 pnpm 10.33.2，而不是机器默认的 pnpm 11。

```sh
pnpm install --frozen-lockfile
pnpm check
SING_BOX_TEST_BINARY=/Users/wangyg/.sbvm/versions/v1.14.4/sing-box-1.14.4-darwin-arm64/sing-box pnpm test:integration
git diff --check
```

- `pnpm check`：类型检查通过；Compiler 94 项、Pipeline 43 项常规测试通过，均 0 失败、0 跳过；构建及 Web App 公开声明／浏览器 bundle smoke 通过。
- `pnpm test:integration`：27 项通过，0 失败、0 跳过。
- `git diff --check`：通过。
- 指定 binary：`sing-box version 1.14.4`，Revision `c005f35300ce76427dc285481ec5695f5b179cd2`，go1.26.10 darwin/arm64。既有 checker 同时核对固定 Schema 摘要。

## 验收对应关系

| 工单要求 | 可复核证据 |
| --- | --- |
| 系统身份、稳定入口、用途、格式和能力约束；独立于 Manifest | Pipeline 的 `rule-subscription.schema.json`、示例和契约说明；JSON Schema 与 Compiler parser 的共同正反例 |
| 显式升级，绑定不接收固定产物版本或用户元数据覆盖 | `subscriptions.test.ts` 的 v1/v2 边界、URL／摘要／revision／格式／能力覆盖拒绝；公开声明 smoke 验证 v2 不能接受 curated binding |
| 公开入口生成稳定 SRS；保留本地 tag、HTTP client 和多个用途复用 | `subscription-fixtures.ts`，`resolveRecipe`、`compileRecipe` 与 `compile` 输出对照；Template 预设、重复步骤与顺序测试 |
| 未知契约、缺失订阅、空用途、错误位置、引用错误、Profile 失配 | `subscriptions.test.ts` 的结构与语义反例；DNS 具名／无 tag 响应、嵌套逻辑、定义顺序与目标 IP 检查；已解析 Compiler 入口绕过反例 |
| 配置及契约快照、发布时证据 | `prepareRecipePublication` 保存完整选中契约、输入摘要和两种 ECS 配置检查摘要；异步修改、契约篡改、未引用依赖及失败 checker 测试 |
| 真实 1.14.4 与既有配置发布流程 | `test/integration/subscriptions.test.ts` 调用 `prepareRecipePublication`、`publishRecipe`、`readPublication`、`renderSubscription`；两种 ECS 配置均真实 check，binary 不可用或用途为空时保留旧发布 |
| 不强制客户端更新周期／缓存；Compiler 纯函数 | 输出断言没有新增 `update_interval` 或 `experimental` 默认设置；已有显式 Template 缓存回归保持有效；浏览器 bundle smoke 无 Pipeline runtime、网络或子进程依赖 |
| Spec #1 历史回归 | 原有 81 项 Compiler 常规测试、26 项原生集成测试及五份 golden 均保留；固定产物 fixture 只增加 v1 类型防护，不改旧数据、策略或验收含义 |

本次增加 13 项 Compiler 常规测试和 1 项原生集成测试。
后续规则激活不要求修改 Recipe 或重新发布配置，但实际更新行为由父 Spec 后续工单集成验收。

## 证据边界

所有新规则订阅元数据都是受控 fixture；示例 HTTPS 地址不表示稳定入口已经发布。
本地临时目录的配置发布与真实 `sing-box check` 证明配置兼容和发布保护，
不证明远端文件当前内容、SRS 下载／加载、真实候选发布或客户端更新。
不可变产物字节摘要、远程回读、激活、失败保留、持久缓存重启及回滚的完整验收，
仍按 Spec #14 对应后续工单执行。配置快照中的摘要不声明稳定入口未来规则内容。
