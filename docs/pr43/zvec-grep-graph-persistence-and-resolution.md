# PR #43：图持久化与引用解析

本文解释提交 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac) 中，文件级图事实如何写入 SQLite，以及尚未确定目标的引用如何变成 edge、dynamic candidate 或 unresolved 状态。

具体表字段和示例见 [SQLite Graph Schema](./zvec-grep-graph-data-model.md)；本文只讲模块协作和状态变化。

## 1. 为什么不能抽取完直接得到完整图

解析一个文件时，经常只有：

```text
source = CheckoutService::placeOrder
文本   = payment_->charge(...)
member = charge
receiver hint = payment_
```

target 可能在另一个文件，可能依赖 import、字段类型、继承关系，甚至只能在运行时决定。因此索引分成两步：

```text
抽取阶段：保存确定事实 + 未决引用
解析阶段：利用整个 workspace 的符号和结构补全 target
```

## 2. 存储对象的生命周期

[`SqliteGraphDatabase`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/database.ts#L27-L196) 管理数据库连接、事务、schema version 和 close；[`openGraphStorage()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/open.ts#L17-L45) 决定打开 SQLite backend，或返回说明不可用原因的 fallback。

上层不直接把 SQL 散落到 Explore 中，而是通过：

```text
GraphWriter   写文件级事实
GraphReader   读 entity、edge、candidate、source
GraphDatabase 管事务与生命周期
```

## 3. Writer 写的不是只有 nodes 和 edges

[`SqliteGraphWriter`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/writer.ts#L39-L204) 接收 `FileGraph`，更新：

- 文件和 stored entities；
- 已确定 typed edges；
- unresolved refs；
- import、receiver、call shape 等后续解析需要的事实；
- 动态边界和候选所需的记录。

同一个文件重建时先移除旧版本相关记录，再写新版本。这使 SQLite graph 与当前 manifest 对齐。

## 4. Pending resolver 的阶段

[`SqlitePendingRefResolver`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/pending-ref-resolver.ts#L86-L1949) 很长，是因为它把多种关系、多语言提示和解析回退集中到了一个持久化解析器中。

核心不是“一次全库模糊搜”，而是分阶段补足解析前提：

```text
imports
  → hierarchy / type ownership
  → instantiation / receiver type
  → calls、function values 和普通 refs
```

前一阶段生成的边会成为后一阶段的解析依据。例如先得到字段/变量对应的类型，再用该类型限定 `charge` 的 owner，比只按 `charge` 名称搜索可靠。

阶段编排直接见 [`resolvePending()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/pending-ref-resolver.ts#L177-L250)：先处理 inheritance、function registrations 和 instantiations，再构造 hierarchy cache 并处理普通 symbols；每阶段的批量读取、解析和 flush 在 [`resolvePhase()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/pending-ref-resolver.ts#L352-L469)。

## 5. 候选从哪里来

解析器会综合：

- target 的 leaf name 与 qualified name；
- source 所在 scope 和 owner；
- import 可见性；
- receiver/field/parameter type；
- callable arity、kind 和 signature；
- `INHERITS`、`INSTANTIATES` 等已经解析出的结构边；
- 语言自己的命名和模块规则。

[`DirectSemanticCandidateIndex`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/direct-candidate-index.ts#L38-L437) 为直接名称、owner 和类型关系提供内存候选索引；[`SemanticCandidateRepository`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/candidate-repository.ts#L45-L405) 负责从持久化数据查询更广的语义候选。

这里得到的是候选集合。解析策略还要判断是否足以宣称唯一静态 target。

## 6. 四种主要结果

```text
唯一且可信
  → 写 typed edge，例如 CALLS / REFS / INHERITS

多个可信动态目标
  → 写 dynamic boundary + edge_candidates

确认是 workspace 外部依赖
  → 标记 external

当前事实仍不足
  → 保留 unresolved，等待以后重试
```

`edge.confidence` 是被持久化的边属性，表示这条具体关系的解析可信度；它不是 Explore 临时计算的排名分。语法直接确定的关系通常较高，启发式推断较低。Explore 后续会把它和 edge kind 权重结合。

Dynamic candidate 也保留 provenance/score，避免候选实现被误当作唯一静态 `CALLS`。

动态结果的实际写入准备位于 [`persistDynamicCall()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/pending-ref-resolver.ts#L1450-L1487)：先 `addDynamicRef()`，再逐个 `addCandidate()`；最终状态和记录由 projection buffer 一起 flush。

## 7. Projection buffer 为什么存在

[`SqliteProjectionBuffer`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/projection-buffer.ts#L43-L166) 暂存准备写入的 edges、boundaries 和 candidates，再集中提交。

它解决的是一致性问题：一次解析的相关结果应共同出现，不能只写入 edge、却漏掉与它对应的 candidate 或 provenance。

## 8. COUNTERPART 是独立后处理

[`SqliteCounterpartProjector`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/counterpart-projector.ts#L26-L176) 针对 C/C++ declaration/definition 建立 `COUNTERPART`：

```text
Foo::bar 的头文件声明
       ↕ COUNTERPART
Foo::bar 的 .cpp 定义
```

匹配参考 qualified identity、symbol kind、arity、header/source 路径和 import/include 关系。它是索引时持久化的 query-independent 边，不等于 Explore seed 阶段把声明和定义归入 semantic group。

## 9. Reader 如何隐藏 SQL

[`SqliteGraphReader`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/reader.ts#L175-L1337) 实现统一 `GraphReader`，提供：

- 按 ID、名称、qualified identity 查 entity；
- 按方向和 kind 读取 edges；
- 读取文件文本和 entity range；
- 查询 dynamic boundary、candidates、impact/change-surface 所需事实。

Explore 和 neighborhood 依赖的是这个接口，不依赖 SQLite SQL 细节。这样查询算法可以围绕图语义写，存储实现仍留在 persistence 层。

## 10. 数据如何流向查询

```text
FileGraph
  → writer
  → entities / edges / unresolved_refs
  → pending resolver
  → edges / boundaries / candidates
  → counterpart projector
  → COUNTERPART
  → GraphReader
  → neighborhood 或 Explore
```

查询入口和 daemon 的生命周期见 [查询接口与运行时](./zvec-grep-query-and-runtime.md)。
