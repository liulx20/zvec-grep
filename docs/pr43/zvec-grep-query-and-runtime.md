# PR #43：查询接口与运行时

本文解释提交 [`64826e8`](https://github.com/zvec-ai/zvec-grep/commit/64826e8196eb53bd44f9a073d03c893333c1e6ac) 中，CLI/MCP/daemon 请求如何进入 service，如何打开 graph read session，以及 neighborhood 与 Explore 的职责差异。

## 1. 对外不是直接调用 SQLite

入口结构是：

```text
CLI ──────────────┐
MCP ──────────────┼─→ ZvecGrep service ─→ workspace read session
daemon HTTP/client┘                         ├─ search index reader
                                           └─ GraphReader
```

CLI 的命令分发在 [`runParsedCommand()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/cli/commands.ts#L76-L940)；MCP 工具在 [`registerZvecGrepTools()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/mcp/tools.ts#L353-L437) 注册。两者最终使用相同 service contract，而不是各自实现查询算法。

## 2. Service Facade 做什么

[`createZvecGrep()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/zvec-grep.ts#L103-L123) 创建服务实例；`ZvecGrepService` 把以下能力放在一个入口：

```text
index              更新 workspace 索引
context/search     普通检索
explore            图驱动的多文件源码 context
graphNeighborhood  symbol 的直接局部图
info               workspace/index 状态
```

Service 负责验证 workspace 状态、参数、embedding 配置和读写锁，然后调用具体引擎。它不是 graph 算法本身。

## 3. Read session 在什么时候打开

普通索引和 graph 有不同 reader。Graph 请求通过 [`openWorkspaceGraphReadSession()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/zvec-grep.ts#L185-L241) 打开：

```text
定位最近的 workspace index
  → 检查 index version/status
  → 打开 graph storage read handle
  → 暴露 explore()/graphNeighborhood()
  → session close 时释放句柄
```

因此源码组装不是 CLI 直接读文件，也不是 SQLite reader 在索引时提前保存一整份输出。请求到来后，Explore 先选文件和 symbol；assembly 阶段才通过 reader/file API 读取当前源码文本。

## 4. Neighborhood 查询

[`queryGraphNeighborhood()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/graph/query.ts#L70-L166) 的目标是忠实展示 focal symbol 附近的图：

```text
symbol query
  → resolve focal seed group
  → 按 direction、edge kind、depth、limit 遍历
  → 汇总 containers、members、incoming、outgoing
  → 可附 source 和 diagnostics
```

它不会做 Explore 的 concept intent、PPR、文件 evidence、MMR 和源码预算分配。它适合“这个函数直接调用谁”“谁继承这个类型”等确定的邻域查看。

## 5. Explore 查询

Service 中 [`exploreOpenWorkspaceIndex()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/zvec-grep.ts#L1160-L1252) 把公开请求转换成 graph Explore 输入，再映射结构化结果。

Explore 解决的是另一类问题：

```text
给定符号或概念 query
  → 找 roots
  → 建有界局部子图
  → 补 call paths、dynamic、impact、change surface
  → 排名并选择少量文件
  → 读取、裁剪和组装源码
```

详细流程从 [Explore 总览](./zvec-grep-explore-overview.md) 开始。

## 6. Daemon 为什么还有一层 Runtime

CLI 可以短进程打开一次服务；daemon 必须长期持有多个 workspace 的状态，同时响应查询、watcher 和重新索引。

[`RootRuntime`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/daemon/root-runtime.ts#L48-L343) 为单个 root 协调：

```text
读请求：search / context / explore / neighborhood
写请求：index / drop / disable
资源：read session cache / embedding model lease
状态：当前 generation、index job、关闭过程
```

`RuntimeManager` 管多个 root runtime；`RootLeaseManager` 管 root 占用；`IndexCoordinator` 和 `JobScheduler` 合并、排序和执行索引工作；`WatchManager` 把文件变化折叠成 change set。

对应实现分别是 [`RuntimeManager`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/daemon/runtime-manager.ts#L35-L295)、[`RootLeaseManager`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/daemon/root-lease.ts#L27-L220)、[`IndexCoordinator`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/daemon/index-coordinator.ts#L22-L81)、[`JobScheduler`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/daemon/job-scheduler.ts#L56-L377) 和 [`WatchManager`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/daemon/watch-manager.ts#L36-L445)。

## 7. 并发时怎样避免半更新读取

索引是写操作，Explore/neighborhood 是读操作。运行时通过 home/root 级协调和 generation-aware read handles，保证查询使用一个一致的已提交索引版本。

大致状态变化是：

```text
generation N 可读
  → 后台构建/提交变更
  → generation N+1 生效
  → 新读请求使用 N+1
  → N 的旧 handle 无引用后释放
```

这不是让一次长查询在中途切换数据库。Read session 把一次请求需要的资源生命周期固定住。

Service 的 home 级读写锁封装见 [`withHomeReadLock()` / `withHomeWriteLock()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/engine/service/zvec-grep.ts#L1433-L1457)；可复用且能安全 retire 的句柄生命周期由 [`ReadHandleCache`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/utils/read-handle-cache.ts#L17-L123) 管理。

## 8. 输出在哪里形成

查询算法返回结构化数据，presentation 再负责 CLI 文本：

- [`formatExploreResult()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/presentation/graph.ts#L29-L199)；
- [`formatNeighborhoodResult()`](https://github.com/zvec-ai/zvec-grep/blob/64826e8196eb53bd44f9a073d03c893333c1e6ac/src/presentation/graph.ts#L206-L697)。

Presentation 可以决定怎么显示 roots、edges、paths 和截断提示，但不应重新选 seed、遍历图或改变文件排名。MCP 则可以保留结构化结果给 agent 使用。

## 9. 三条读取路径不要混在一起

```text
普通 search/context
  使用文本/向量 retrieval，返回相关内容块

graph neighborhood
  使用明确 focal symbol，返回有界邻域

explore
  允许符号或概念 query，选择并组装跨文件源码 context
```

三者共享 workspace/service/runtime 基础设施，但目标不同。Graph 的加入没有删除原来的向量检索，也没有让所有查询都经过 PPR。
