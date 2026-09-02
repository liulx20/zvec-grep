# PR #43：索引与源码抽取管线

本文解释提交 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac) 如何把原有文本/向量索引扩展为“文本、向量、代码图”共同写入的索引流程。

## 1. 这层最终产出什么

一次索引并不是只生成 `graph.sqlite`，而是并行维护三类结果：

```text
源码/文档文件
  ├─ fragment 与文本内容 ──→ 全文/BM25 索引
  ├─ fragment embedding ───→ 向量索引
  └─ code graph facts ─────→ SQLite graph
```

因此图片、普通文档等仍可进入原有内容和向量索引；只有能够产生代码实体和关系的文件才进入代码图。`explore` 主要消费右边的 graph，但必要时还会借助普通 retrieval 找 roots。

## 2. 从 workspace 扫描开始

入口是 [`indexWorkspace()` 和 `indexWorkspacePaths()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/indexing/index.ts#L138-L162)。前者处理整个 workspace，后者处理 watcher 提交的指定路径。

两者进入各自的 unchecked 实现后，整体都是：

```text
确定 workspace/index 配置
  → 扫描文件
  → 与 manifest 比较
  → 形成 added / changed / deleted
  → 执行一次 index pass
  → 必要时做收尾解析和 storage optimize
  → 更新 manifest 和状态
```

[`computeIndexDiff()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/indexing/diff.ts#L15-L60) 先比较路径、mtime、size；需要时再计算内容 hash，避免每次都重新抽取未变化文件。

## 3. 一个文件如何被准备

批量调度位于 [`indexFiles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/indexing/index.ts#L623-L754)，单文件准备位于 [`prepareFile()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/indexing/index.ts#L756-L802)。

单文件准备可以理解为：

```text
读取 Source
  → 根据文件类型选择 extractor
  → 得到可检索 fragments
  → 如果是支持的代码文件，额外构造 FileGraph
  → 返回 PreparedFile
```

这里的 `fragment` 是供检索、展示和 embedding 使用的内容单位；`FileGraph` 是供图存储使用的结构化事实。二者来自同一次源码理解，但用途不同。

## 4. 多语言在哪一层处理

语言差异首先由 `src/engine/extraction/code/` 吸收。它负责抽取：

- symbol declaration/definition；
- ownership 与 callable shape；
- call、普通引用和值引用位置；
- inheritance、import 和 instantiation 位置；
- receiver、callback、函数指针等解析提示。

`families/` 放语言家族共享逻辑，`languages/` 放具体语言配置。后面的 graph 层尽量只看统一的 symbol、reference site 和 resolution fact，而不重复解析每种语言语法。

索引侧从 [`analyzeForIndexing()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/extraction/runtime.ts#L72-L112) 选择 extractor 并返回 fragments 和 analysis facts；代码 extractor 在 [`extractor.ts#L1332-L1420`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/extraction/code/extractor.ts#L1332-L1420) 根据 `source.file.format` 调 parser 和语言 adapter。多语言 import 分支的具体例子见 [`import-sites.ts#L46-L310`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/extraction/code/import-sites.ts#L46-L310)。

这意味着多语言处理不是 Explore 阶段做的。Explore 读取的已经是统一图模型。

更细的 source site → edge/ref 映射见 [图关系抽取与解析](./zvec-grep-graph-relation-extraction.md)。

## 5. 从 fragments 到 FileGraph

[`extractFileGraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/extract-file-graph.ts#L37-L222) 把抽取结果归一化为：

```ts
{
  nodes, // 当前文件里的标准化 symbol
  edges, // 当前文件内已经能确定的关系
  refs   // 需要跨文件解析的 RawRef
}
```

其关键分界是“现在是否能唯一确定 target”：

- 能确定：直接产生 typed edge；
- 不能确定：保存 RawRef、receiver、import、arity、source range 等提示，留给持久化后的 resolver；
- 存在多个可信动态目标：后续可形成 dynamic boundary/candidates，而不是伪装成唯一 `CALLS`。

[`fileGraphFromFragments()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/from-fragments.ts#L34-L186) 先建立基础节点、qualified identity、文件和 owner 关系；`extractFileGraph()` 再吸收 calls、refs、imports、inheritance 等关系事实。

## 6. 写入顺序

Prepared files 完成 embedding 后，由 [`commitFile()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/indexing/index.ts#L937-L995) 提交文件内容、fragments 和 graph facts。

对 graph 而言，顺序大致是：

```text
删除该文件旧 graph 记录
  → 写 file/entity/node
  → 写本地已解析 edges
  → 写 unresolved refs 和辅助 facts
  → 所有变更文件完成后，执行跨文件 resolution
  → 投影 declaration/definition COUNTERPART
```

删除旧记录很重要：增量更新不是向旧图上继续追加，否则代码改名后会留下幽灵节点和旧边。

## 7. 失败、取消与重试

索引允许文件级失败被记录，而不是让所有成功文件消失。Embedding 有独立的调度、并发和重试逻辑；取消信号会在批次与单文件边界检查。

Graph resolution 属于索引收尾阶段。一个引用暂时解析失败可以留在 `unresolved_refs`，以后相关文件进入索引后再次尝试。这也是为什么抽取阶段不强行猜测所有跨文件 target。

收尾调用位于 [`optimizeStorage()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/indexing/index.ts#L585-L613)：并行 finalize Zvec writes，并在 graph 有变化时执行 `resolvePending()`。Embedding 的批量重试、退避和取消处理集中在 [`embedContentsWithRetry()` 及其辅助逻辑](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/indexing/index.ts#L1226-L1594)。

## 8. 与后续模块的边界

```text
本文件：扫描、diff、抽取、形成并提交 FileGraph
  ↓
图持久化与引用解析：把 RawRef 变成持久化 edge/candidate
  ↓
查询接口：读取稳定图快照
  ↓
Explore：从图和源码中选择有限 context
```

下一篇见 [图持久化与引用解析](./zvec-grep-graph-persistence-and-resolution.md)。
