# Configuration Manager Web App

包名：`@sing-box-config-manager/web-app`。当前仅建立模块骨架和对 Config Compiler 的 `workspace:*` 依赖，没有前端框架、页面、HTTP API 或部署配置。

后续负责用户和设备配置、节点及策略编辑、预览、生成、下载、订阅和版本管理。配置生成调用 Compiler，不在 UI 中重复实现 JSON 组合逻辑。

```ts
import { compile, renderSubscription } from '@sing-box-config-manager/config-compiler';
```

Compiler 的 `/publisher` 是 Node 专用入口；在线校验服务的部署方式留待后续确定，不能将这个入口导入浏览器或普通 Cloudflare Worker。

从仓库根执行 `pnpm build` 后，`pnpm smoke:workspace` 会在本工作区创建并清理临时消费者，验证真实的包解析、类型声明和浏览器打包。这属于工作区验证，不代表 Web 功能已经实现。当前没有 Web 构建、开发服务器或测试命令。
