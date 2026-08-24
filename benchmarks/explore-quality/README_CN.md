# Explore 质量基准

这个离线基准覆盖 C、C++、JavaScript、JSX、TypeScript、TSX、Python、Java、
Go 和 Rust，用于验证图提取与 Explore、Impact、Callers、Callees 查询行为。
fixture 中包含测试文件和跨文件同名符号干扰项。

在仓库根目录运行：

```bash
npm run benchmark:explore-quality
```

输出 JSON：

```bash
npm run benchmark:explore-quality -- --json
```

运行固定 commit、带人工标注的真实仓库评测：

```bash
npm run benchmark:explore-real
npm run benchmark:explore-real -- --codegraph
```

运行从解析器到图查询的多语言矩阵：

```bash
npm run benchmark:language-quality
```

矩阵目前覆盖 10 种结构化代码语言以及 Vue、Svelte 组件包装格式，共 512 个 case。每个 case 都会解析真实语言
语法、构建并解析 SQLite 图、执行 Explore，并在存在依赖关系时检查 Impact。公共
覆盖包括声明、本地/重复/链式/递归调用、成员 receiver、继承、类型引用、限定外部
调用和未解析边界。每种语言另有 5 个多文件 case，覆盖 import、alias/namespace、
跨文件调用、继承和类型引用；语言特有覆盖还包括 decorator、annotation、async、接口与
supertrait 嵌入、静态/associated 调用、C++ 虚继承、Go defer/goroutine 和 Rust
trait implementation。

报告会分别展示确定性边、动态边界、负向精度和多文件覆盖。`512/512` 只表示所有
已标注 case 通过，并不表示动态语言中的运行时分派都能被静态、完整地解析。

其中 8 种具有显式继承语法的格式还会运行 parser-to-presentation 自适应裁剪
case：四文件实现族必须只保留一个完整代表实现，并把另外两个实现渲染成签名
骨架。Go 由结构化 interface 的真实仓库 case 覆盖；C 没有对应的继承结构。

`real-cases.json` 为十种格式的真实仓库 Explore、Impact、Callers 和 Callees 查询记录必选、可选和明确禁止的文件。
runner 输出必选召回率、可选覆盖率、禁止文件噪声率、输出长度和耗时，并在
运行前校验仓库 commit，避免标签随代码变化而静默失效。

必选覆盖同时统计文件断言和语义输出断言；总体覆盖按实际标注条数加权，而不是先把
每个 case 的百分比做平均。没有可选标注的 case 显示 `optional=n/a`，不会再用空指标
把总体可选覆盖率虚增到 100%。

`requiredOutput` 与 `forbiddenOutput` 描述 zvec 自身的展示契约。启用
`--codegraph` 后，两边仍共用文件和路径断言；只有 case 明确提供
`codegraphRequiredOutput` 或 `codegraphForbiddenOutput` 时才检查 CodeGraph
文本，避免把 CLI 格式差异误判成图质量缺失。
Explore case 还会把同一个逐 case `maxFiles` 预算传给两个 CLI，避免工具默认输出
规模不同被误算成召回差异。

真实 case 还可约束 `requiredOutput`、`requiredFilePatterns`、`minFiles` 和
`maxFiles`。因此接口查询不仅要命中文件，还必须包含调用入口、动态边界和代表实现；
缺少这些语义内容时不能用“文件命中率 100%”掩盖失败。

指标包括：

- `rootRecall`：预期查询符号成为图种子的比例。
- `pathRecall`：预期调用路径的召回率。
- `filePrecision`：测试文件和无关同名文件未进入源码包。
- `sourceCoverage`：预期的当前磁盘方法体是否进入上下文。

小型确定性 fixture 用于隔离 Explore 排序行为，多语言矩阵覆盖从解析到查询的
正确性，固定真实仓库评测则衡量代表性的最终输出质量。与 CodeGraph 做人工对比时，
应在同一仓库运行相同查询，对比 roots、call paths、源码文件和低价值文件数量，
而不是只比较输出长度。

耗时结果默认包含 CLI 冷启动，因此 Query 还会计入 Node 进程、模型获取和 query embedding；
它衡量检索端到端延迟，但不能单独代表图后端性能。固定 worktree 使用 `--refresh off`，
workspace freshness scan 由 CLI E2E 单独验证，避免污染每个质量对比。定位回归时应结合
`--debug` 的阶段耗时，并补充常驻 daemon/service 的 warm-session 测量。可选召回用于发现
有价值但非必需的上下文，不能以增加无证据动态边或无界扩展来换取分数。

当前固定 42-case suite 的结果是必选召回 100%、可选召回 79%、禁止文件噪声 0%。
其中 Vue `CounterStore` Query 会通过真实 `IMPORTS` / import-binding `REFS` 自动带出 Pinia store，
并召回共享该 store 的两个可选组件；这不是框架名称特判。
对剩余 optional 缺口使用相同文件预算抽样对比时，zvec 为必选 100% / optional 40%，
CodeGraph 为必选 53% / optional 20%。这些 optional 标签主要用于观察排序取舍，不能直接作为
继续扩大子图的修复目标。

可单独测量不包含重复进程/模型冷启动的 Query 延迟：

```bash
node benchmarks/explore-quality/run-warm-query.mjs /path/to/repo 'SymbolName' 4
```

第一次迭代包含 service/model 初始化，后续迭代复用同一 service，并同时输出内部阶段耗时和墙钟耗时。
最后一条记录会分开输出冷启动耗时与热查询 median/p95，避免进程启动波动掩盖 read-session 回归。
