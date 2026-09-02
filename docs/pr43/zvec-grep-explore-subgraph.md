# Zvec-Grep Explore Subgraph：从 Roots 到局部代码图

本文基于提交 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac)，说明 [`exploreSubgraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L978-L1367) 如何把 root symbol IDs 变成局部代码图。

## 1. 整体流程

```text
roots
  → 多路收集候选节点和 evidence
  → 标记必须优先保留的节点
  → 在 maxNodes 内统一裁剪
  → 构造 selected nodes 的 induced typed graph
  → 计算 node PPR/RWR
  → 整理 call paths 和 execution paths
```

它不选择最终文件，也不读取完整源码；这些发生在外层 `exploreGraph()`。

## 2. CandidatePool

### 2.1 CandidatePool 的模型

所有 collector 都把结果写入 [`SubgraphCandidatePool`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph-candidate-pool.ts#L28-L118)，而不是各自决定最终节点。

```text
candidate
  id          symbol ID
  minDepth    距离 root 的最小深度
  isRoot      是否为 root
  evidence    为什么应该保留

evidence
  kind        理由类型
  strength    理由强度
  minDepth    该理由出现的最小深度
  protected   裁剪时是否优先保护
  sources     哪些节点提供了该理由
```

同一种 evidence 多次出现时，strength 取最大值、sources 合并；不同 evidence kind 的 strength 才会相加。

CandidatePool 不保存 edge。它的生命周期是：

```text
collectors 沿持久化边找节点
  → add/absorb 节点及 evidence
  → protect 关键节点
  → trimToMaxNodes
  → 导出 selected IDs 和 evidence
```

Evidence 和 graph edge 不一样：

```text
edge：A 与 B 是什么关系
evidence：为什么本次 Explore 要保留 B
```

## 3. 加入 Roots 和 Counterparts

roots 以 depth `0` 入池。随后读取持久化 `COUNTERPART`，补充同一符号的声明、定义或对应片段：

```text
place_decl ──COUNTERPART── place_def
```

代码定位：[`includePersistedCounterparts()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L528-L602) 和 [`addCounterpartEvidence()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L603-L617)。COUNTERPART 不参与前面的 seed semantic grouping。

## 4. 收集结构候选

### 4.1 Hierarchy 与 Container

保留 base/derived/interface 类型和成员的外层容器。实现：[`expandHierarchy()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L2066-L2130)、[`glueContainers()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L2387-L2405)。

### 4.2 Representative Members

当 roots 是同一类型 family 时，只挑少量代表成员，避免整个大类的所有方法淹没预算。实现：[`shouldSelectRepresentativeMembers()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1482-L1504)、[`glueRepresentativeMembers()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1505-L1624)。

代表成员的直接 `CALLS`、`REFS`、`INSTANTIATES` 依赖获得 `member_dependency`。实现：[`glueRepresentativeMemberDependencies()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1625-L1690)。

### 4.3 Contracts、Imports 与 Values

- `inherited_contract`：实现方法对应的接口/基类同名方法，[`glueInheritedContracts()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L2332-L2386)。
- `component_import`：相关组件 import，也可生成只用于排名的 `rankingLinks`，[collector 调用](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1068-L1086)。
- `root_value_dependency`：root 通过 `REFS` 直接使用的字段、变量、常量或实例，[`glueRootValueDependencies()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1438-L1481)。

例如：

```text
placeOrder ──REFS(value)──> payment_
```

`REFS` 是 typed edge，`root_value_dependency` 是 `payment_` 的候选理由。

### 4.4 Instantiation

保留被实例化的类型及 provider/base，例如 `Container ──INSTANTIATES──> StripeGateway`。实现见 [`INSTANTIATES` 扩展](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1152-L1190)。

## 5. 收集执行与影响候选

### 5.1 Generic Traversal

先做 depth `1` 的直接遍历（strength `2`），再做较深遍历（strength `1`）。Exact callable 默认偏向 outgoing；concept 可以双向连接多个 roots。实现见 [`exploreSubgraph()` traversal 段](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1090-L1150)。

### 5.2 Call Neighbors 与 Reverse Impact

`call_neighbor` 是直接 caller/callee，由 [`glueCallNeighbors()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L2200-L2294) 收集。

`impact` 是 root 的反向依赖者，由 [`glueImpactNeighbors()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1691-L1847) 收集。它是候选 evidence，不等于最终 blast-radius 摘要。

