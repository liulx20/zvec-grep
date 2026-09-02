# Zvec-Grep 图关系抽取与解析

本文基于提交 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac)，说明源码怎样变成 SQLite 中的 `symbols`、`contains`、`edges`、`unresolved_refs` 和 `edge_candidates`。

## 1. 完整流程

```text
源码
  → analyzeForIndexing()：语言分析
  → EntityFragments + imports/calls/refs/inheritance/ownership
  → extractFileGraph()：构建文件级图输入
  → nodes + CONTAINS + local edges + raw refs
  → SqliteGraphWriter：写 files/symbols/contains/edges/unresolved_refs
  → SqlitePendingRefResolver：跨文件解析 pending refs
  → resolved edges 或 dynamic edge_candidates
  → SqliteCounterpartProjector：补 declaration/definition COUNTERPART
```

关键入口是 [`extractFileGraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/extract-file-graph.ts#L25-L222)。

## 2. Phase A：从 Fragment 构造 Symbols

这一阶段先由 `analyzeForIndexing(source)` 调用对应语言分析器。C/C++、TS/JS、Python、Rust、Java 分别识别自己的 import、call、inheritance、receiver 和 ownership 语法，但统一输出 `imports/calls/refs/inheritance/ownership/sourceLanguage`。入口见 [`extractFileGraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/extract-file-graph.ts#L25-L53)。

`fileGraphFromFragments()` 再把语言结果归一化成 `SymNode/LocalEdge/RawRef/Ownership`。`kind` 保存跨语言统一语义，`node_type`、`source_language`、modifiers 和 resolution hints 保留语言细节。

[`fileGraphFromFragments()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/from-fragments.ts#L34-L186) 将公开 EntityFragment 转为 `SymNode`。

```text
fragment.metadata.symbolName  → symbols.name
scope + name                  → symbols.qualified_name
fragment.metadata.symbolType  → symbols.kind
signature                     → signature / arity / return_type
fragment.range                → range_json
nodeType / modifiers          → node_type / modifiers_json
```

特殊归一化包括：

```text
abstract class    → kind=abstract_class
abstract function → kind=abstract_method
普通 callable     → kind=function
字段/变量/常量    → kind=value
```

`qualified_name` 的目标是跨文件表达语言级 identity，例如：

```text
CheckoutService::placeOrder
payments.StripeGateway.charge
```

## 3. Ownership：生成 `contains`

语言分析产生 parent/child source offsets，`fileGraphFromFragments()` 将 offset 对应回 symbol IDs，形成：

```text
class → method
namespace → class
module → nested symbol
```

文件级输入里它暂时表现为 `LocalEdge(kind="CONTAINS")`；SQLite writer 最终将其写入独立的 `contains` 表，而不是 persisted `edges` 表。

## 4. 文件内可以直接确定的关系

[`extractFileGraph()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/extract-file-graph.ts#L107-L222) 为当前文件建立：

```text
name → local symbol IDs
source offset → symbol ID
child → container
container → constructors
```

然后分别处理：

```text
analysis.inheritance → INHERITS
analysis.refs        → REFS
analysis.calls       → CALLS
analysis.imports     → import RawRef
```

如果引用能在当前文件唯一定位，就直接产生 local edge。例如函数 `submit()` 中调用本文件的 `validate()`：

```text
submit ──CALLS(rel=call)──> validate
```

如果不能安全唯一定位，则保留为 RawRef，交给跨文件 resolver，而不是按同名随便连边。

## 5. RawRef：尚未解析的关系

[`rawRef()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/from-fragments.ts#L207-L286) 创建稳定引用 ID，并保留 owner、名称、类型、行号与 receiver hints。

常见 `ref_kind`：

```text
call        函数/方法调用
new         实例化
import      模块或符号导入
extends     继承
implements  实现接口
overrides   覆写方法
type        类型引用
function    函数值/函数引用
value       字段、变量、常量引用
```

RawRef 写入 SQLite 后成为 `unresolved_refs(status='pending')`。

外部包和标准库 import 会先经过 import policy；明确为 external 且不是配置的项目 import 时，不会作为普通项目内 import 候选扩散。

## 6. Ref Kind 怎样变成 Edge Kind

基础映射由 resolver 完成：

```text
call                         → CALLS
extends / implements / overrides → INHERITS
new                          → INSTANTIATES（语义 resolver 投影）
import                       → IMPORTS
其他 type/function/value ref → REFS
```

简单解析入口 [`resolveRef()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/resolve.ts#L23-L145) 根据 ref kind 限制允许的 symbol kind，并优先当前文件、preferred file、container scope 或 workspace unique target。

## 7. Pending Reference Resolver

这一层仍然是语言感知的：import 路径、qualified name、receiver 类型、字段声明、type alias、generic bound、trait/interface hierarchy、method visibility 和 constructor 规则会按 `source_language` 处理。比如 C/C++ 需要处理 pointer receiver 和 template，Rust 需要处理 trait/impl 与 inline module，TS/JS 需要处理 named/default import、re-export 和 type alias。

跨文件、receiver 成员和多态关系由 [`SqlitePendingRefResolver`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/pending-ref-resolver.ts#L86-L1949) 处理。

它按阶段解析：

```text
imports
  → inheritance
  → instantiations
  → calls / values / types 等其余引用
```

阶段条件见 [`resolvePhaseCondition()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/pending-ref-resolver.ts#L1950-L1962)。这样 import 和 hierarchy 先建立，后续 receiver/call resolution 才能利用它们。

Resolver 使用的上下文包括：

```text
短名称和 qualified name
当前文件与 import closure
container scope
symbol kind / signature / arity
receiver type 与字段声明
type aliases
INHERITS hierarchy
generic bounds
constructors / INSTANTIATES
method set 与可见性
function pointer registrations
```

## 8. 四种解析结果

```text
唯一目标
  → 写入 edges
  → 删除已 resolved 的 unresolved_ref

外部目标
  → status=external

没有可用目标
  → status=failed，可按策略重试

多个合理运行时候选
  → status=dynamic
  → 写 edge_candidates
```

`SqliteProjectionBuffer` 将 edge、dynamic ref、candidate 和状态变更原子 flush，见 [`projection-buffer.ts`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/projection-buffer.ts#L43-L158)。

## 9. Dynamic Candidate

当 `payment_->charge()` 的静态 receiver 是接口或无法唯一确定时，可以留下：

```text
unresolved_refs
  owner = placeOrder
  ref_kind = call
  member_name = charge
  status = dynamic

edge_candidates
  StripeGateway::charge  reason=hierarchy
  MockGateway::charge    reason=method_set
```

Candidate reason 可能是：

```text
hierarchy
generic_bound
method_set
function_pointer
namespace_export
```

每个 candidate 有独立 confidence。这里没有产生多条“确定 CALLS”；Explore 后续可以保留 boundary，并在某次 query 中生成带 `provenance=heuristic` 的临时 projection。

## 10. Confidence 与 Provenance

```text
provenance=static
  静态解析能够确定关系

provenance=heuristic
  由上下文或投影规则推导
```

`confidence` 是对具体 `src → dst` 或 candidate target 的可信度，不是 query relevance。静态唯一解析通常为 `1.0`；receiver inference、fallback 和动态候选通常更低。

这些值由 resolver/projector 写入数据库。Explore 只读取它，用于候选过滤、evidence strength 或 PPR 边权。

## 11. COUNTERPART Projection

[`SqliteCounterpartProjector`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/counterpart-projector.ts#L26-L176) 为 C/C++ header/source 中的 declaration/definition 建立 `COUNTERPART`。

匹配要求主要包括：

```text
header/source 文件角色兼容
qualified_name 相同
symbol name 和 kind 相同
arity 不冲突
路径 domain 兼容
直接 import 或同 stem/相关路径
```

当前投影示例：

```text
直接 import 支持       confidence=0.98, evidence=direct_import
声明/定义路径身份支持  confidence=0.95, evidence=declaration_definition
```

COUNTERPART 是 query-independent 的持久化边；它和 Explore seed 阶段的 semantic grouping 是两套机制。

## 12. 最终写入哪些表

[`SqliteGraphWriter`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/persistence/sqlite/writer.ts#L39-L204) 最终维护：

```text
files             文件元数据
symbols           抽取出的实体
contains          ownership
edges             已解析关系
unresolved_refs   尚未唯一解析的引用
edge_candidates   dynamic reference 的候选目标
```

具体字段见 [SQLite Graph Schema](./zvec-grep-graph-data-model.md)。

## 13. 最简心智模型

多语言职责沿主线分布：extractor 理解语言语法，graph normalization 统一节点和关系，pending resolver 使用语言规则解析跨文件引用；Explore 主要消费统一图，不重新解析源码语言。

```text
Extractor 负责“源码里出现了哪些 symbol 和 reference site”
Local resolver 负责“本文件内能否直接连边”
Pending resolver 负责“跨文件、receiver、hierarchy 和动态候选”
Counterpart projector 负责“声明与定义对应关系”
SQLite schema 负责“把最终事实和未决状态持久化”
```
