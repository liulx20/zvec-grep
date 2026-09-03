# Zvec-Grep Explore 源码组装

本文基于 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac)，从“最终文件已经选好”开始，说明如何生成源码 context。

## 1. 总流程

[`assembleExploreFiles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L34-L168) 执行：

```text
selected files
  → 按文件取得候选 symbols
  → 读取当前完整源码
  → range 去重和 symbol 排名
  → 建立 render plan / clusters
  → 估算文件容量
  → 分配全局字符预算
  → 渲染 complete body / focused excerpt / skeleton
```

文件选择和 central 角色已经由 [`selectExploreFiles()` / `assignFileRoles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L108-L205) 完成，不属于 Assembly。

`central` 只是展示和预算角色：exact 通常优先 root 文件，concept 优先 semantic seed；不足时可补 counterpart、direct flow 或 integration 文件。它不改变 relevance，也不让未入选文件重新入选。

## 2. 什么时候读取源码

只有最终入选文件才进入 [`prepareExploreFile()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L190-L238)，并在这里调用 `storage.readFileText?.(file)`。

```text
文件选择前：索引实体、ranges、图边和分数
文件选择后：读取已选文件的当前完整文本
```

读取成功使用当前磁盘源码；失败时回退到 indexed fragment，并通过 `sourceOrigin` 明示来源。

## 3. 哪些 Symbols 有资格展示

Symbol 经过四层漏斗：

```text
1. Subgraph CandidatePool：没有被召回的 symbol 无资格
2. File Selection：所在文件未入选则整体出局
3. Range Dedup + rankSymbols：处理父子覆盖并确定优先级
4. renderFileText：真正能放进字符预算才输出
```

实体转 snippet 在 [`toSymbolSnippet()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L419-L440)。父子 range 由 [`preferNestedSourceSymbols()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L289-L331) 和 [`removeContainedSymbols()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L391-L418) 处理。

