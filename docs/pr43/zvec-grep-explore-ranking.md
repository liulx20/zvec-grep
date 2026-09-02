# Zvec-Grep Explore 排序与文件选择

本文基于 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac)，只讲三步：Node PPR、File Score、MMR。

## 1. Node PPR/RWR

候选已经在 subgraph 中裁剪完毕。[`rankExploreNodes()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/ranking.ts#L8-L38) 在 induced graph 上计算：

```text
实际边权 = edge-kind weight × edge.confidence
```

roots 是 restart seeds；`rankingLinks` 也参与邻接，但不是持久化 typed edges。PPR 只产生 `nodeId → score`，不直接选择文件。

Evidence 与 PPR 不同：evidence 说明节点为什么入池，PPR 衡量它在裁剪后局部拓扑中的重要性。

当前关系基础权重的相对顺序是：

```text
CALLS 1.0
INHERITS 0.9
COUNTERPART 0.7
INSTANTIATES 0.6
REFS 0.5
IMPORTS / DEFINES 0.4
CONTAINS 0.15
```

例如一条 confidence `0.4` 的 heuristic `CALLS`，实际权重为 `1.0 × 0.4 = 0.4`；一条确定 `REFS` 为 `0.5 × 1.0 = 0.5`。因此推测调用不会因 kind 是 `CALLS` 就压过所有确定关系。

`CONTAINS` 较低是为了避免一个大类的 sibling members 吸走随机游走质量。多 roots 时 restart distribution 分布在 roots 上，所以 PPR 衡量的是“相对整组 roots 的结构中心性”。

## 2. File Score

[`rankExploreFiles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/ranking.ts#L40-L144) 将同一文件的 node scores 按递减贡献聚合，避免大文件单靠 symbol 数量获胜，并加入 root、query、definition 与低价值路径修正。

随后 [`collectExploreFileEvidence()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-evidence.ts#L14-L120) 收集文件理由：root、counterpart、caller/callee、query alignment、concept、integration、call path 等。

同文件 node score 不是直接求和，而是递减聚合：第一个高分节点贡献最大，后续节点贡献快速衰减并有下限。这样一个包含几十个 sibling methods 的文件不会仅靠数量获胜。

File base score 还会调整：

```text
root file boost
query term hit
root qualified identity 对应的 definition file
tests/vendor/examples/tools 等路径降权
```

[`evidenceWeight()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L232-L249) 按 intent 使用不同权重：exact 更重 root/counterpart/direct flow，concept 更重 semantic seed、coverage 和角色多样性。强度先按本次请求内最大值归一化。

归一化的原因是避免数量失控。例如 caller 数分别为 `2、20、200` 时，不能让 200 个 caller 线性放大 100 倍。系统先找本次候选中的最大强度，再映射到同一尺度。

## 3. MMR 选择文件

[`selectExploreFiles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L108-L162) 先满足 root/seed 和 counterpart 等少数一致性约束，再按 [`marginalGain()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L262-L345) 贪心选择：

```text
marginal gain
  = relevance
  - 重复 family/semantic 收益
  + 未覆盖 concept/角色奖励
  - 与已选文件的相似度
```

相似度由 [`fileSimilarity()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L346-L393) 计算。最佳 marginal gain 不再为正时提前停止，因此 `maxFiles=8` 是最多八个，不是必须凑满。

相似度综合：

```text
relation family overlap
symbol identity overlap
query concept overlap
semantic path token overlap
```

novelty 只奖励有用的新角色，例如 `concept:*`、`entrypoint`、`hierarchy`、`call_path`、`root_counterpart`；`low_value_path` 不会因为首次出现就得到奖励。

最后 [`assignFileRoles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/file-selection.ts#L163-L205) 只在已选文件中标记 central/supporting；它不重新决定入选。

### 一个选择例子

```text
maxFiles = 4

1. root 声明文件：一致性约束
2. root 定义文件：root_counterpart
3. controller：提供尚未覆盖的 direct_caller/entrypoint
4. repository：提供 direct_call/call_path 执行结果
```

第二个相似 controller 即使相关，也可能因 family、symbol、concept 和 path 重复被 MMR 抑制。测试文件如果只有 impact/low-value evidence，通常留在摘要而不占源码槽位。

## 4. 最简心智模型

```text
Node PPR：局部图中谁重要
File Score：哪些文件相关
MMR：在有限槽位里选相关且不重复的文件
```
