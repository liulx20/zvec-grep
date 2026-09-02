# Zvec-Grep 存储模型：Zvec Index 与 SQLite Graph

本文基于 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac)，先说明原有 Zvec 内容索引与新增 SQLite Graph 的关系，再解释 [`schema.ts`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/schema.ts#L1-L72) 中的图表结构。当前 graph schema version 为 `5`，所有表使用 `STRICT`。

源码如何产生 symbols、local edges、pending refs、dynamic candidates 和 COUNTERPART，见 [图关系抽取与解析](./zvec-grep-graph-relation-extraction.md)。

下面 graph 部分的 SQL 添加了说明注释；字段和约束本身与真实 schema 一致。

## 1. 一个 workspace 实际有两套索引存储

[`resolveWorkspaceIndexLayout()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/storage/layout.ts#L20-L38) 生成的目录大致是：

```text
workspace index directory
  ├─ manifest.json
  ├─ files.zvec
  ├─ index.zvec
  └─ code-graph/
       └─ graph.sqlite
```

它们不是主从表，也不是把 SQLite 挂进 Zvec 做 join，而是两个并列的读取模型：

```text
Zvec 内容索引                         SQLite Graph
──────────────────────────────       ─────────────────────────────
files.zvec：文件元数据                files：图侧文件投影
index.zvec：fragment/entity 文档      symbols：图节点及源码范围
FTS text：词法检索                    contains：ownership
embedding：向量检索                  edges：typed relationships
fragment 原文/图片 payload            unresolved_refs：未决引用
                                      edge_candidates：动态候选
```

Zvec 回答“哪些内容和 query 相似”；Graph 回答“symbol 之间是什么关系”。Graph 并没有替代之前的 Zvec 存储。

## 2. 两边通过什么关联

两套存储没有跨数据库外键。它们通过同一次抽取生成的稳定 ID 和文件元数据在应用层对齐：

```text
FileInfo.id              files.zvec ↔ graph.files.id
EntityFragment.id        index.zvec ↔ graph.symbols.id（同一公开代码实体时）
absolute/relative path   用于展示、过滤和读取当前源码
manifest/generation      表示它们属于哪次 workspace 索引状态
```

并不是每个 Zvec fragment 都必须成为 graph symbol：Markdown 段落、图片或普通文档可以只存在于内容索引。反过来，图抽取为关系解析吸收的辅助 symbol，也不一定都是面向普通搜索展示的独立 fragment。

这种关系更准确地说是“共享 identity 的双投影”，不是数据库层一一对应。

## 3. Zvec 原有存储保存什么

[`WorkspaceIndexStorage`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/storage/index.ts#L48-L77) 暴露文件、entity、FTS 和 vector 操作。生产实现是 `ZvecWorkspaceIndexStorage`。

`files.zvec` 保存文件路径、hash、格式、索引状态和该文件的 entity IDs。[`index.zvec` schema](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/storage/zvec.ts#L906-L964) 保存每个 fragment 的：

- `file_id`、`group` 和 fragment range；
- `symbol_name/type/scope/signature` 等可检索 metadata；
- `text` FTS 字段；
- `embedding` 向量；
- 文本或图片等内容 payload。

所以原先“图片保存成向量”的能力仍然在 `index.zvec`：图片 fragment 可以保存 base64/format 和 embedding，但不会因为有向量就自动变成代码图节点。

[`replaceFile()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/storage/zvec.ts#L206-L265) 删除该文件旧 documents，再写入新的 fragment documents 和 vectors。

## 4. 索引时如何双写

一次源码分析同时产生 `fragments` 和可选的 `FileGraph`：

```text
read source
  → analyzeForIndexing
  ├─ fragments ─→ embedding ─→ storage.replaceFile() ─→ *.zvec
  └─ FileGraph ───────────────→ graph.upsertFileGraph() ─→ graph.sqlite
                                      ↓
                              resolve pending refs
                              project COUNTERPART
```

具体提交点在 [`commitFile()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/indexing/index.ts#L937-L995)：先替换 Zvec 文件内容，再 upsert graph file。它们由同一索引 pass 和 manifest 生命周期协调，但不是一个跨 Zvec/SQLite 的数据库事务。

删除和重建也必须同时处理两边：否则搜索可能召回已经删除的 fragment，或者图中残留旧 symbol/edge。

## 5. 查询时两套存储如何交互

三条查询路径并不相同。

### 普通 `search/context`

```text
query
  → Zvec FTS 和/或 vector search
  → fragment hits
  → 去重、融合、组装 context
```

它主要读取 `files.zvec/index.zvec`。Graph 不是每次普通检索的必经步骤。

具体调用从 [`contextFromOpenWorkspaceIndex()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/zvec-grep.ts#L1351-L1431) 进入 `WorkspaceIndex.searchPlan()`；每条 route 最终在 [`pipeline/search/index.ts#L718-L735`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/pipeline/search/index.ts#L718-L735) 选择 `storage.searchFts()` 或生成 query vector 后调用 `storage.searchVector()`。Zvec 两个实际查询入口分别在 [`zvec.ts#L293-L323`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/storage/zvec.ts#L293-L323) 和 [`zvec.ts#L325-L340`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/storage/zvec.ts#L325-L340)。

### `graphNeighborhood`

```text
symbol query
  → SQLite Graph 定位 seed
  → 按 typed edge 做有界遍历
  → 返回邻居和图侧 entity/file projection
```

[`openWorkspaceGraphReadSession()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/zvec-grep.ts#L185-L241) 明确让 graph-only neighborhood 不打开 Zvec collections，也不使用 embedding model。

实际的 seed 解析和 bounded traversal 位于 [`queryGraphNeighborhood()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/query.ts#L70-L166)；这里接收的是 `GraphReader`，没有 Zvec search route。

### `explore`

Explore 是两套存储真正汇合的位置：

```text
query
  ├─ Zvec FTS symbolSearch ─────────────┐
  │   提供 lexical/concept seed 候选    │  用共享 entity ID 合并
  └─ SQLite exact/name lookup ──────────┘
                    ↓ root IDs
             SQLite Graph traversal
             edges / paths / dynamic / impact
                    ↓ selected symbol IDs/files
             读取当前磁盘源码并组装
             必要时使用候选携带的 indexed fragment
```

Service 在 [`withGraphWorkspace()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/zvec-grep.ts#L520-L564) 中为 Explore 同时打开 `WorkspaceIndex` 和它的 graph reader，并把 `findSymbolsByQuery()` 作为 `symbolSearch` 传入。该方法底层调用 Zvec FTS，见 [`workspace-index.ts#L168-L177`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/workspace-index.ts#L168-L177)。

[`resolveExploreRequest()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/request-plan.ts#L34-L120) 先尝试 graph exact groups，再由 [`resolvePreferredSeeds()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/request-plan.ts#L123-L145) 把传入的 Zvec `symbolSearch` 与 graph 自身 lookup 组合。得到 root IDs 后，[`exploreSubgraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/subgraph.ts#L978-L1368) 才通过 `GraphReader` 收集候选、边并建立 induced graph。

要注意，Zvec retrieval 在这里主要帮助“找 root/补概念候选”，不是提供图边。`CALLS/REFS/INHERITS` 等关系和 PPR 的 induced graph 都来自 SQLite Graph。

源码正文也不是存在 `edges` 里。[`readFileText()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/reader.ts#L349-L361) 按 graph `files.absolute_path` 读取当前磁盘；assembly 放不下时按 `symbols.range_json` 裁剪。如果当前文件无法读取，而候选仍携带索引 fragment 内容，组装器可标记 `sourceOrigin=indexed_fragment`。

文件和 symbol 的最终读取、排序与预算组装入口是 [`assembleExploreFiles()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/explore/assembly.ts#L34-L247)。

## 6. 两套存储的交互边界

最容易混淆的几点是：

- Zvec 的 FTS/vector score 不会被写成 graph edge confidence；
- graph `edge.confidence` 不会回写为 fragment embedding score；
- retrieval rank 只作为 Explore 请求内的 seed/evidence 信号；
- root ID 确定后，结构扩展主要由 SQLite edges 驱动；
- 最终源码优先读取当前磁盘，而不是把 Zvec 或 SQLite 当完整源码仓库；
- 两套存储靠应用层 ID、manifest 和读写锁协调，不存在 SQL join。

因此最简洁的心智模型是：

```text
Zvec = 找内容、找候选
Graph = 认 identity、走关系
Disk = 取最终源码正文
Explore = 在应用层编排三者
```

## 7. SQLite Graph 内部整体关系

```text
files
  └─< symbols
       ├─< contains.parent_id / child_id
       ├─< edge_candidates.target_id
       └─ edges.src_id / dst_id（逻辑关联）

unresolved_refs
  └─< edge_candidates.edge_id

graph_meta
  独立 key/value 元数据
```

## 8. `graph_meta`

```sql
CREATE TABLE graph_meta (
  key   TEXT PRIMARY KEY, -- 元数据名称
  value TEXT NOT NULL     -- 字符串值；版本、状态和计数也以文本保存
) STRICT;
```

实际保存 `schema_version=5`、`counterpart_projection_dirty`、`pending_ref_attempt` 等状态。版本初始化见 [`database.ts#L242-L261`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/database.ts#L242-L261)。

## 9. `files`

```sql
CREATE TABLE files (
  id TEXT PRIMARY KEY,          -- 文件稳定图 ID；关联文件时不用路径
  absolute_path TEXT,           -- 索引时的绝对路径
  relative_path TEXT,           -- 相对 workspace/root 的路径
  root_path TEXT,               -- 所属索引根目录
  size_bytes INTEGER,           -- 索引时文件字节数
  last_modified_time INTEGER,   -- 索引时修改时间
  kind TEXT,                    -- 上游抽取的文件实体类别
  format TEXT                   -- 文件格式/语言格式信息
) STRICT;
```

除 `id` 外均可为 `NULL`，所以元数据不完整的文件也能先按 ID 存在。

典型例子：`kind` 可能表示源码/文档等文件类别；`format` 常是语言或格式，例如 `typescript`、`cpp`、`python`、`markdown`。这两个字段没有 SQL `CHECK`，实际集合由上游 extractor 决定。

## 10. `symbols`

```sql
CREATE TABLE symbols (
  id TEXT PRIMARY KEY,          -- symbol 稳定图 ID
  file_id TEXT NOT NULL         -- 所属文件
    REFERENCES files(id) ON DELETE CASCADE,

  name TEXT,                    -- 短名称，如 placeOrder
  qualified_name TEXT,          -- 限定名，如 CheckoutService::placeOrder
  kind TEXT NOT NULL,           -- 跨语言归一化 symbol 类别
  is_exported INTEGER NOT NULL  -- 是否对外可见，SQLite 用 0/1
    CHECK (is_exported IN (0,1)),

  signature TEXT,               -- callable 签名
  arity INTEGER,                -- 参数数量，用于重载消歧
  return_type TEXT,             -- 返回类型文本
  range_json TEXT,              -- 源码 range 的 JSON，组装时用于切片
  scope TEXT,                   -- namespace/class/module 等 owner identity
  node_type TEXT,               -- parser/语言层原始 AST/CST 节点类别
  modifiers_json TEXT           -- public/static/async 等修饰信息 JSON
) STRICT;
```

`kind` 用于统一图语义，`node_type` 保留语言解析器的细分类别。Writer 在 `qualified_name` 缺失时回退到 `name`。删除 file 会级联删除其 symbols。

`symbols.kind` 没有 SQL `CHECK`，常见值来自抽取结果，例如：

```text
function / abstract_method
class / abstract_class
interface / struct / enum / trait
type / value / component
markdown / unknown（非代码或降级输入）
```

例如 C++ 方法和普通函数在统一图层通常都可能归为 `function`，而 `node_type` 再保留 `method_definition`、`function_definition`、`class_declaration` 等语言解析器细节。


## 11. `contains`

```sql
CREATE TABLE contains (
  parent_id TEXT NOT NULL       -- owner：class/namespace/module
    REFERENCES symbols(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL        -- member/nested symbol
    REFERENCES symbols(id) ON DELETE CASCADE,
  PRIMARY KEY(parent_id, child_id)
) STRICT, WITHOUT ROWID;
```

它表示 symbol ownership，例如 `CheckoutService → placeOrder`。它单独成表；当前 persisted `edges.kind` 中没有 `CONTAINS`。

## 12. `edges`

```sql
CREATE TABLE edges (
  id TEXT PRIMARY KEY,          -- 边稳定 ID

  src_id TEXT NOT NULL,         -- 起点 file/symbol ID
  dst_id TEXT NOT NULL,         -- 终点 file/symbol ID
  src_is_file INTEGER NOT NULL  -- 1: files.id；0: symbols.id
    CHECK (src_is_file IN (0,1)),
  dst_is_file INTEGER NOT NULL  -- 1: files.id；0: symbols.id
    CHECK (dst_is_file IN (0,1)),

  kind TEXT NOT NULL            -- 关系大类
    CHECK (kind IN (
      'CALLS','REFS','INHERITS',
      'IMPORTS','COUNTERPART','INSTANTIATES'
    )),
  rel TEXT NOT NULL,            -- kind 内细分语义，如 function/value
  count INTEGER NOT NULL DEFAULT 1,       -- 聚合出现次数
  first_line INTEGER NOT NULL DEFAULT 0,  -- 首次源码行，0 表示无位置
  ref_name TEXT NOT NULL DEFAULT '',      -- 源码中实际写出的引用名

  source_language TEXT,         -- 产生引用的源语言
  imported_name TEXT,           -- import 的原名称
  local_name TEXT,              -- alias 后的本地名称
  receiver_kind TEXT,           -- receiver 形态/解析类别
  receiver_name TEXT,           -- receiver 原始或推断名称
  member_name TEXT,             -- 被访问/调用的 member
  resolution_hints TEXT,        -- receiver type/generic bounds 等 JSON

  provenance TEXT NOT NULL DEFAULT 'static' -- 关系来源
    CHECK (provenance IN ('static','heuristic')),
  confidence REAL NOT NULL DEFAULT 1.0,     -- src→dst 解析可信度
  evidence TEXT                            -- 解析/投影依据说明
) STRICT;
```

`src_is_file/dst_is_file` 实现多态端点。SQLite 无法声明“根据布尔值引用 files 或 symbols”的普通外键，因此端点完整性由 writer 维护。

`kind` 的允许值由 SQL 明确限制；典型关系是：

```text
CALLS         placeOrder → save
REFS          placeOrder → payment_ / Order
INHERITS      StripeGateway → PaymentGateway
IMPORTS       controller.ts → service.ts
COUNTERPART   place_decl ↔ place_def
INSTANTIATES  container → StripeGateway
```

`rel` 没有 CHECK，会随 kind 细分，例如 `call`、`function`、`value`、`type`、`extends`、`implements`、`overrides`、`import`、`new`。

`evidence` 是引用解析依据，不是 Explore 的 node evidence。Explore 的 PPR 使用：

```text
edge-kind weight × confidence
```


## 13. `unresolved_refs`

```sql
CREATE TABLE unresolved_refs (
  id TEXT PRIMARY KEY,          -- 未解析引用 ID

  owner_id TEXT NOT NULL,       -- 产生引用的 file/symbol ID
  owner_is_file INTEGER NOT NULL -- 1: file；0: symbol
    CHECK (owner_is_file IN (0,1)),

  ref_name TEXT NOT NULL,       -- 待解析的完整引用文本/名称
  ref_kind TEXT NOT NULL,       -- call/import/value/type 等引用类别
  line INTEGER NOT NULL,        -- 引用发生的源码行

  imported_name TEXT,           -- import 原名称
  local_name TEXT,              -- import alias 后名称
  source_language TEXT,         -- 源语言
  receiver_kind TEXT,           -- receiver 分类
  receiver_name TEXT,           -- receiver 名称/表达式抽取结果
  member_name TEXT,             -- 被访问或调用的成员名
  resolution_hints TEXT,        -- receiverType 等 resolver hints JSON

  status TEXT NOT NULL          -- 当前解析状态
    CHECK (status IN ('pending','failed','external','dynamic')),
  last_attempt INTEGER NOT NULL DEFAULT 0, -- 已尝试次数
  dynamic_reason TEXT           -- 不能唯一绑定的动态分派原因
) STRICT;
```

`ref_kind` 没有 SQL `CHECK`。当前 resolver 明确处理的常见值包括：

```text
call        函数/方法调用
new         实例化
import      模块或符号导入
extends     继承
implements  实现接口
overrides   方法覆写
type        类型引用
function    函数值/函数引用
value       字段、变量或常量引用
```

状态含义：

```text
pending   等待 resolver
failed    已尝试但无法解析
external  外部/标准库目标
dynamic   存在多个合理运行时候选
```

`owner_id` 也是多态 ID，所以没有普通外键。


## 14. `edge_candidates`

```sql
CREATE TABLE edge_candidates (
  edge_id TEXT NOT NULL         -- 实际关联 unresolved_refs.id
    REFERENCES unresolved_refs(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL       -- 一个可能目标 symbol
    REFERENCES symbols(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,         -- hierarchy/generic_bound/method_set 等依据
  confidence REAL NOT NULL,     -- 该 candidate 是目标的可信度
  PRIMARY KEY(edge_id, target_id)
) STRICT, WITHOUT ROWID;
```

`edge_id` 这个名字容易误导：它不是 `edges.id`，而是“待投影引用”的 `unresolved_refs.id`。

`reason` 的典型值来自动态候选解析，例如：

```text
hierarchy        由继承层次得到
generic_bound    由泛型约束得到
method_set       由 receiver 的方法集合得到
function_pointer 由函数指针注册/绑定得到
namespace_export 由命名空间导出得到
```

```text
unresolved_refs: payment_->charge
  ├─ StripeGateway::charge  reason=hierarchy, confidence=...
  └─ MockGateway::charge    reason=method_set, confidence=...
```

删除 unresolved reference 或 target symbol 都会级联删除 candidate。Explore 的 dynamic boundary 查询联查这三张表，见 [`reader.ts#L427-L575`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/reader.ts#L427-L575)。

## 15. 引用解析生命周期

```text
extractor
  → unresolved_refs(status=pending)

pending-ref resolver
  ├─ 唯一目标   → 写 edges，并删除 resolved unresolved_ref
  ├─ 外部目标   → status=external
  ├─ 无法解析   → status=failed
  └─ 动态多解   → status=dynamic + edge_candidates[]
```

候选的原子写入见 [`projection-buffer.ts#L137-L158`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/projection-buffer.ts#L137-L158)。

## 16. 不属于 SQLite Schema 的数据

以下都是 Explore 请求内结构，不是数据库表：

```text
SubgraphCandidatePool
ExploreNodeEvidence
rankingLinks
nodeScores
callPaths / executionPaths
selected files
rendered source text
heuristic projection edges
```
