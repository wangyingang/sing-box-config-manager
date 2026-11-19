# 规则集可选来源调研

> **历史记录 · 2026-11-20**。本页保留接入清单第 5、6 节的选源结果。候选项均在本轮正式接入范围之外。[本轮接入 Spec #145](https://github.com/wangyingang/sing-box-config-manager/issues/145)

## Sukka 候选来源

下列文件均取自 `SukkaLab/ruleset.skk.moe` 的固定提交 `838801f009734aa324e7d42d7b7b51561d1df5ba`，产物为 sing-box Source Format v2。该 GitHub 产物仓库已归档。下表链接用于复查固定快照，正式接入前需核对现行发布入口。[产物仓库](https://github.com/SukkaLab/ruleset.skk.moe)

| 分类 | 固定快照中的文件 | 接入限制 |
| --- | --- | --- |
| 海外流媒体 IP（`stream-ip`） | [`sing-box/ip/stream.json`][stream-ip] | 只保留 `ip_cidr`，过滤上游标记域名，产出纯 IP 规则。供 Route 使用，按需支持 DNS response。 |
| CDN 域名（`cdn`、`cdn-extra`） | [`sing-box/domainset/cdn.json`][cdn]、[`sing-box/non_ip/cdn.json`][cdn-extra] | 两份文件互补，后者还包含 `domain_keyword`。可分别交付，由配置指向同一出口。 |
| 下载域名（`download`） | [`sing-box/domainset/download.json`][download] | 用于选择下载出口。同提交的 [`sing-box/non_ip/download.json`][download-non-ip] 只有标记域名。上游 sing-box 输出器跳过域名通配符和 URL 正则，此候选范围限于已导出的域名条件。[输出器源码][writer] |
| 测速域名（`speedtest`） | [`sing-box/domainset/speedtest.json`][speedtest] | 可用独立规则集选择测速出口。 |
| 广告、跟踪与恶意域名拦截（`reject`） | [`sing-box/domainset/reject.json`][reject] | 快照同时包含 `domain`、`domain_suffix`、`domain_keyword` 和 `ip_cidr`。接入纯域名版时按字段筛选。具体用途确定后再选择需要的投影。 |

本轮 `global` 采用 V2Fly 的 `geolocation-!cn`。若以后考虑 Sukka 的 [`sing-box/non_ip/global.json`][global]，需结合配套 CDN 规则重新评估覆盖范围。

## 尚未选定的来源

- xAI、Meta 等细分 AI 域名仍待比较。
- 通用海外 IP、通用 GFW IP、Anthropic 和 Gemini 等应用 IP 均未选定合适的单一上游。应用 IP 需要应用专用来源，整家云服务商的网段覆盖范围过宽。

[stream-ip]: https://github.com/SukkaLab/ruleset.skk.moe/blob/838801f009734aa324e7d42d7b7b51561d1df5ba/sing-box/ip/stream.json
[cdn]: https://github.com/SukkaLab/ruleset.skk.moe/blob/838801f009734aa324e7d42d7b7b51561d1df5ba/sing-box/domainset/cdn.json
[cdn-extra]: https://github.com/SukkaLab/ruleset.skk.moe/blob/838801f009734aa324e7d42d7b7b51561d1df5ba/sing-box/non_ip/cdn.json
[download]: https://github.com/SukkaLab/ruleset.skk.moe/blob/838801f009734aa324e7d42d7b7b51561d1df5ba/sing-box/domainset/download.json
[download-non-ip]: https://github.com/SukkaLab/ruleset.skk.moe/blob/838801f009734aa324e7d42d7b7b51561d1df5ba/sing-box/non_ip/download.json
[speedtest]: https://github.com/SukkaLab/ruleset.skk.moe/blob/838801f009734aa324e7d42d7b7b51561d1df5ba/sing-box/domainset/speedtest.json
[reject]: https://github.com/SukkaLab/ruleset.skk.moe/blob/838801f009734aa324e7d42d7b7b51561d1df5ba/sing-box/domainset/reject.json
[global]: https://github.com/SukkaLab/ruleset.skk.moe/blob/838801f009734aa324e7d42d7b7b51561d1df5ba/sing-box/non_ip/global.json
[writer]: https://github.com/SukkaW/Surge/blob/32f900e8759db8276cf6c9dcd0cc81f19c61c58f/Build/lib/writing-strategy/singbox.ts#L152
