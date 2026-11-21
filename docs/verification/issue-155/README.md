# 16 个规则集的串行同步基线

在 darwin/arm64、Node v26.13.0 和 sing-box 1.14.4 上，通过 `syncRules` 同步正式配置的 16 集、6 来源。每轮从空仓库做首次交付，然后分别从该轮首次交付完成时的同一份快照开始另外三个场景。每个场景执行五次，表中为各指标的中位数。

| 场景 | 新交付 / 未变 | 总时间 ms | 稳定校验 ms | 取源 ms | 原生构建 ms | 工具身份检查 ms | Git 写入 ms | 校验读取数 | 校验读取字节 | 提交数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 首次交付 | 16 / 0 | 8967.46 | 8.78 | 563.20 | 2829.80 | 5277.01 | 2.37 | 528 | 17,001,665 | 113 |
| 全部未变 | 0 / 16 | 1361.34 | 15.73 | 2.09 | 0 | 1306.79 | 0 | 1216 | 34,554,536 | 0 |
| 同一 V2Fly 来源变化 | 2 / 14 | 2752.38 | 17.70 | 527.21 | 305.20 | 1811.12 | 0.91 | 1344 | 38,026,925 | 23 |
| 两个 Git 来源变化 | 2 / 14 | 2212.07 | 17.68 | 6.21 | 331.54 | 1787.33 | 0.25 | 1344 | 38,026,860 | 14 |

取源覆盖来源标识解析、读取和转换。原生构建计 `buildWithTool`，工具身份检查单列 `inspectBinary`。Git 写入计内存仓库 `commit` 及其 guard。稳定校验计完整交付记录校验和路径归属检查，同阶段嵌套调用只计一次。墙钟还包括候选和回执读回、journal 处理及其他开销。校验读取数和字节数是调用快照 `read` 的逻辑量，实际 GitHub 对象缓存、网络请求数和远端延迟需另测。

## 输入与对照

[固定构建记录](../issue-149/fixed-builds.json)提供 V2Fly Release、四个 Git 文件、语音来源的受控样本和原有产物 SHA-256。同来源场景只给 `openai`、`anthropic` 各增加一个可辨认的域名；多来源场景只给 `gfw`、`onedrive` 各增加一个域名。每次核对 16 集的结果、当前与观察到的来源、稳定文件的字节数和 SHA-256、发布时间及版本是否沿用。改变来源但内容未变的规则可保留原交付，同时推进成功输入记录。

[原始数据](baseline.json)记录每轮指标、四个场景的逐集事实、二进制与探针摘要。被测提交为 `543add278db38b49ed77039b30d49d38b553bed1`，pipeline 源码树为 `8f816cc3747a4a77a79f5a05b8d3925d717c97b5`。计时使用本地上游响应、内存 `candidates` 和 `main` 两个 Git 引用及其产物读回，实际调用本机 sing-box。

## 复跑

用安装了锁文件依赖的 checkout 执行。先把 `SING_BOX_TEST_BINARY` 设为 sing-box 1.14.4 可执行文件的绝对路径。下列命令从仓库根目录开始。首次准备输入需要访问固定上游文件，缓存齐全时可离线运行。输出文件必须是新路径。

```sh
cd packages/rule-set-pipeline
probe_dir=../../docs/verification/issue-155
replay_dir=$(mktemp -d)
node "$probe_dir/measure.mjs" prepare "$replay_dir"
node --import tsx "$probe_dir/measure.mjs" run "$replay_dir" ../.. "$replay_dir/baseline.json" 5
node "$probe_dir/summarize.mjs" "$probe_dir/baseline.json" "$replay_dir/baseline.json"
```

复测其他实现时保持探针、输入、Node 和 sing-box 不变，将 `run` 的 checkout 参数换成该实现的工作区。对比命令会先核对配置、探针、运行环境和全部逐集事实，再输出各阶段的中位数。
