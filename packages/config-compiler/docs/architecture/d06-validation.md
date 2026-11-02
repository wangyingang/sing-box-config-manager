# D06 验收与 M2 输入

日期：2026-11-02。测试在本机 Node.js 24 与 sing-box 1.14.4 执行；没有启动代理或加载设备配置。

本页保留 D06 原始验收记录，表中的 npm 命令是当时实际执行的命令。monorepo 迁移后，本地路径以 `packages/config-compiler/` 为基准，日常命令改为该目录中的 `pnpm check` 和 `pnpm test:integration`；从根目录执行同名命令会调度模块。迁移后的重新验证见[monorepo 迁移记录](../../../../docs/architecture/monorepo-migration.md)。

## 验收证据

| 检查 | 结果与范围 |
| --- | --- |
| TypeScript | `npm run typecheck` 通过。 |
| 单元与 golden 测试 | `npm test`，29 项通过，覆盖五份 golden、对象冲突、引用、DNS 步骤、能力、确定性、输入隔离、ECS、快照与发布失败保护。 |
| 原生集成 | `SING_BOX_TEST_BINARY=/absolute/path/to/sing-box npm run test:integration`，12 项通过、无跳过；缺少 binary 时失败。 |
| 原生 merge 审计 | 覆盖文件排序、浅目录扫描、对象与数组语义、false/null、未知字段、重复 tag、SSH 资源内联。 |
| 真实配置 | 五份脱敏片段重新执行官方 merge，对照固定 golden；Composer 候选保持语义与规则数组顺序；分别执行启用／不启用 ECS 的真实 check。 |
| 发布保护 | 本地成功发布后，binary 不存在导致新发布失败，当前指针仍指向原快照。单元测试额外覆盖第二种 ECS 检查失败、快照变化与并发修改输入。 |
| Bundle | `npm run build` 通过，生成浏览器目标核心包、Node 发布适配器和 TypeScript 声明；核心打包不引入 Node 内置模块。生成后的核心包已执行 compile/快照/ECS smoke test（mock checker）；Node bundle 已执行真实 check。不是 Worker 运行测试。 |
| 脱敏扫描 | 31 个源码、文档、Schema 与 fixture 文件对照旧仓库 29 项已知敏感值，未发现残留。 |

旧 Android golden 的原生 check 通过，不等于 Android 兼容。其进程规则由能力检查拒绝，正式 compile/preparePublication 不成功；独立的合法 package_name 场景证明平台合适的 Android Recipe 可以编译。App Store 两个 Profile 也拒绝旧桌面进程规则。

## 样本来源与脱敏

`test/fixtures/legacy/manifest.json` 固定两个旧仓库 revision、binary 信息、五种组合及 25 个系统规则产物。user-a/user-b/user-c/user-d 对应四个旧用户；user-b 额外有 android-tun。组合数量不代表五个客户端都已进行设备验收。

脱敏在内存中完成，之后才写文件：节点地址换为文档专用 IPv4/IPv6；UUID、密码、REALITY key/short_id、TLS 名称及 WebSocket path/Host 使用合成值；ECS 换为测试网段；用户文件名匿名化。原始配置和凭据没有复制进新仓库。

Remote Rule Set 的 URL 从可变 main 固定到规则仓库 commit；省略的 format 根据 .json/.srs 显式补齐。产物摘要读取本地对应文件；真实测试不下载远程规则，也不证明公网节点可连接。

需要有意刷新时运行：

```sh
python3 scripts/import-legacy-fixtures.py \
  --config-repo /absolute/path/to/sing-box-config \
  --rule-repo /absolute/path/to/sing-box-geosite \
  --sing-box /absolute/path/to/sing-box
```

脚本使用旧生成器选择片段，但不执行旧 generate 流程；不探测 IP、不更新旧 ECS、不写旧 output。先脱敏再执行官方 merge/check；所有样本验证通过且敏感值扫描通过后才写新 fixtures。日常测试仅消费快照，不依赖旧仓库。

### 允许的输出差异

`test/normalize.ts` 只处理已核实的 typed encode 差异：

- 规则省略默认 `action=route`；Inline Rule Set 省略默认 `type=inline`。
- 已列明的 Listable 匹配字段在单元素数组和标量之间转换。
- 与 URL 后缀一致的 Rule Set format 省略。
- `log.disabled=false`、local DNS `prefer_go=false`／空 neighbor_domain、空 API secret 的省略。
- HTTP client 默认 version=2 的显式化。

不通用删除 false、0、空对象或空数组；不排序任何数组。新增差异必须解释后修改这个有限列表，不自动接受更新的 golden。

## 尚未验证与下一阶段

未验证真实 Windows、macOS 两发行版、iOS、Android 设备运行；未启动 TUN、测试公网节点或远程规则加载；未部署 Worker、做在线缓存隔离或订阅鉴权测试。当前能力表覆盖已知进程/应用匹配和 Android DHCP 约束，不宣称完整客户端特性矩阵。

M2 按依赖顺序推进，以下事项不反向重开 D06：

1. 把当前已解析输入契约映射为可保存、可编辑的 Config Recipe Schema，明确模板可编辑字段与持久身份；保留显式有序 DNS/Route steps 和系统 curated Rule Set 引用。
2. 冻结最小 Rule IR、Artifact Manifest 和 DNS/Route projection 元数据，补齐 Pipeline 对 hash、不可变 URL、能力声明的生成与验证责任。
3. 单独处理旧 Android/App Store 的进程规则迁移。使用 package_name、域名或其他被确认的条件；不能静默丢弃现有条件。
4. 确认 ECS 掩码默认值及可信入口到发布/订阅参数的传递方式。本阶段没有将 /24 固定为产品规则。
5. 设计在线发布执行器、持久化和 Web API。把当前本地原子指针映射为实际存储的激活事务，保持两种 ECS check 完成后才切换。

D06 的运行接口和回归条件已具备；M2 完整领域 Schema 尚未冻结。
