# 16 集串行同步的工具身份检查对照

在本机，16 集全部未变时，把重复的 SHA-256 换成逐字节比较，每次同步的配对中位数节省 **452 毫秒**。同一来源两集变化节省 **411 毫秒**，两个来源各一集变化节省 **392 毫秒**。首次交付没有命中。Node 进程峰值 RSS 的中位数从 **551.81 MiB** 升至 **631.50 MiB**。

建议保留正式 pipeline 现有的工具检查和串行交付。此次改动最多为这三种本地重复同步省下约半秒，每次命中场景需要额外持有一份约 80 MiB 的二进制。本轮采用本地 Git 和上游回放，收益不能直接折算成 GitHub 工作流的提速。如果实际任务需要缩短这部分等待，可将实现限定在「已交付规则能否复用成功输入」的判断。

## 五组配对结果

两种策略各运行四个场景五次。每组使用两个新的 Node 进程，按轮次交替先后顺序。一次进程顺序处理首次交付、全部未变、同来源变化和多来源变化。后三个场景分别从该轮首次交付完成时的快照开始。时间单位为毫秒。

| 场景 | 整次同步中位数，逐次哈希 → 字节复用 | 配对节省中位数 | 工具检查中位数，逐次哈希 → 字节复用 | 全部工具检查次数 | 成功输入检查中完整哈希次数 | 原生构建 / Git 提交 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 首次交付 | 8,977.25 → 9,040.69 | −38.80 | 5,257.43 → 5,282.47 | 64 | 0 → 0 | 16 / 113 |
| 全部未变 | 1,358.48 → 913.95 | 452.38 | 1,310.43 → 866.53 | 16 | 16 → 1 | 0 / 0 |
| 同一 V2Fly 来源两集变化 | 2,764.04 → 2,364.50 | 411.35 | 1,821.41 → 1,430.27 | 22 | 14 → 1 | 2 / 23 |
| 两个 Git 来源各一集变化 | 2,216.44 → 1,837.52 | 391.91 | 1,796.71 → 1,419.65 | 22 | 14 → 1 | 2 / 14 |

配对节省先按同一组的两次墙钟相减，再取五组中位数。全部未变的五组分别节省 403 至 456 毫秒。首次交付的差异分布在实验策略慢 229 毫秒至快 6 毫秒之间，两边都执行原有构建检查。每轮核对 64 组规则与场景结果，稳定 JSON/SRS 摘要、当前和观察到的来源、首次发布时间、交付状态及版本沿用关系均一致。各场景的工具探测、原生构建和提交次数也一致。[固定输入与四个场景](../issue-155/README.md) · [逐轮数据与规则结果](results.json)

## 工具校验和内存

两侧均运行同一份 pipeline 源码和计时探针。实验只在已交付规则核对成功输入时介入。每次仍重新解析路径、运行 `sing-box version`、验证 1.14.4 并读取当前文件。首次计算完整 SHA-256，后续只在读回的字节与上次完全相同时沿用摘要。遇到不同字节重新计算。原生构建及其结束时的工具替换检查仍走原来的代码。

每次 `syncRules` 调用各有一份实验状态，结束时释放引用。该二进制为 83,934,930 字节（80.05 MiB），实验最多保留上一次成功哈希的这份内容。RSS 取 Node 进程处理完整四场景期间的高水位再跨轮取中位数，包含 JS 堆、Buffer 和进程运行开销，未计入 sing-box 子进程。峰值中位数差为 79.69 MiB。

隔离回归通过公开 `syncRules` 在两集之间改写同一路径的等长工具文件并恢复修改时间、改向符号链接、让相同字节的 wrapper 报错版本或以非零状态退出。两种策略各通过 4 项，重试使用同一 context。另有 3 项现有回归通过，覆盖 pin 期间更换工具、原生命令中途更换工具以及失败后同操作重试。[替换和恢复用例](guards.test.mjs) · [原生验证回归](../../../packages/rule-set-pipeline/test/integration/rules-performance.test.ts)

本实验只在测量进程加载模块时替换一次摘要计算，磁盘上的生产源码与历史工具指纹保持原样。如果修改正式 `native.ts`，其源码字节参与所有输入格式的构建工具指纹，已有成功记录在升级后会触发重新构建。生产实现需要单独验证从旧版本交付状态升级，实验本身不会引发这项成本。[构建工具指纹](../../../packages/rule-set-pipeline/src/configured-build.ts) · [成功输入资格判断](../../../packages/rule-set-pipeline/src/rules-success.ts)

## 复核与复跑

本次被测提交为 `c29a41b21c420bbd12e400867c47e0bc6c386a04`，运行环境为 darwin/arm64、Node v26.13.0 和 sing-box 1.14.4。完整二进制、源码树、配置、依赖、fixture、两层探针的身份与十次进程的原始结果保存在 [results.json](results.json)。在仓库根目录运行 `node docs/verification/issue-160/report.mjs` 可复核探针身份、与 #156 归档的 64 组结果及各项中位数。

复跑前按锁文件安装依赖，并将 `SING_BOX_TEST_BINARY` 设为 sing-box 1.14.4 的绝对路径。以下命令从仓库根目录开始。准备固定输入会读取上游，输入齐全后的计时与回归在本地完成。结果文件应为新路径。

```sh
probe_dir="$PWD/docs/verification/issue-160"
run_dir=$(mktemp -d)
node docs/verification/issue-155/measure.mjs prepare "$run_dir/inputs"
node "$probe_dir/run.mjs" "$run_dir/inputs" "$run_dir/results.json" 5
node "$probe_dir/report.mjs" "$run_dir/results.json"

cd packages/rule-set-pipeline
for mode in baseline reuse; do
  RULE_TOOL_EXPERIMENT="$mode" node --import tsx --import "$probe_dir/hook.mjs" "$probe_dir/guards.test.mjs"
done
RULE_TOOL_EXPERIMENT=reuse node --import tsx --import "$probe_dir/hook.mjs" --test \
  --test-name-pattern='工具摘要变化时|执行中途工具发生变化时|失败的原生加载可' test/integration/rules-performance.test.ts
```
