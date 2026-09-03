# Zvec-Grep PR #43 整体架构

本文整理 PR [#43：feat: add persistent graph search and exploration](https://github.com/zvec-ai/zvec-grep/pull/43) 在提交 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac) 的整体框架。

这个 PR 不只是增加 `explore`。它引入了一条完整的持久化代码图链路，并把它接入 CLI、MCP、daemon、索引、查询和展示。PR 当前涉及约 172 个文件、44k 行新增代码。

## 1. 系统总图

```text
用户入口
  CLI / MCP / daemon client
          │
          ▼
ZvecGrep service facade
  search / explore / graphNeighborhood / index
          │
   ┌──────┴───────────────────────┐
   │                              │
   ▼                              ▼
索引写入管线                    查询读取管线
scan/diff                       open read session
extract fragments              GraphReader
extract graph facts            queryGraphNeighborhood
write vector/text index        exploreGraph
write SQLite graph                    │
resolve pending refs                  ▼
project counterparts            presentation / CLI / MCP output
```

原来的关键词、BM25 和向量检索仍然存在。PR 新增的 graph 是并行索引和查询能力，不是用图数据库替换向量索引。

## 2. 对外入口层

### CLI

[`runParsedCommand()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/cli/commands.ts#L76-L940) 分发命令；`args.ts`、`help.ts` 和 `types.ts` 增加 graph/explore 参数、校验和帮助文本。

主要新能力：

- Explore：根据 query 选择 roots，通过代码图扩展并组装源码上下文。
- Graph neighborhood：围绕指定 symbol 查询局部节点和 typed edges。
- Index status：展示 workspace 检索索引和 Graph Index 的可用状态。

### MCP

[`registerZvecGrepTools()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/mcp/tools.ts#L353-L437) 注册 agent 工具；`mcp/schemas.ts` 定义输入输出 schema；`cli-contract.ts` 维持 CLI/MCP contract 一致。

### Client 与 Daemon

`daemon-client.ts` 增加远程调用；[`RootRuntime`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/daemon/root-runtime.ts#L48-L343) 在长生命周期进程中提供 `search()`、`explore()` 和 `graphNeighborhood()`，并协调读写。

## 3. Service Facade

[`createZvecGrep()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/zvec-grep.ts#L103-L123) 创建统一服务实例。对外主要方法：

```text
index()              更新文本/向量/图索引
context()            普通检索上下文
explore()            代码图探索与源码 context
graphNeighborhood()  直接查看某个 symbol 的局部邻域
info()               索引和 graph 状态
```

Graph read session 由 [`openWorkspaceGraphReadSession()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/zvec-grep.ts#L185-L241) 打开，将存储生命周期和上层查询隔离。

## 4. 索引编排层

[`indexWorkspace()` / `indexWorkspacePaths()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/indexing/index.ts#L138-L220) 负责 workspace 扫描、增量 diff、内容抽取和多种索引写入。

PR 在原索引管线中加入图索引：

```text
扫描文件
  → diff 判断 added/changed/deleted
  → 文本/文档 fragment extraction
  → embedding、全文检索写入
  → code file graph extraction
  → SQLite graph writer
  → pending refs resolution
  → counterpart projection
```

`pipeline/indexing/diff.ts` 处理增量差异，`status.ts` 汇总阶段状态；workspace 删除或变更时，graph writer 同步清理旧 symbols、edges、unresolved refs 和 candidates。

完整的文件扫描、fragment、embedding 与 FileGraph 写入顺序见 [索引与源码抽取管线](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-indexing-and-extraction.md)。

## 5. 代码抽取层

`src/engine/extraction/code/` 负责从不同语言源码中提取结构和 reference sites。

主要模块：

```text
extractor.ts                 总协调
call-sites.ts                调用位置
ref-sites.ts                 类型/普通引用
value-ref-sites.ts           字段、变量、常量引用
function-ref-sites.ts        函数值和 callback 引用
inheritance-sites.ts         extends/implements/overrides
import-sites.ts              import/include/use
callable-shape.ts            signature、arity、return type
call-resolution-facts.ts     receiver/调用解析事实
dynamic-call-target.ts       动态调用 target 描述
c-function-pointer-registration.ts
                             C 函数指针注册关系
```

语言 adapter 位于 `families/` 和 `languages/`，覆盖 C/C++、JS/TS、Python、Rust、Go、Java，并新增 C#、Dart、Swift 等语言配置。

这层回答：

> 源码中出现了哪些 symbol、ownership、call/ref/inheritance/import site？

复杂流程见 [图关系抽取与解析](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-graph-relation-extraction.md)。

## 6. Graph Normalization

[`extractFileGraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/extract-file-graph.ts#L25-L222) 将语言分析结果转换为文件级图输入：

```text
nodes       归一化 symbols
edges       本文件可直接确定的 local relationships
refs        等待跨文件解析的 RawRefs
```

[`fileGraphFromFragments()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/from-fragments.ts#L34-L186) 负责 fragment → node、qualified identity 和 ownership。

辅助模块：

```text
local-reference-resolver.ts  文件内名称解析
name-index.ts                symbol name/qualified name 索引
symbol-kinds.ts              跨语言 symbol kind 判断
reference-target.ts          receiver/member target 模型
reference-resolution-policy.ts
                             引用解析限制与策略
imports/*                    多语言 import path 收集和解析
```

## 7. SQLite Graph Persistence

[`openGraphStorage()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/open.ts#L17-L45) 根据 workspace 状态打开可用 SQLite graph 或 unavailable fallback。

持久化模块分工：

```text
database.ts              SQLite 生命周期、事务、schema version
schema.ts                表结构
writer.ts                文件级图写入和增量删除
edge-repository.ts       edge 查询/写入封装
reader.ts                GraphReader 查询实现
candidate-repository.ts  semantic candidate 查询
direct-candidate-index.ts
                         resolver 的直接候选内存索引
projection-buffer.ts     edge/dynamic candidate 原子投影
```

当前核心表及字段见 [SQLite Graph Schema](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-graph-data-model.md)。

Writer、pending resolver、projection buffer、dynamic candidate 和 reader 的协作见 [图持久化与引用解析](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-graph-persistence-and-resolution.md)。

## 8. Pending Reference Resolution

本文件内不能唯一解析的 RawRef 先写入 `unresolved_refs`。[`SqlitePendingRefResolver`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/pending-ref-resolver.ts#L86-L1949) 再按 imports → hierarchy → instantiation → calls/refs 的顺序跨文件解析。

可能结果：

```text
resolved  → persisted edge
external  → 外部依赖状态
failed    → 保留并允许重试
dynamic   → boundary + edge_candidates
```

C++ receiver inference 在 `cpp-receiver-inference.ts`；内置类型/函数排除在 `builtins.ts`；解析结果通过 `projection-buffer.ts` 原子写入。

## 9. COUNTERPART Projection

[`SqliteCounterpartProjector`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/counterpart-projector.ts#L26-L176) 针对 C/C++ header/source，以 qualified identity、kind、arity、路径和 import 关系建立 declaration/definition `COUNTERPART`。

这是 query-independent 的持久化后处理，不是 Explore 的 semantic grouping。

## 10. Graph Neighborhood Query

[`queryGraphNeighborhood()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/query.ts#L70-L411) 是较直接的图查询：

```text
解析 focal symbol
  → 按方向和 edge kinds 做 bounded traversal
  → 返回 focal、containers、members、incoming/outgoing
  → 可包含 source snippets 和 diagnostics
```

它适合回答“这个 symbol 周围有什么”，不进行 Explore 那套 intent、MMR 和多文件源码组装。

## 11. Explore Application

Explore 是建立在 GraphReader 之上的高层应用：

```text
query
  → seed resolution / intent
  → bounded subgraph candidates
  → induced graph + node PPR
  → paths / dynamic / impact enrichment
  → file evidence + MMR
  → source assembly
```

入口由 `graph/explore.ts` 暴露，核心编排在 `explore/subgraph.ts`。复杂模块已经拆成独立文档：

- [Explore 总览](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-explore-overview.md)
- [Seed Resolution](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-explore-seed-resolution.md)
- [Subgraph](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-explore-subgraph.md)
- [Ranking 与文件选择](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-explore-ranking.md)
- [源码组装](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-explore-source-assembly.md)

## 12. Presentation

[`formatExploreResult()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/presentation/graph.ts#L29-L199) 和 [`formatNeighborhoodResult()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/presentation/graph.ts#L206-L697) 将结构化结果转成 CLI 文本。

展示内容包括 roots、files、source、typed edges、paths、dynamic boundaries、blast radius、change surface 和截断状态。Presentation 只格式化结果，不重新选择节点或文件。

## 13. Runtime、并发与缓存

长生命周期 daemon 需要同时支持查询和增量索引：

```text
RootRuntime
  read operations: search/explore/neighborhood
  write operations: index/drop/disable
  session/cache lifecycle
```

`workspace-read-session-cache.ts` 和新增 `utils/read-handle-cache.ts` 管理可复用读句柄；写操作通过 runtime 协调，避免读到半更新状态。

CLI/MCP、service、read session、daemon runtime 以及 neighborhood/Explore 的边界见 [查询接口与运行时](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-query-and-runtime.md)。

## 14. Benchmark 与测试

PR 新增 `benchmarks/explore-quality/`，覆盖：

```text
语言矩阵
真实仓库 cases
agent A/B trace
warm query
结果质量与稳定性
```

测试按模块覆盖：

```text
graph-storage       schema、writer、reader
graph-calls         call/ref/dynamic resolution
graph-imports       import path
graph-inherits      hierarchy
graph-query         neighborhood
graph-explore       Explore 主链
graph-presentation  CLI 输出
name-index          identity lookup
```

## 15. 两条端到端主链

### 写入链

```text
indexWorkspace
  → analyzeForIndexing
  → extractFileGraph
  → SqliteGraphWriter
  → SqlitePendingRefResolver
  → SqliteCounterpartProjector
  → graph.sqlite
```

### 读取链

```text
CLI / MCP / daemon
  → ZvecGrep service
  → openWorkspaceGraphReadSession
  → GraphReader
  ├─ queryGraphNeighborhood
  └─ exploreGraph
       → presentation
```

## 16. 模块边界速记

```text
extraction/code       理解多语言源码语法
engine/graph          归一化、解析并查询代码图
persistence/sqlite    持久化事实和未决引用
graph/explore         从图生成有限源码 context
pipeline/indexing     把图写入现有增量索引生命周期
service/daemon        暴露能力并管理资源
cli/mcp               参数与协议入口
presentation          只负责输出
benchmarks/tests      验证质量、语言覆盖和稳定性
```

## 17. 建议阅读顺序

1. 本文：先建立整个 PR 的模块地图。
2. [索引与源码抽取管线](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-indexing-and-extraction.md)：文件怎样变成 fragments 和 FileGraph。
3. [图关系抽取与解析](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-graph-relation-extraction.md)：多语言语法怎样变成关系事实。
4. [SQLite Graph Schema](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-graph-data-model.md)：这些事实具体存在哪里。
5. [图持久化与引用解析](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-graph-persistence-and-resolution.md)：未决引用怎样变成边和动态候选。
6. [查询接口与运行时](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-query-and-runtime.md)：图怎样被 CLI、MCP 和 daemon 安全读取。
7. [Explore 总览](https://github.com/liulx20/zvec-grep/blob/beffad0/docs/pr43/zvec-grep-explore-overview.md)：最后再进入 Explore 的 seed、subgraph、ranking 和 assembly。
