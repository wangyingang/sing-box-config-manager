# sing-box 1.14.4 merge 审计

核验日期：2026-11-02。结论仅针对下列固定源码与本机 binary，不外推到其他版本。

monorepo 迁移后，本文中的本地路径均以 `packages/config-compiler/` 为基准。源码结论、固定版本和原始探针结果保持不变。

## 证据基线

- sing-box：`v1.14.4`，binary revision `c005f35300ce76427dc285481ec5695f5b179cd2`。
- `sing`：`v0.9.7-0.20261023115459-5dc452e537bf`，来自该版本 `go.mod`。
- 原配置工程：`01fd03bc8cf1587770bf98d67e241b7068be49fe`。
- 规则工程：`34364dc11cc922443d3ecdfd310951be0bd64f9c`。
- 完整 binary 构建信息及 Schema SHA-256 见 `schemas/build.json`。

本次直接复核源码并新增可重跑的最小探针；未依赖交接文档链接中的历史聊天正文。

## 调用链与边界

`merge → readConfigAndMerge → readConfig → readConfigAt → mergeOptionsList → badjson.MergeJSON → Options.UnmarshalJSONContext → mergePathResources → Encode`。

| 位置 | 源码结论 |
| --- | --- |
| [cmd_run.go:48–100](https://github.com/SagerNet/sing-box/blob/v1.14.4/cmd/sing-box/cmd_run.go#L48-L100) | 每份文件先 typed decode；`-c` 和 `-C` 结果共同按保存的 `path` 字符串排序。`-C` 只收集直接子级、后缀严格为 `.json` 的文件。 |
| [cmd_run.go:111–130](https://github.com/SagerNet/sing-box/blob/v1.14.4/cmd/sing-box/cmd_run.go#L111-L130) | 多文件使用各自的 `RawMessage` 合并，固定 `disableAppend=false`；合并后再次 typed decode。单文件直接返回已解码 options。 |
| [badjson/merge.go:81–144](https://github.com/SagerNet/sing/blob/5dc452e537bf/common/json/badjson/merge.go#L81-L144) | 已有 destination 决定处理方式：对象递归补字段；数组追加；其他值保留 destination。类型冲突不是统一的覆盖操作。 |
| [options.go:39–50](https://github.com/SagerNet/sing-box/blob/v1.14.4/option/options.go#L39-L50) | 拒绝未知字段，保存原始消息并执行部分对象检查；不是先把每个片段重新序列化再合并。 |
| [cmd_merge.go:36–143](https://github.com/SagerNet/sing-box/blob/v1.14.4/cmd/sing-box/cmd_merge.go#L36-L143) | typed encode 会省略部分默认值、压缩单元素 Listable；部分 TLS/ECH/SSH 路径内容会内联。 |
| [cmd_check.go:29–46](https://github.com/SagerNet/sing-box/blob/v1.14.4/cmd/sing-box/cmd_check.go#L29-L46) | `check` 调用 `box.New` 后关闭实例，不执行 `Start`。 |
| [selector.go:79–109](https://github.com/SagerNet/sing-box/blob/v1.14.4/protocol/group/selector.go#L79-L109) | Selector 的成员及默认出站检查有一部分发生在 `Start`，说明 `check` 不是完整引用校验。 |

这里的“路径字符串”不等同于规范化绝对路径。源码没有在排序前对所有 `-c` 参数执行 `filepath.Abs`；目录扫描使用 `filepath.Join`。例如 `20.json` 排在 `dir/10.json` 之前，与 basename 的数字顺序不同。不要通过 `-c` 参数顺序表达优先级。

## 最小探针实测

`test/integration/merge.test.ts` 使用固定 binary，所有输入均为合成数据。

| 场景 | 1.14.4 实测结果 |
| --- | --- |
| 较早 `log.level=debug`，较晚 `info` | 输出 debug，逆序传递 `-c` 不改变结果。 |
| 较早 `timestamp=false`，较晚 true | false 保留，最终 typed encode 省略该字段。 |
| 后文件增加已有对象未定义的字段 | 字段补入。 |
| 两份相同规则数组 | 规则重复保留并按文件顺序追加。 |
| 两个 outbound 使用同一个 tag | 数组先追加，随后 merged options 解码报重复 tag。 |
| 较早 `log=null`，较晚对象 | 输出不含 log。不能据此将 null 定义为删除操作。 |
| 较早 log 对象，较晚 null | 合并报错。 |
| 未知字段或 log 为字符串 | 单片段 typed decode 失败。 |
| 目录中的嵌套 `.json` 和直接子级 `.JSON` | 都不读取；同层 `.json` 与显式文件统一排序。 |
| SSH `private_key_path` 指向可读合成文件 | 内容内联，去掉空行，路径字段仍保留。 |

`mergePathResources` 仅处理代码明确列出的资源，不是通用路径打包器。TLS certificate/key、ECH config/key、SSH private key 的读入行为见上述源码；SSH 会展开环境变量。读取失败时相关分支保留原 options，不保证 merge 报错。该失败分支是源码结论，未把它记为运行可用性验证。

`test/integration/native.test.ts` 另外证明：不存在的 Selector 成员和 `route.final` 仍可能通过 `check`。测试没有运行 `sing-box run`；不将实例构造成功等同于客户端启动、规则下载或网络可用。

## D06 结论

采用 TypeScript 领域 Composer。理由是显式表达对象选择、平台替换与策略顺序，减少围绕文件排序和数组追加的预处理。不是为了复刻 `MergeJSON`。

官方 merge 继续承担迁移对照；固定 binary 的 schema/check 继续承担原生结构与实例构造检查。两条路线都需要自己的引用检查。发布时预合并也能支持 Worker 只替换 ECS，因此不能将“动态订阅必须每次调用 merge”作为拒绝 merge 的理由。

Composer 的代价是维护支持范围、引用检查和客户端能力表。第一版只覆盖当前真实配置需要的对象及固定 1.14.4，不承诺通用 sing-box 配置编辑器。
