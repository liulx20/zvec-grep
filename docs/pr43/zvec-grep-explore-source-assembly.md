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

## 7. CLI 实际输出长什么样

CLI 的 direct 模式通过 [printExploreResult()](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/presentation/graph.ts#L23-L27) 输出；daemon/MCP 文本路径使用同一套 [formatExploreResult()](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/presentation/graph.ts#L29-L31) 格式。真正的终端输出不是 JSON，也不会直接打印 ExploreFileBundle.symbols。

例如：

~~~console
$ zg explore "CheckoutService::placeOrder" --max-files 3

explore: CheckoutService::placeOrder
root: /workspace/shop
roots: CheckoutService::placeOrder (src/checkout_service.cpp:18)
subgraph: 17 nodes, 22 edges, 3 files
source note: current blocks are verbatim, line-numbered disk reads, not summaries; do not re-read displayed ranges unless marked indexed.

flow:
1. placeOrder -CALLS-> save

blast radius:
- placeOrder:
  dependents: 2 symbols in src/checkout_controller.cpp
  tests: 1 symbols in tests/checkout_service_test.cpp

change surface:
- placeOrder type -> Order (include/order.h:6)
- placeOrder return -> Receipt (include/receipt.h:4)

dynamic boundaries:
- placeOrder@L25 -> payment_->charge
  reason: dynamic dispatch
  candidates: 2
  - StripeGateway::charge (src/stripe_gateway.cpp); confidence=0.75; via=receiver type
  - MockGateway::charge (tests/mock_gateway.cpp); confidence=0.65; via=hierarchy candidate

relationships:
CALLS:
- placeOrder -CALLS-> save
REFS:
- placeOrder -REFS-> Order
INSTANTIATES:
- placeOrder -INSTANTIATES-> ReceiptBuilder

src/checkout_service.cpp (central, score=0.4200)
selected: placeOrder(root), placeOrder(calls)
source:
18  Receipt CheckoutService::placeOrder(const Order& order) {
19    validate(order);
20    payment_->charge(order);
21    orders_->save(order);
22    return Receipt{order.id()};
23  }

include/checkout_service.h (central, score=0.1800)
selected: placeOrder(root), placeOrder(counterpart)
source:
7   class CheckoutService {
8   public:
9     Receipt placeOrder(const Order& order);
10  };

src/order_repository.cpp (related, score=0.0900)
selected: save(definition), save(calls)
source:
42  void OrderRepository::save(const Order& order) {
43    database_.insert(order);
44  }
~~~

上例用于展示格式，具体节点数、分数、关系和文件取决于本次索引与查询。CLI 的输出顺序固定为：

~~~text
1. query、workspace root、roots 和 subgraph 规模
2. source note：存在 current-disk 源码时提示正文是原样磁盘读取
3. flow：去重后的主要调用路径
4. blast radius：反向 dependents/tests 摘要
5. change surface：参数类型和返回类型
6. dynamic boundaries：无法唯一静态绑定的调用及候选
7. relationships：按 CALLS / INHERITS / REFS / INSTANTIATES 分组
8. files：逐文件打印角色、分数、入选原因和源码
~~~

这些区块按数据是否存在决定是否显示；例如没有 dynamic boundary 时，不会打印 dynamic boundaries。

### 7.1 每个源码文件在 CLI 中的格式

[exploreLines() 的文件循环](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/presentation/graph.ts#L143-L166) 将内部 bundle 转换为：

~~~text
<relativePath> (<role>, score=<四位小数>)
selected: <reasons>
source:
<组装后的 file.text>
~~~

角色显示为：

~~~text
isCentral=true                          → central
isCentral=false && isChangeSurface=true → change-surface
其他                                    → related
~~~

reasons 最多显示若干紧凑原因，例如 placeOrder(root)、save(definition)、save(calls) 或 PaymentGateway(inherits)。

如果源码读取失败、使用索引 fragment 回退，标题会明确变为：

~~~text
source (indexed fragment):
~~~

CLI 不单独打印内部的 symbols[]；symbol 选择的结果已经体现在 selected 原因和最终 source 正文中。

### 7.2 长函数在 CLI 中的样子

如果完整函数超出本文件字符预算，source 后直接显示 focused excerpt：

~~~console
src/checkout_service.cpp (central, score=0.4200)
selected: placeOrder(root), placeOrder(calls)
source:
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
~~~

这些 gap/truncated 标记就是 CLI 中的裁剪提示；不存在单独打印的 truncated=true 文件字段。

### 7.3 CLI 的展示上限

Presentation 层还会限制摘要噪声：

~~~text
每种 relationship 最多展示 6 条
dynamic boundary 最多展示 8 条
每个 dynamic boundary 最多展示 5 个 candidates
blast radius 每类最多列出 4 个文件路径，更多文件显示 +N files
~~~

这些只是 CLI 展示上限，不等于 ExploreResult 内部只保存这么多记录。

## 8. 最简心智模型

```text
先选文件，再读源码
先排 symbol，再按预算渲染
能放下就给完整正文
放不下才做 focused excerpt 或 skeleton
```
