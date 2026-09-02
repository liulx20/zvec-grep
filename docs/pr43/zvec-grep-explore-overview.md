# Zvec-Grep Explore 整体流程：从 Query 到源码 Context

本文是 Zvec-Grep PR [#43](https://github.com/zvec-ai/zvec-grep/pull/43) 的 Explore 总览，基于提交 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac)。文中代码链接全部固定到该提交。

如果要先理解整个 PR 而不只是 Explore，请从 [PR #43 整体架构](./zvec-grep-pr43-architecture.md) 开始。

如果只想知道 Explore 整体在做什么，先看这一篇。其他文档用于深入某个子阶段。

## 1. Explore 想解决什么

普通向量检索回答：

> 哪些代码片段和 query 语义相似？

Explore 想进一步回答：

> 从某个代码符号或概念出发，哪些声明、定义、调用方、被调用方、实现类、相关类型和源码文件最能解释它？

所以 Explore 不是只返回一串 search hits，而是构造一个有预算的代码 context pack。

## 2. 整体流程

```text
用户 Query
   │
   ▼
① Seed Resolution
   找到从哪些 symbol IDs 出发
   │
   ▼
② Intent
   exact_symbol 或 concept
   │
   ▼
③ Subgraph Candidate Collection
   从 roots 收集结构和执行相关节点
   │
   ▼
④ Candidate Trim
   在 maxNodes 内保留最有证据的节点
   │
   ▼
⑤ Induced Graph + Node PPR/RWR
   计算节点图中心性
   │
   ▼
⑥ Execution/Impact Enrichment
   call paths、dynamic boundaries、blast radius、change surface
   │
   ▼
⑦ File Ranking + Intent Evidence + MMR
   在 maxFiles 内选出相关且不重复的文件
   │
   ▼
⑧ Source Assembly
   这时才读取已选文件的当前源码
   │
   ▼
⑨ Character Budget Rendering
   complete body / focused excerpt / signature skeleton
   │
   ▼
Explore Result
```

## 3. 一路上数据变成了什么

Explore 之所以难看懂，是因为它的核心数据一直在变。

```text
query string
  → parsed terms / explicit references
  → seed candidates
  → root symbol IDs
  → subgraph node candidates + node evidence
  → trimmed nodes + typed edges
  → node scores
  → file candidates + file evidence
  → selected files + central/supporting role
  → source snippets
  → rendered file text
```

最重要的两个分界：

当前 SQLite 中 `files`、`symbols`、`contains`、`edges`、`unresolved_refs` 和 `edge_candidates` 的字段及关联，见 [SQLite Graph Schema](./zvec-grep-graph-data-model.md)。

```text
Seed Resolution 之后：
主要以 symbol IDs 为核心，不再只靠 query 字符串。

File Selection 之后：
才开始读取当前磁盘源码并组装文本。
```

## 4. 阶段一：Seed Resolution

代码定位：请求入口在 [`resolveExploreRequest()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/request-plan.ts#L34-L128)；具体的候选召回、打分和 seed 选择在 [`resolveExploreSeeds()` / `planExploreSeeds()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L269-L349)；显式限定名的唯一分组判定在 [`resolveExactExploreSeedGroups()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L1297-L1354)。

Seed 是 Explore 的起点 symbol。

例如 query：

```text
how CheckoutService::placeOrder charges payment
```

系统会提取：

```text
retrieval/evidence terms:
  checkout, service, place, order, charge, payment

explicit qualified reference:
  CheckoutService::placeOrder

lookup leaf:
  placeOrder
```

然后通过精确 symbol lookup、qualified match、callable fallback、owner fallback 和语义召回等途径找候选。

如果声明和定义属于同一 semantic symbol：

```text
place_decl  CheckoutService::placeOrder declaration
place_def   CheckoutService::placeOrder definition
```

则它们可以同时成为 root IDs：

```ts
rootIds = ["place_decl", "place_def"];
representative = "place_def";
```

这一阶段回答：

> Explore 到底应该从哪个代码概念出发？

## 5. 阶段二：Intent

代码定位：[`resolveExploreRequest()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/request-plan.ts#L81-L103) 根据 seed 解析结果调用 [`resolveExploreIntent()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/intent.ts#L1-L9)，并同时确定 roots 与自适应 node budget。

Explore 只有两个主要 intent：

| Intent | 产生条件 | 偏好 |
|---|---|---|
| `exact_symbol` | 有 `seedId` 或唯一精确 symbol group | root、declaration/definition、调用正文 |
| `concept` | 只能通过语义检索确定 roots | 更大候选预算、概念覆盖、文件角色多样性 |

Intent 不会替换整条管线。两者共用子图、排名和组装实现，但使用不同的候选预算和 file-evidence 权重。

## 6. 阶段三：Subgraph Candidate Collection

代码定位：[`exploreGraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L71-L109) 把 request plan 交给 [`exploreSubgraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L978-L1283)；所有 collector 通过 [`SubgraphCandidatePool`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph-candidate-pool.ts#L28-L118) 合并节点、depth、保护标记和 evidence。

子图阶段不是立即生成最终 graph。它先建立一个候选池：

```text
symbol ID
+ 距离 root 的最小 depth
+ 为什么被收进来的 evidence
+ evidence strength
+ 是否 protected
+ evidence sources
```

概念上：

```ts
candidatePool.add(node, score);
candidatePool.addEvidence(nodeId, kind, {
  strength,
  minDepth,
  protected,
  sourceId
});
```

### 6.1 结构 evidence

代码定位：代表成员、成员依赖、root value dependency、impact 邻居和 structural bridge 分别集中在 [`subgraph.ts` 的 glue helpers](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1438-L1994)；继承 contract、容器与普通调用邻居在[后续 helpers](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L2066-L2405)。

结构 evidence 回答：

> Root 在类型、容器、接口、声明/定义关系中与谁相连？

主要包括：

```text
root
counterpart
hierarchy
container
representative_member
member_dependency
inherited_contract
component_import
root_value_dependency
instantiation
structural_bridge
```

例如：

```text
PaymentGateway interface
  → StripeGateway             hierarchy
  → PaymentGateway::charge    representative/inherited contract

placeOrder declaration
  ↔ placeOrder definition     counterpart
```

### 6.2 执行 evidence

代码定位：直接 caller/callee 收集在 [`collectDirectCallCollaborators()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L444-L527)，动态调用候选的 evidence 投影在 [`addDynamicBoundaryEvidence()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L716-L867)。

“收集执行 evidence”的意思是：

> 在已经找到的 root 附近，收集能说明调用方、被调用方和执行链的 symbol，并记录它们为什么进入候选池。

主要包括：

```text
traversal
call_neighbor
call_path
dynamic_boundary
impact
```

它不是真正运行程序，也不是做完整数据流分析。它是在持久化 code graph 上查询 `CALLS`、function-like `REFS` 等边。

例如：

```text
CheckoutController::submit
  → CheckoutService::placeOrder
  → PaymentGateway::charge
  → OrderRepository::save
```

候选可以获得：

```text
submit       call_neighbor / impact / call_path
placeOrder   root
charge       call_neighbor / call_path / dynamic_boundary
save         traversal / call_path
```

### 6.3 Structural Bridge 和 Call Path

代码定位：structural bridge 的扩展入口是 [`extendStructuralBridges()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1876-L1994)；语义 call path 收集由 [`collectCallPaths()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/paths.ts#L10-L252) 完成，最终执行路径由 [`deriveExecutionPaths()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/paths.ts#L254-L334) 整理。

```text
structural bridge：
把类型/接口/成员结构连到一个可执行 callable

call path：
进入 callable 之后，展示实际的调用链
```

例如：

```text
PaymentGateway
  → StripeGateway
  → StripeGateway::charge       structural bridge
  → StripeClient::createCharge  call path
```

同一节点可以同时拥有 `structural_bridge` 和 `call_path` evidence。

## 7. Evidence 到底是什么

代码定位：evidence 的统一存储与合并规则在 [`SubgraphCandidatePool`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph-candidate-pool.ts#L28-L118)；各类 evidence 是由上一节链接的 collectors 写入，而不是一次 PageRank 计算的结果。

Evidence 不是另一张图，也不是 PageRank。它是候选被保留的结构化理由。

例如：

```ts
StripeGateway::charge: {
  hierarchy: {
    strength: 0.9,
    minDepth: 1,
    protected: false,
    sources: ["PaymentGateway"]
  },
  structural_bridge: {
    strength: 1,
    minDepth: 1,
    protected: true,
    sources: ["PaymentGateway::charge"]
  },
  call_path: {
    strength: 1,
    minDepth: 2,
    protected: true,
    sources: ["placeOrder"]
  }
}
```

同一 node 可以同时有多种 evidence。候选池合并：

```text
同 kind strength  取最大值
同 kind minDepth  取最小值
protected            做 OR
sources              做并集
```

Evidence 的主要作用是：

- 让多个 collector 将候选放进同一个 pool；
- 在 `maxNodes` 裁剪时保护关键节点；
- 解释节点为什么被收进来；
- 将节点理由投影成文件 evidence。

## 8. 阶段四：Candidate Trim

代码定位：[`exploreSubgraph()` 的统一裁剪调用](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1260-L1293) 最终进入 [`trimToMaxNodes()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L2406-L2443)。

不同 collector 可能收集大量节点，但 Explore 只能保留 `maxNodes`。

统一裁剪顺序：

```text
1. root
2. protected
3. minDepth 更小
4. query coverage 更高
5. evidence strength 总和更高
6. entity ID 稳定 tie-break
```

例如同样超预算时：

```text
root counterpart       优先保留
call-path node         优先保留
距离 root 1 跳的 callee 优先于 4 跳普通 ref
多种 evidence 支持的 node 优先于单一弱证据 node
```

裁剪后，任一 call path 只要丢了中间节点，就整条移除，避免返回断裂路径。

## 9. 阶段五：Induced Graph 和 Node PPR/RWR

代码定位：induced edge 由 [`collectExploreEdges()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L2445-L2473) 收集；[`rankExploreNodes()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/ranking.ts#L8-L38) 在该局部图上运行 PPR/RWR。

裁剪完的 node IDs 形成局部 induced graph：

```text
只保留两端都在最终 node set 中的边
```

然后 `rankExploreNodes()` 从 roots 做 personalized PageRank/random walk with restart。

直觉上：

```text
每次有一定概率回到 roots
其余概率沿图边走
更强的关系传递更多分数
```

关系强度大致为：

```text
CALLS > INHERITS > COUNTERPART > INSTANTIATES
      > REFS > IMPORTS/DEFINES > CONTAINS
```

实际边权还会乘 `edge.confidence`。

Node PPR 回答：

> 在已裁剪的局部图中，哪些 symbol 在结构上更接近 roots？

它不直接选最终文件。

## 10. 阶段六：Execution/Impact Enrichment

代码定位：总编排位于 [`exploreGraph()` 的 enrichment 段](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L140-L273)，它把路径、动态边界、blast radius 和 change surface 合回候选与文件 evidence。

节点排名后，Explore 还会生成几类结构化结果。

### 10.1 Call Paths

代码定位：[`collectCallPaths()` 与 `deriveExecutionPaths()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/paths.ts#L10-L334)。

```text
submit → placeOrder → charge → save
```

它用于解释进入 root 的上游路径，或 root 向下游执行的路径。

### 10.2 Dynamic Boundaries

代码定位：边界的筛选、去重和预算控制在 [`selectDynamicBoundaries()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L618-L715)，候选实现转成 projection/evidence 在 [`addDynamicBoundaryEvidence()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L716-L867)。

遇到：

```cpp
payment_->charge(order);
```

如果静态无法唯一确定实现，则保留：

```text
source: placeOrder
target: payment_->charge
candidates:
  StripeGateway::charge
  PaypalGateway::charge
```

可信候选可以以：

```text
CALLS rel=dynamic
provenance=heuristic
```

的 projection edge 扩展本次局部执行流，但不伪装成静态唯一调用。

### 10.3 Blast Radius

代码定位：[`collectBlastRadius()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/impact.ts#L13-L95)。

从 roots 反向查找：

```text
dependents
callers
tests
```

它默认是影响摘要，不自动占用源码正文预算。

### 10.4 Change Surface

代码定位：[`collectChangeSurface()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/impact.ts#L97-L351) 收集参数/返回类型，[`includeChangeSurfaceNodes()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/impact.ts#L353-L399) 决定哪些 surface entity 加入候选。

对 callable roots 收集签名中的：

```text
parameter types
return types
```

例如：

```text
Order    type
Receipt  return
```

它是接口表面摘要，不是完整 ABI 或数据流分析。

## 11. 三种 Evidence 不要混在一起

| Evidence | 对象 | 解决的问题 |
|---|---|---|
| Seed evidence | seed candidate | 哪个 symbol 应当成为 root？ |
| Node evidence | subgraph node | 这个 symbol 为什么进入局部子图？ |
| File evidence | file candidate | 这个文件为什么值得占用最终文预算？ |

例如 `StripeGateway::charge`：

```text
Seed evidence:
  可能没有，它不是 root

Node evidence:
  hierarchy
  structural_bridge
  dynamic_boundary
  call_path

File evidence:
  dynamic_boundary
  query_alignment
  call_path
  concept:stripe
  concept:charge
```

PageRank 也不是 evidence。PageRank 是基于图拓扑算出的数值分数；evidence 是结构化原因。

## 12. 阶段七：节点分聚合成文件分

代码定位：[`rankExploreFiles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/ranking.ts#L40-L144)。

`rankExploreFiles()` 将同文件内的 node scores 聚合成 file base score。

不是直接求和，而是让后续节点的贡献衰减，避免一个包含大量 sibling methods 的文件单纯靠数量获胜。

基础分还会参考：

```text
root file boost
query term hit
root qualified identity 对应的 definition file
test/vendor/example/tool 等路径降权
```

此时仍只是 file base score，还没有做最终文件选择。

## 13. 阶段八：Intent-aware File Evidence

代码定位：文件 evidence 在 [`exploreGraph()` 的文件候选构建段](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L274-L325) 汇总；不同 intent 的权重由 [`evidenceWeights()` / `evidenceWeight()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L232-L249) 应用。

文件最终 relevance 大致由：

```text
normalized file base score
+ intent-specific evidence weights
```

产生。

### `exact_symbol`

更重视：

```text
root
root_counterpart
declaration/definition
direct_caller
call body
```

### `concept`

更重视：

```text
semantic_seed
query_alignment
collaborator
integration
concept coverage
role diversity
```

Intent 自身不是 evidence。Intent 只是选择用哪套 evidence weights。

## 14. 阶段九：MMR 选最终文件

代码定位：[`selectExploreFiles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L108-L162) 执行硬约束和逐个选择；[`marginalGain()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L262-L345) 计算 relevance、重复惩罚与 novelty，[`fileSimilarity()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L346-L393) 计算文件相似度。

MMR 的目标是：

> 选相关文件，但不让多个高度重复的文件占满 `maxFiles`。

边际收益概念上为：

```text
marginal gain
  = relevance
  - 已选文件的重复语义
  + 尚未覆盖的 concept/结构角色
  - 与已选文件的相似度
```

同时存在少量一致性约束：

```text
exact root 或 semantic seed 优先
预算允许时保留一个 root_counterpart
任何约束不突破 maxFiles
```

当最佳候选的 marginal gain 不再为正时停止，因此：

```text
maxFiles = 8
```

表示“最多 8 个”，不是“必须凑满 8 个”。

## 15. Central 是什么

代码定位：文件已经选完后，[`assignFileRoles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L163-L205) 才给结果分配 `central` / `supporting`。

File selection 返回文件后，再为已选文件分配：

```text
central
supporting
```

Central 只从已选文件中产生，最多两个。

```text
exact_symbol:
  最多两个 root 文件

concept:
  先取一个 semantic seed 文件

不足两个时补一个 co-central:
  root_counterpart
  → counterpart
  → direct_caller/direct_call
  → integration
```

Central 不重新决定文件是否入选，主要影响展示标记和字符预算。

## 16. 阶段十：Source Assembly

代码定位：[`assembleExploreFiles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L34-L168) 编排已选文件；每个文件进入 [`prepareExploreFile()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L190-L238) 时才读取文件文本并准备 symbol snippets。

文件已经选定后，Assembly 才为每个文件调用：

```ts
storage.readFileText(file)
```

这是“什么时候真正读源码”的答案。

```text
文件选择前：
  主要使用索引实体、symbol metadata、图边和分数

文件选择后：
  为最终文件读取当前磁盘整文件文本
```

读取成功：

```text
sourceOrigin = current_disk
```

读取不可用：

```text
sourceOrigin = indexed_fragment
```

之后对每个文件内的候选 symbols 执行：

```text
只保留 text entities
→ 父子 range 去重
→ 大型 envelope 与精确内层 member 取舍
→ symbol ranking
→ overlapping cluster
→ enclosing owner context
```

## 17. Symbol 是怎么最终入选的

代码定位：[`preferNestedSourceSymbols()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L289-L331) 处理外层/内层取舍，[`removeContainedSymbols()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L391-L418) 去除被覆盖片段，[`rankSymbols()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L441-L530) 排 symbol；[`clusterSymbols()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/source-renderer.ts#L41-L82) 再把重叠片段组成渲染单元。

Symbol 不是一次选出来的，而是经过四层漏斗：

```text
1. Candidate Pool
   只有上游子图召回的 symbols 有资格

2. File Selection
   symbol 所在文件没入选，symbol 整体出局

3. Range Dedup + Symbol Ranking
   决定保留外层还是内层，以及谁先用预算

4. renderFileText()
   真正能在字符预算内形成有意义 block 的 symbol 才输出
```

Symbol 排名优先考虑：

```text
root
→ call path / structural bridge
→ root 直接执行目标
→ root 引用的类型
→ 跨文件 caller/callee
→ query coverage
→ node score
→ 普通邻居
```

最终不是简单选“前 N 个 symbol”，而是按 cluster 优先级依次尝试放入字符预算。

## 18. 字符预算和渲染

代码定位：[`allocateCharBudgets()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/source-renderer.ts#L452-L508) 分配并回收字符预算；[`renderFileText()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/source-renderer.ts#L84-L185) 按 cluster 渲染正文；focus lines 来自 [`collectSourceFocus()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/source-focus.ts#L10-L42)。

全局：

```text
sum(file.text.length) <= maxChars
```

同时存在 central 和 supporting 时，首轮分配：

```text
central group     55%
supporting group  45%
```

某文件用不完的预算会重新分给仍可扩展的文件。

每个 symbol 有三种输出形式：

```text
complete body
focused excerpt
polymorphic signature skeleton
```

Focused excerpt 优先保留：

```text
函数开头
query 命中行
call path edge.firstLine
dynamic boundary 调用行
必要的函数尾部
```

离散窗口使用：

```text
... (focused call-site window) ...
```

标记缺口。

## 19. 端到端例子

Query：

```text
how CheckoutService::placeOrder charges payment and saves the order
```

### 19.1 Seed

```text
intent = exact_symbol
rootIds = [place_decl, place_def]
representative = place_def
```

### 19.2 Subgraph candidates

```text
place_decl                 root/counterpart
place_def                  root/counterpart
CheckoutService            container
PaymentGateway             root_value_dependency
StripeGateway              hierarchy/instantiation
StripeGateway::charge      structural_bridge/dynamic_boundary/call_path
OrderRepository::save      traversal/call_path
CheckoutController::submit call_neighbor/impact/call_path
Order                      change surface: type
Receipt                    change surface: return
checkout_service_test      blast radius
```

### 19.3 Node trim and ranking

```text
roots/counterparts/path nodes 优先保留
普通远程 refs 优先删除
CALLS 关系比普通 REFS 传递更多 PPR 分数
```

### 19.4 File selection

```text
checkout_service.hpp    root              central
checkout_service.cpp    root/counterpart  central
controller.cpp          direct_caller     supporting
repository.cpp          direct_call/path  supporting
```

Stripe implementation 可以作为 dynamic candidate，但只有当 query alignment 和 marginal gain 足够强时才可能挤进 `maxFiles`。测试默认留在 blast summary，不仅因 impact 占用正文槽位。

### 19.5 Source assembly

```text
checkout_service.hpp
  CheckoutService declaration
  placeOrder signature

checkout_service.cpp
  enclosing CheckoutService header
  placeOrder complete/focused body
  payment_->charge focus window
  repository_->save focus window

controller.cpp
  submit body

repository.cpp
  save body
```

### 19.6 辅助结果

```text
dynamic:
  place_def -> payment_->charge
  candidates: StripeGateway::charge, PaypalGateway::charge

blast:
  checkout_service_test.cpp

surface:
  Order   type
  Receipt return
```

## 20. 最终输出包含什么

代码定位：[`exploreGraph()` 的结果组装与返回](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L326-L389)；返回结构定义见 [`ExploreGraphResult`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/types.ts#L110-L150)。

Explore 结果不只有源码，大致包含：

```text
roots
nodes
typed edges
call paths
dynamic boundaries
blast radius
change surface
selected source files
source snippets with real line numbers
truncation flags
```

对每个源码文件：

```ts
{
  file,
  score,
  isCentral,
  isChangeSurface,
  reasons,
  symbols,
  sourceOrigin,
  text
}
```

## 21. 阅读其他文档的顺序

建议按下列顺序阅读：

1. 本文：整体数据流和概念边界。
2. [PR #43 整体架构](./zvec-grep-pr43-architecture.md)：CLI、索引、抽取、持久化、查询和 Explore 的模块地图。
3. [SQLite Graph Schema](./zvec-grep-graph-data-model.md)：实际表、字段、典型取值和关联关系。
4. [图关系抽取与解析](./zvec-grep-graph-relation-extraction.md)：源码如何变成 symbols、edges 和 dynamic candidates。
5. [Seed Resolution](./zvec-grep-explore-seed-resolution.md)：query 如何变成 roots，包括 exact intent、semantic grouping 和 concept seeds。
6. [Subgraph](./zvec-grep-explore-subgraph.md)：node evidence 和子图 collector。
7. [Ranking](./zvec-grep-explore-ranking.md)：PPR、file evidence 和 MMR。
8. [Source Assembly](./zvec-grep-explore-source-assembly.md)：文件内 symbol 和字符预算。

## 22. 最简心智模型

```text
Seed Resolution
  决定“从哪里出发”

Subgraph Evidence
  决定“哪些 symbol 有资格候选”

Candidate Trim
  决定“节点预算内留谁”

Node PPR
  决定“局部图中谁更靠近 roots”

File Evidence + MMR
  决定“文件预算内留谁”

Source Assembly
  决定“已选文件中具体展示哪些源码”
```
