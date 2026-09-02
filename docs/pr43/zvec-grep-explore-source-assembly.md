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

最终 bundle 仍保留真实行号、`sourceOrigin`、入选 reasons、symbols 和 truncation 状态，展示内容不是 LLM 摘要。

## 7. 最简心智模型

```text
先选文件，再读源码
先排 symbol，再按预算渲染
能放下就给完整正文
放不下才做 focused excerpt 或 skeleton
```
