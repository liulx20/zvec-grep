# Zvec-Grep Explore Seed Resolution

本文基于 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac)，说明 query 如何变成 root symbol IDs。

## 1. 真实入口

[`resolveExploreRequest()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/request-plan.ts#L34-L128) 按固定顺序处理：

```text
显式 seedId
  → resolveExactExploreSeedGroups()
  → 唯一 exact group：exact_symbol
  → 多个 exact groups：ambiguous
  → 无 exact group：resolveExploreSeeds()，intent=concept
```

`exact_symbol` 和 `concept` 由 [`resolveExploreIntent()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/intent.ts#L4-L9) 判定。

## 2. Exact Symbol 路径

[`resolveExactExploreSeedGroups()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L1297-L1354) 尝试把 query 安全地解释为一个精确符号概念。

```text
CheckoutService::placeOrder
  → path hint（若有）
  → lookup leaf = placeOrder
  → 按名称召回
  → qualified identity 过滤
  → semantic grouping
```

Path helpers 在 [`policy.ts#L1389-L1440`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L1389-L1440)，lookup leaf 与 qualified match 在 [`symbol-lookup.ts`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/symbol-lookup.ts#L5-L26)。

声明和定义如果 kind、scope、name 相同，会被 [`groupSemanticSymbols()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/symbol-lookup.ts#L105-L134) 放进同一 group：

```ts
{ ids: ["place_decl", "place_def"], representative: place_def }
```

无关类型里的同名方法会形成独立 group。一个 group 进入 exact；多个 group 返回 ambiguous；没有安全 exact match 才进入 concept 路径。`COUNTERPART` 不决定 semantic group，它在后续 subgraph 阶段补声明/定义关系。

## 3. Concept Seed 路径

[`resolveExploreSeeds()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L269-L349) 返回的不是全部召回结果，而是：

```text
roots：最终选中的多个 seed entities
trace：候选得分、证据及入选/排除原因
```

### 3.1 解析 Query

[`parseExploreSeedQuery()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L226-L268) 提取 retrieval terms、evidence terms、qualified references 和 type references。

### 3.2 多路召回

[`retrieveSeedCandidates()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L395-L587) 合并：

```text
combined retrieval
qualified exact/callable fallback
owner fallback
approximate callable
type reference
name/per-term retrieval
```

`retrievalRank` 是候选在某次召回列表里的位置，数值越小越靠前；同一候选多次出现时保留最好 rank，并合并 exact/evidence。

各路召回的职责不同：

| 路径 | 作用 |
|---|---|
| combined retrieval | 用完整 query 做一次综合语义/关键词召回 |
| qualified exact | 精确匹配 `Router::resolve` 一类完整 identity |
| callable fallback | 完整限定名未命中时，尝试最接近的可调用成员 |
| owner fallback | 成员未找到时，先保住 `Router` 等 owner 类型 |
| approximate callable | 允许轻微命名差异，但只作为较弱候选 |
| type reference | 单独召回 query 中显式出现的类型 |
| name/per-term | 按名称以及每个 term/variant 补漏 |

例如同一文件可能在 combined retrieval 中排第 3，在 `payment` 单 term 召回中排第 1。合并结果不是两个 candidate，而是一个 candidate：

```text
retrievalRank = 1
evidence = { combined_retrieval, term_retrieval:payment }
```

`exact` 也采用“只升级、不降级”的合并方式：任一路确认精确命中，最终 candidate 就保留 exact 标记。

### 3.3 Seed Evidence

[`addSeedEvidence()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L588-L603) 将多路召回理由合并到同一个 candidate。常见 evidence 包括：

```text
exact reference
qualified callable
owner/type reference
combined/term retrieval
name match
structural/callable anchor
```

Evidence 回答“候选为什么出现”，retrieval rank 回答“它在某次召回中排多前”，二者不是同一个分数。

### 3.4 打分与选择

[`rankSeedCandidates()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L702-L818) 综合 exact、retrieval rank、scope、production、callable、结构性和 concept coverage。

[`selectInitialSeeds()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L819-L984) 先选 hard/structural/callable anchors；[`completeSeedSelection()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/policy.ts#L985-L1163) 再补尚未覆盖的概念。

候选排序大致考虑：

```text
显式 exact/qualified 命中
scope 是否冲突
retrieval rank
symbol name 与 query 的对应程度
callable/type/structural 身份
production 路径优先
query concept coverage
```

`production` 指正常产品源码；tests、examples、docs、vendor、generated、tools 等默认是低优先路径。它不是“绝不选择测试”，只是同等条件下优先业务实现。

初选阶段负责建立可靠锚点：

```text
hard anchor        显式且高可信的引用
structural anchor  类型、模块等结构中心
callable anchor    能代表行为的函数/方法
```

补全阶段不只是继续拿总分最高者，而是计算 marginal coverage：候选是否覆盖尚未被 roots 覆盖的 query 概念、是否与已有 roots 重复、是否提供新的 callable/结构角色。

因此多概念 query 可以返回多个互补 roots：

```text
payment + order + persistence
  → PaymentGateway
  → CheckoutService::placeOrder
  → OrderRepository::save
```

完整例子：

```text
query: how checkout charges payment and persists order

候选：
  CheckoutService::placeOrder  覆盖 checkout/order
  PaymentGateway::charge       覆盖 payment/charge
  OrderRepository::save        覆盖 order/persist
  checkout_service_test        路径低优先且概念重复

最终 roots：
  placeOrder + charge + save
```

这三个 roots 是不同概念的互补入口，不是同一 semantic group。

## 4. 最简区别

```text
Exact：多个 IDs 可以是同一符号的声明/定义
Concept：多个 IDs 可以是覆盖不同 query 概念的互补 roots
```
