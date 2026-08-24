# Explore 质量 benchmark

这套确定性的离线测试用于保护图提取、引用解析和 Explore 排序行为。运行时不下载外部
仓库、模型或测试数据。

运行 6 个 Explore 端到端 fixture：

```bash
npm run benchmark:explore-quality
```

运行 parser-to-graph 语言矩阵：

```bash
npm run benchmark:language-quality
```

语言矩阵包含 525 个带标签的案例，覆盖 C、C++、JavaScript、JSX、TypeScript、
TSX、Python、Java、Go、Rust、Vue 和 Svelte。测试内容包括本地与跨文件调用、
import/alias、继承、receiver 解析、dynamic boundary、负向精度和组件 wrapper。

另外 6 个 Explore fixture 分别检查 root recall、call-path recall、文件精度和源码覆盖。
两组共 531 个案例，并进入常规 unit-test job。

这些数字表示回归下限，不代表编译器级静态分析完备性。调整提取或排序策略时，应优先
增加语言无关的能力案例，避免写入特定仓库或符号名称。
