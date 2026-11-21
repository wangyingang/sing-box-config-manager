# #164 空状态首次交付验收

正式 YAML 的 `china-ip` 和 `chatgpt-voice` 均在原稳定目录使用 `ips.json` 和 `ips.srs`。Route 和 DNS Response 共用文件，DNS Query 不可用。逐项对照合入 #163 后的基线 `5441124`，正式配置只有这两个 IP 集的四处 `artifact` 变更。14 个域名集的来源、用途、稳定路径和文件名一致。 [工单 #164](https://github.com/wangyingang/sing-box-config-manager/issues/164)

## 隔离结果

| 检查 | 结果 |
| --- | --- |
| 空目标及首次 `sync` | 初始 16 集均未交付且无候选。一次 `sync` 成功交付 16 集，每集有一个当前可选候选。 |
| 真实 GitHub 回读 | 校验 16 个 Manifest。32 个固定候选地址、32 个固定交付地址和 32 个隔离稳定订阅地址的 JSON/SRS 正文与登记的字节数、SHA-256 一致。 |
| 新旧 IP 名称 | 两个稳定目录各含 `activation.json`、`ips.json` 和 `ips.srs`。四个旧 `route.json` 和 `route.srs` 的隔离稳定地址返回 HTTP 404。 |
| 原生 1.14.4 | 首次交付编译 16 次，每集执行 JSON 和 SRS 加载。两集 IP 的同一输入在改名前后分别生成相同的规则字节。IPv4 和 IPv6 的正负样本在两种格式、两个名称下共 32 次实际匹配均符合预期。 |
| 隔离收尾 | 删除随机隔离分支。生产 `main`、`candidates` 和更新、清理门禁的前后快照一致。 |

采用固定 V2Fly Release `20261118141523`、四个固定 Git commit 的真实正文和受控 ChatGPT Voice 双栈样本。逐集来源、构建命令、订阅、Manifest、HTTP 回读和匹配结果见 [delivery.json](delivery.json)。文件 SHA-256 为 `646f8bc3383d74cb616a27278629a34c38ffb53f684c33f064ba24901cbd9fce`。其中 `binarySha256` 对应实际 sing-box，发布构建的 `toolSha256` 对应调用该 binary 并记录命令的包装器。

首次同步使用干净提交 `b73284b`。首次探针在同步与稳定正文核验成功后，因结果按来源分组、断言按 YAML 顺序而停止。修正为按逻辑 ID 核对后，将同名隔离分支临时指回原交付提交 `ca0c3db683b448a67b304afcb9cf7d621e7c6334`，补验候选、旧 URL 和双栈匹配。补验维持原交付提交及版本，并在完成后删除分支。两次执行之间的运行时代码和正式配置一致。

提交 `ca5f00f` 的本地统一验证通过 445 项常规测试和 327 项原生集成测试，失败与跳过均为 0。

## 运行边界

从空状态执行完整探针的入口见 [Pipeline 自动化验证](../../../packages/rule-set-pipeline/README.md#自动化验证)。隔离稳定地址仅用于本次验收，分支清理后以归档的回读结果为准。

生产切换另行授权。切换时从空受管状态重新登记候选和稳定订阅，旧候选、版本、pin 和在途记录随原状态退役。两集旧 IP URL 的引用需要更新为 `ips.json` 或 `ips.srs`。14 个域名集在各自重新交付后恢复原稳定地址。 [空产物状态与 IP 改名](../../../packages/rule-set-pipeline/README.md#两个-ip-集的订阅文件改名)
