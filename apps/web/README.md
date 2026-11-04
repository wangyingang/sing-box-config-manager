# Configuration Manager Web App

包名：`@sing-box-config-manager/web-app`。当前只有工作区骨架和对 Config Compiler 的 `workspace:*` 依赖，没有前端框架、页面、HTTP API、数据库或部署配置。

## 当前状态与已确认职责

已经确认的管理模式是：管理者统一维护自己、家人和朋友的配置；配置使用者主要获取文件或订阅，不各自登录编辑。不同配置使用者的 Recipe 可以共享固定节点修订，但共享节点不意味着可以访问彼此的配置。Recipe 是管理者保存的配置选择，记录模板、节点和策略；详见 [Compiler 的配置生成流程](../../packages/config-compiler/README.md#从配置选择到完整配置)。管理模式依据见 [ADR 0002](../../docs/adr/0002-admin-managed-configurations.md)。

未来应用负责用户和设备配置、节点及策略编辑、预览、生成、下载、订阅和版本管理。它需要完成管理授权、保存草稿和修订、加载可信依赖、组织发布以及隔离不同配置交付目标。配置生成调用 Compiler，不能在页面中另行实现 JSON 组合逻辑。

Compiler 提供的编辑判定和发布函数不等于这些服务已经实现。例如，节点修订能否删除需要宿主查询真实引用并保证事务一致；`renderSubscription` 只生成配置内容，不验证 HTTP 订阅令牌。

## 包调用与工作区验证

```ts
import { compileRecipe, renderSubscription } from '@sing-box-config-manager/config-compiler';
```

Compiler 核心入口可以用于浏览器环境；`/publisher` 需要 Node 文件系统和子进程，不能直接放入浏览器或普通 Cloudflare Worker。在线原生检查执行器如何部署仍需后续设计，当前边界见 [Compiler 的发布说明](../../packages/config-compiler/README.md#配置发布及失败后的状态)。

从仓库根执行 `pnpm build` 后，`pnpm smoke:workspace` 会在本工作区创建临时消费者，验证 Compiler 包解析、类型声明和浏览器打包，结束后清理。该检查不代表已有 Web 页面、开发服务器或应用测试。当前没有 Web 构建、开发服务器或测试命令。