### 5.3 Structural Bridge

调用图在字段、接口、provider 或类型容器处断开时，系统利用结构关系连接到与 query 对齐的执行节点：

```text
placeOrder → payment_ → PaymentGateway
           → StripeGateway → StripeGateway::charge
```

它不宣称存在静态唯一调用。实现：[`constructionBridgeSources()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1848-L1875)、[`extendStructuralBridges()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1876-L1994)。

### 5.4 Dynamic Boundary

receiver、callback 或 generic dispatch 无法静态唯一解析时：

```text
读取 root/call-path 上的 boundary
  → 补充其余局部节点的 boundary
  → 去重、排序、按预算保留
  → 选择本次 query 最值得探索的 candidate
  → 必要时添加 heuristic projection edge
```

Projection 保留 `provenance="heuristic"`、candidate confidence 和 reason，不伪装成确定 `CALLS`。实现：[`selectDynamicBoundaries()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L618-L715)、[`addDynamicBoundaryEvidence()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L716-L867)、[`focusedDynamicBoundaryPaths()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1369-L1437)。

### 5.5 Call Paths

[`collectCallPaths()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/paths.ts#L10-L252) 保留对 query 有解释力的路径，例如：

```text
submit → placeOrder → charge → save
```

## 6. 标记 Protected 并统一裁剪

常见 evidence 可以这样快速记忆：

| Evidence | 节点为什么被保留 |
|---|---|
| `counterpart` | root 的声明/定义对应实体 |
| `representative_member` | 类型中最能代表行为的成员 |
| `member_dependency` | 代表成员直接依赖的节点 |
| `inherited_contract` | 接口或基类中的同名 contract |
| `component_import` | 组件级 import 连接 |
| `root_value_dependency` | root 直接引用的字段、变量或实例 |
| `traversal` | 普通图遍历到达 |
| `instantiation` | 被实例化的类型/provider |
| `call_neighbor` | 直接 caller/callee |
| `impact` | 反向依赖者 |
| `structural_bridge` | 跨字段、类型、接口到执行侧的连接 |
| `dynamic_boundary` | 无法静态唯一解析的调用边界 |
| `call_path` | 关键调用路径节点 |

roots、counterparts、代表成员、call paths、hierarchy、root values、structural bridges、imports、impact 和 dynamic boundary 关键节点会先标为 protected。代码见 [`protect` 调用段](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L1262-L1281)。

随后 [`trimToMaxNodes()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L2406-L2443) 统一排序：

```text
root
→ protected
→ minDepth 更小
→ query coverage 更高
→ evidence strength 总和更高
→ entity ID
```

因此 strength 只是靠后的 tie-break，不能让远距离弱节点越过 root。路径若丢失中间节点，会整条移除。

## 7. 构造 Induced Typed Graph

[`collectExploreEdges()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L2445-L2473) 只保留两端都在最终 node set 中的边，并保留 `kind`、`rel`、`confidence`、`provenance` 和源码位置。

```text
A ──CALLS──> B ──REFS──> C
C 被裁剪后，结果只剩 A ──CALLS──> B
```

## 8. Node PPR/RWR

[`rankExploreNodes()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/ranking.ts#L8-L38) 在裁剪后的局部图上计算：

```text
实际边权 = edge-kind 基础权重 × edge.confidence
```

roots 是 restart seeds；`rankingLinks` 参与排名，但不伪装成持久化 typed edges。PPR 只回答局部图中的结构重要性，不负责召回和最终文件选择。

## 9. Execution Paths 与输出

[`deriveExecutionPaths()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/paths.ts#L254-L334) 在最终 typed graph 上整理执行路径。`exploreSubgraph()` 最终返回：

```text
nodes + typed edges
node scores
candidate evidence
call paths + execution paths
ranking links
```

外层 [`exploreGraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L71-L389) 再进行文件打分、MMR 选择和源码组装。

## 10. 最简心智模型

```text
多个 collector 只负责“提名节点并说明理由”
CandidatePool 负责合并理由
trimToMaxNodes 负责统一取舍
collectExploreEdges 负责生成局部 typed graph
rankExploreNodes 负责计算局部结构分
deriveExecutionPaths 负责整理可解释路径
```