[`rankSymbols()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L441-L530) 综合：

```text
root / counterpart
call path / structural bridge
直接执行关系
query coverage
node score
focus line
```

它不是简单选择前 N 个 symbol；最终仍由字符预算决定能渲染多少。

父子 range 的取舍取决于源码是否可用和语义价值：大的 class/namespace envelope 若会吞掉内部精确方法，优先保留内层方法；root 或路径直接相关的嵌套 symbol 可以保留。只有真正重叠或同位置的片段才合并，相邻方法不会自动合成无法裁剪的大块。

例如一个文件含有：

```text
CheckoutService class       80 行
placeOrder()                35 行，root
validateOrder()             12 行，普通 sibling
payment_->charge 调用行      focus
```

Assembly 会优先展示 `placeOrder()`，必要时附带 class owner/signature，而不是因为 class range 更大就直接输出整个类。

## 4. Focus、Cluster 与 Owner

[`collectSourceFocus()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/source-focus.ts#L10-L42) 将 call-path edge 行号和 dynamic-boundary 调用行统一成 focus lines，[`rankFocusLines()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L531-L579) 再按 query coverage 排序。

[`clusterSymbols()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/source-renderer.ts#L41-L82) 只合并真正重叠或共用位置的 snippets，不因两个方法相邻就合成大块。

必要时 [`enclosingOwners()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L610-L644) 提供外层类/模块上下文。

Focus line 的优先来源是 query 命中、call-path `edge.firstLine` 和 dynamic-boundary 调用位置。长函数被裁剪时，系统优先保留函数开头和这些离散窗口，必要时再保留尾部。

## 5. 字符预算

`maxChars` 是所有 `file.text` 长度之和的硬上限。

[`fileRenderCapacity()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L240-L265) 先试渲染估算文件容量；[`allocateCharBudgets()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/source-renderer.ts#L452-L508) 再分配预算。

```text
central 与 supporting 同时存在：首轮约 55% / 45%
某文件用不完：预算重新分给仍可扩展的文件
单文件 exact：可以使用完整总预算
```

具体例子：

```text
maxChars = 8,000
central: header + implementation
supporting: controller + repository

header 实际只需 600
→ 未使用预算回收
→ 重新分给仍可展开的 implementation/repository
```

因此 55%/45% 是首轮份额，不是不可突破的文件上限；总和不超过 `maxChars` 才是硬约束。

## 6. 三种渲染形式

[`renderFileText()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/source-renderer.ts#L84-L185) 按 cluster 逐个尝试：

```text
complete body       完整正文放得下
focused excerpt     长函数只保留开头、focus 窗口和必要尾部
signature skeleton  多态 sibling 只展示签名
```

具体分派在 [`renderCluster()` / `renderSymbolSource()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/source-renderer.ts#L233-L347)。缺口会明确标记，不会静默改写源码。

Focused excerpt 可能形成：

```text
函数签名和开头
... (focused call-site window) ...
payment_->charge(...)
... (focused call-site window) ...
orders_->save(...)
// ... truncated
```

多态 sibling 若只是用于说明候选实现，则可以只输出 signature skeleton，把正文预算留给真正位于执行路径上的实现。

最终 bundle 保留真实行号、`sourceOrigin`、入选 reasons 和 symbols；它没有单独的 truncation 布尔字段，裁剪通过 `text` 中的 gap / truncated 标记显式呈现。展示内容不是 LLM 摘要。

## 7. 最终输出长什么样

[`assembleExploreFiles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L34-L168) 返回 `ExploreFileBundle[]`；它最终放在 `ExploreResult.files` 中。单个 bundle 的结构是：

```ts
type ExploreFileBundle = {
  file: FileInfo;
  score: number;
  isCentral: boolean;
  isChangeSurface: boolean;
  reasons: string[];
  symbols: ExploreSymbolSnippet[];
  sourceOrigin: "current_disk" | "indexed_fragment";
  text: string;
};
```

各字段可以这样理解：

```text
file             文件路径、格式等基本信息
score            上一步传入的 file base score，不是把最终 MMR gain 再输出一次
isCentral        是否属于 central 展示组
isChangeSurface  是否包含入选的参数/返回类型 surface
reasons          最多 6 个紧凑原因，例如 placeOrder(root)、save(calls)
symbols          实际参与本文件渲染的 symbol 元数据及源码范围
sourceOrigin     text 来自当前磁盘，还是 indexed fragment 回退
text             真正交给调用方的、已经受字符预算约束的源码文本
```

例如查询 `CheckoutService::placeOrder`，假设最终选择了实现文件、头文件和 repository，返回结果的形状可能类似下面这样。ID 和分数仅为说明结构而简化：

```ts
[
  {
    file: {
      id: "checkout_cpp",
      relativePath: "src/checkout_service.cpp",
      format: "cpp"
    },
    score: 0.42,
    isCentral: true,
    isChangeSurface: false,
    reasons: ["placeOrder(root)", "placeOrder(calls)"],
    symbols: [
      {
        id: "place_def",
        name: "placeOrder",
        scope: "CheckoutService",
        kind: "function",
        signature: "Receipt CheckoutService::placeOrder(const Order& order)",
        range: {
          kind: "text",
          startLine: 18,
          endLine: 34,
          startOffset: 410,
          endOffset: 890
        },
        content: "Receipt CheckoutService::placeOrder(...) { ... }"
      }
    ],
    sourceOrigin: "current_disk",
    text: `18  Receipt CheckoutService::placeOrder(const Order& order) {
19    payment_->charge(order);
20    orders_->save(order);
21    return Receipt{order.id()};
22  }`
  },
  {
    file: {
      id: "checkout_h",
      relativePath: "include/checkout_service.h",
      format: "cpp"
    },
    score: 0.18,
    isCentral: true,
    isChangeSurface: false,
    reasons: ["placeOrder(root)", "placeOrder(counterpart)"],
    symbols: [
      {
        id: "place_decl",
        name: "placeOrder",
        scope: "CheckoutService",
        kind: "function",
        signature: "Receipt placeOrder(const Order& order);",
        range: { kind: "text", startLine: 9, endLine: 9 },
        content: "Receipt placeOrder(const Order& order);"
      }
    ],
    sourceOrigin: "current_disk",
    text: `7   class CheckoutService {
8   public:
9     Receipt placeOrder(const Order& order);
10  };`
  },
  {
    file: {
      id: "repository_cpp",
      relativePath: "src/order_repository.cpp",
      format: "cpp"
    },
    score: 0.09,
    isCentral: false,
    isChangeSurface: false,
    reasons: ["save(definition)", "save(calls)"],
    symbols: [
      {
        id: "save_def",
        name: "save",
        scope: "OrderRepository",
        kind: "function",
        signature: "void OrderRepository::save(const Order& order)",
        range: { kind: "text", startLine: 42, endLine: 57 },
        content: "void OrderRepository::save(...) { ... }"
      }
    ],
    sourceOrigin: "current_disk",
    text: `42  void OrderRepository::save(const Order& order) {
43    database_.insert(order);
44  }`
  }
]
```

这里要特别区分：

```text
symbols
  是本文件实际选中并参与渲染的 symbol 清单，保留 ID、identity、range 和 indexed content。

text
  是按照当前磁盘源码、focus lines 和文件字符预算真正组装出的展示文本。
```

因此 `symbols[0].content` 不应被理解为最终一定原样展示的内容；最终上下文以 bundle 的 `text` 为准。

### 7.1 长函数被裁剪时

如果 `placeOrder()` 完整正文超过该文件预算，bundle 结构不变，只是 `text` 改为 focused excerpt。例如：

```text
18  Receipt CheckoutService::placeOrder(const Order& order) {
19    validate(order);

... (focused call-site window) ...

86    payment_->charge(order);
87    metrics_.recordCharge(order.id());

... (focused call-site window) ...

131   orders_->save(order);
132   return Receipt{order.id()};
133 }
// ... truncated
```

这里仍然是源码摘录，不是 LLM 生成的函数摘要。窗口位置主要由 query 命中、call-path edge 的 `firstLine` 和 dynamic-boundary 调用行决定。

### 7.2 使用 indexed fragment 回退时

如果 `readFileText()` 失败，仍可能返回：

```ts
{
  sourceOrigin: "indexed_fragment",
  symbols: [/* 入选 symbol */],
  text: "索引时保存的 fragment 内容"
}
```

调用方可以通过 `sourceOrigin` 区分它不是当前磁盘文件的实时文本。

如果一个入选文件在预算下最终没有生成任何非空 `text`，它不会出现在返回的 bundles 中。

## 8. 最简心智模型

```text
先选文件，再读源码
先排 symbol，再按预算渲染
能放下就给完整正文
放不下才做 focused excerpt 或 skeleton
```
