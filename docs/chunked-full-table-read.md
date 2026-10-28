# Sybase ASE 大表分块全量读取：原理、实现规则与实验报告

> 适用对象：需要把 Sybase ASE（本文实测版本 15.7 SP140）中某张表**完整、不重不漏、低负载**地读出来的工程师或 AI agent。
> 典型场景：多个 AWS Lambda（每次最长 15 分钟）分批、多轮、并发读取一张大表。
> 本文所有结论均在真实生产规模的表上做过**只读**实验验证，实验数据见第 6 节。

---

## 0. 一页结论（TL;DR）

1. **按主键（唯一键）区间分块，不要按行号/OFFSET 分页。** 每块用 `where key > 下界 and key <= 上界`，B 树按 key 直接定位，第一块和最后一块一样快。
2. **区间左开右闭、首尾相接；第一块无下界，最后一块无上界。** 这样数学上保证覆盖整个 key 空间，一行不漏、一行不重。
3. **"书签"（块边界）用索引覆盖扫描取得：** `set rowcount N` + `select key ... where key > @lo order by key`，客户端取返回的最后一个 key。
4. ⚠️ **不要用 `select @var = key ... order by key` 取书签**——ASE 会先把整个范围放进工作表排序再截断，大表上等于全表排序（实测 1.4 亿行表直接超时）。
5. **完成与否以状态表（如 DynamoDB）为准，不以消息队列为准**；每块"先写下游、再标记 DONE"；最后用 `count(*)` 核对。
6. 降低负载：索引提示 `(index 索引名 prefetch 16 mru)`、只选需要的列、隔离级别用 `read committed`（**不要用 read uncommitted**，会漏行/重行）、控制并发（3～5 个通常足够）。
7. 读取期间若表有并发写入，只能保证"读到的 key 区间是完整的"，**不能保证时间点一致性**；需配合停写、事后核对或 CDC。

---

## 1. 问题定义

- 目标：把表 `T` 的所有行读出来，写到下游（如 S3）。
- 约束：
  - 多个 worker 并发（例如 20 个 Lambda），每个 worker 单次运行有时间上限（Lambda 15 分钟），需要**多轮**才能读完。
  - 每个 worker 的工作量要尽量**均衡**。
  - **必须读全**：不漏行、不重行（重行可以靠幂等写消除，但不能漏）。
  - **对 Sybase 负载尽量低**，不能影响线上业务。
  - **只读**，不能在源库建表、建触发器、写数据。
  - 记录顺序**无所谓**。
- 已知困难：
  - 主键值"没规律"（不连续、有大量空洞、可能是字符串），无法简单按数值等分出等行数的块。
  - ASE 15.7 **没有** `LIMIT/OFFSET`、`ROW_NUMBER()`、`NTILE()`、快照隔离。

---

## 2. 底层原理

### 2.1 为什么不能用 OFFSET / 行号分页

"跳过前 k 行再取 N 行"在任何数据库里本质上都要先**数过** k 行，代价是 O(k)。读第 7000 块时要先扫过前 1.4 亿行，越往后越慢，总代价是 O(n²)。ASE 15.7 本身也不支持 OFFSET。

### 2.2 键集分页（keyset pagination）：按 key 定位

```sql
where key > @lo and key <= @hi
```

B 树索引的查找是 O(log n)：一张 1.4 亿行的表，B 树只有 3～4 层。**无论 `@lo` 在表头还是表尾，定位代价相同**，之后顺着索引叶子层往后顺序读 N 行。所以每一块的代价只与块大小有关，与块的位置无关（实验 6.3 验证：第一块 166ms，最后一块 218ms，差异来自缓存冷热而非位置）。

### 2.3 为什么"左开右闭、首尾相接"就能保证不漏不重

把书签排成 `b0 < b1 < … < b(m-1)`，块定义为：

| 块              | 条件                           |
| --------------- | ------------------------------ |
| 0               | `key <= b0`                    |
| i (1 ≤ i ≤ m-1) | `key > b(i-1) and key <= b(i)` |
| m（最后一块）   | `key > b(m-1)`                 |

对任意 key 值 x，恰好存在唯一的 i 使 x 落在第 i 块（这是实数轴上的一个划分）。因此：

- **不漏**：每个 key 都属于某一块；
- **不重**：每个 key 只属于一块；
- **第一块无下界、最后一块无上界**：比规划时最小值更小、最大值更大的新插入行也会被覆盖。

前提：**key 唯一**（否则同一 key 的多行可能在边界处被 `rowcount` 截断，见规则 R3），并且**比较全部在 Sybase 内完成**（见规则 R7）。

### 2.4 为什么书签能切出"等行数"的块

书签不是按 key 的**值**等分，而是按**行数**取：从 `@lo` 开始按索引顺序数 N 行，第 N 个 key 就是下一个书签。所以即使 key 分布极不均匀，每块（除最后一块）也**恰好 N 行**。

实验 6.2 中 `MEMB` 表：第 0 块 key 跨度 `000018..358568`，第 3 块只有 `734967..765632`，但每块都正好 20000 行。

### 2.5 为什么取书签很便宜：覆盖索引扫描

`select key from T where key > @lo order by key` 只用到索引列本身，ASE 只扫**索引叶子层**（执行计划里 `scanCoverage = Covered`），不碰数据页。实测每取 20000 个 key 只需约 73 次逻辑读。

### 2.6 聚簇索引 vs 非聚簇索引

| 主键索引类型 | 按 key 区间读数据                                | 风险                                                                                                       |
| ------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 聚簇索引     | 数据本身就按 key 排列，区间读 = 顺序读一段连续页 | 无，最理想                                                                                                 |
| 非聚簇索引   | 每行要通过 RID 回表                              | **若数据物理顺序与 key 无关**，会变成大量随机 I/O，优化器还可能放弃索引改走全表扫描（N 块 = N 次全表扫描） |
| 无索引       | 每块都全表扫描                                   | 不可用此方案                                                                                               |

非聚簇索引能否用，取决于"数据页的物理顺序与 key 顺序是否相关"。判断方法见规则 R10（看每块的逻辑读数是否接近 `块行数 / 每页行数`）。实验 6.3 中 `PRPW` 是非聚簇主键，但 key 是近似递增插入的，20000 行只需 400～700 次逻辑读（平均每页取到 30～50 行），实际表现接近顺序读。

### 2.7 致命陷阱：变量赋值 + `order by` 会触发全量排序

直觉上下面这条 SQL 只返回 1 个值，网络开销最小，很适合取书签：

```sql
-- ❌ 错误写法：大表上会触发全量排序
declare @b numeric(10,0)
set rowcount 20000
select @b = key from T (index PK_T) where key > @lo order by key
set rowcount 0
select @b
```

但实测执行计划是 `Emit → Sort → Restrict`：**ASE 会把 `key > @lo` 范围内的所有行放进工作表排序，然后才应用 rowcount 截断。** 在 18 万行的表上排序很快所以察觉不到；在 1.4 亿行的表上直接超时（实验 6.4）。

正确写法是让 Sybase 原样返回 N 个 key，客户端取最后一个（执行计划只有 `IndexScan`，无 Sort，读满 N 行即停）：

```sql
-- ✅ 正确写法
set rowcount 20000
select key from T (index PK_T prefetch 16 mru) where key > @lo order by key
set rowcount 0
-- 客户端：书签 = 返回结果的最后一个 key；返回行数 < 20000 表示到表尾
```

20000 个 key 的网络传输量通常只有几百 KB，可以忽略。

---

## 3. 实现规则（必须遵守）

| 编号 | 规则                                                                                                                                                                       | 违反后果                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| R1   | 分块键必须是**唯一**索引的键（主键或唯一索引）。不唯一时用"键 + 唯一列"组成复合键，并相应展开比较条件：`a > @a or (a = @a and b > @b)`                                     | 边界上重复 key 的行被跳过或重复                                   |
| R2   | 块条件一律**左开右闭** `key > lo and key <= hi`；**第一块无下界，最后一块无上界**                                                                                          | 漏读表头/表尾，或漏读规划后新插入的行                             |
| R3   | 取书签用"返回 N 个 key、客户端取最后一个"，**禁止** `select @var = key ... order by key`                                                                                   | 大表全量排序、超时、高负载                                        |
| R4   | 取书签的终止条件是**返回行数 < N**，此时**不**把最后一个 key 作为书签，剩余部分归入无上界的最后一块。不能用"变量是否为 NULL"判断                                           | 最后一块被截断或死循环                                            |
| R5   | `set rowcount N` 用完**立即** `set rowcount 0`，并在 `finally` 中再执行一次                                                                                                | 同一连接后续查询被**静默截断**，导致漏数据                        |
| R6   | 数据读取的 SQL 不加 `set rowcount`，只靠区间条件约束                                                                                                                       | —                                                                 |
| R7   | **书签值原样保存、原样传回 SQL**，所有大小比较只在 Sybase 内进行，不在 JS/Python 中比较                                                                                    | 排序规则（sort order、大小写、字符集）不一致导致区间错位          |
| R8   | 参数/字面量的类型必须与列类型一致（如 `univarchar` 列不要传 `varchar`，反之亦然）                                                                                          | 隐式类型转换可能导致**不走索引**                                  |
| R9   | 隔离级别用 `at isolation read committed`（ASE 默认的级别 1），**不要用 read uncommitted（级别 0）**                                                                        | 级别 0 下并发页分裂/行移动时，索引扫描可能**漏行或重行**          |
| R10  | 正式运行前，用 `showplan_in_xml` 验证执行计划（见第 5 节）：取书签必须是 `IndexScan + Covered`，无 `Sort`；读数据必须是 `IndexScan`、`positioning = ByKey`，无 `TableScan` | 方案在该表上不成立却不自知                                        |
| R11  | 主键值不能被业务更新（或确认极少更新）                                                                                                                                     | 行从未读的块"搬"到已读的块，漏读                                  |
| R12  | 每次连接都设置超时（本驱动为 `timeout`/`hardTimeoutMs`）                                                                                                                   | 查询失控时无法止损（实验 6.4 中正是超时机制让失控查询被及时终止） |
| R13  | 每块读完后校验：行数 = 期望值（中间块恰好 N 行），所有 key 都在 `(lo, hi]` 内；不满足则报错重试，**不标记完成**                                                            | 静默漏读                                                          |

---

## 4. 降低 Sybase 负载的手段

| 手段          | 写法                                                                        | 作用                                                                       |
| ------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 强制索引      | `from T (index PK_T ...)`                                                   | 防止优化器在大区间上改选全表扫描                                           |
| 大块 I/O 预读 | `prefetch 16`                                                               | 用大 I/O 顺序预读，减少 I/O 次数（实测服务器自动调整为 32KB，页大小 4K）   |
| MRU 缓存策略  | `mru`                                                                       | 读过的页快速淘汰，**不挤掉业务热数据**——全量导出最容易伤业务的就是冲刷缓存 |
| 只选需要的列  | 列出具体列名                                                                | 减少网络与数据页读取（尤其避免 text/image）                                |
| 大网络包      | 连接参数 `packetSize: 8192/16384`（不超过服务器 `max network packet size`） | 减少网络往返                                                               |
| 合理块大小    | 每块 2 万～50 万行，单块耗时 30 秒～2 分钟为宜                              | 块太小：查询次数多；块太大：失败重读代价大                                 |
| 控制并发      | SQS 事件源 `MaximumConcurrency` 从 3 开始逐步加                             | **并发不减少总读取量，只把读取压缩到更短时间内**，并发越高瞬时负载越高     |
| 低峰执行      | —                                                                           | 减少锁冲突与资源争用                                                       |

完整的数据读取 SQL 模板：

```sql
select col1, col2, ...                       -- 只列需要的列
from T (index PK_T prefetch 16 mru)
where key > @lo and key <= @hi               -- 首块去掉 key > @lo；末块去掉 key <= @hi
order by key                                 -- 走索引顺序，执行计划中无 Sort
at isolation read committed
```

> 关于"负载最低"：如果唯一目标是让 Sybase 负载最低、而不在乎总耗时，**单连接顺序分块读**或 **`bcp out`** 比多 Lambda 并发更好。多 Lambda 并发适合"要尽快读完、且库扛得住"的场景。

---

## 5. 如何验证执行计划（本驱动特别说明）

本项目驱动（drizzle-sybase）的消息处理函数会丢弃 severity ≤ 10 的信息性消息，因此 `set showplan on`、`set statistics io on` 的输出**拿不到**。替代方案是 ASE 15.0.2+ 提供的 `showplan_in_xml()`，它以查询结果的形式返回计划：

```sql
-- 1) 打开（实际执行并记录 I/O）
set plan for show_execio_xml to message on
-- 2) 执行要分析的查询
select ...
-- 3) 取回上一条语句的计划
select showplan_in_xml(-1) as xplan        -- 注意别名不要用 plan（是保留字）
-- 4) 关闭
set plan for show_execio_xml to message off
```

只看计划不执行（用于可能很慢的查询）：

```sql
set plan for show_exec_xml to message on
set noexec on
select ...
set noexec off
select showplan_in_xml(-1) as xplan
set plan for show_exec_xml to message off
```

XML 中要看的字段：

| 字段                            | 期望值               | 说明                                       |
| ------------------------------- | -------------------- | ------------------------------------------ |
| `<scanType>`                    | `IndexScan`          | 出现 `TableScan` 即为全表扫描              |
| `<indName>`                     | 你指定的索引         |                                            |
| `<positioning>`                 | `ByKey`              | 按 key 直接定位；`StartOfTable` 表示从头扫 |
| `<scanCoverage>`                | 取书签时为 `Covered` | 只读索引不碰数据页                         |
| 是否出现 `<Sort>` / `Sort` 节点 | **不应出现**         | 出现即说明有全量排序（陷阱 2.7）           |
| `<act><lio>` / `<pio>`          | 越小越好             | 实际逻辑读 / 物理读次数                    |
| `<indexBufReplStrategy>`        | `MRU`                | 确认 mru 提示生效                          |

其他只读元数据查询（普通用户权限即可）：

```sql
-- 锁模式、行数、数据页数（读系统统计，不扫表）
select lockscheme('T'), row_count(db_id(), object_id('T')), data_pages(db_id(), object_id('T'))

-- 索引列表：是否聚簇、是否唯一、键列
select i.name, i.indid,
       is_clu  = case when i.indid = 1 or (i.status2 & 512) = 512 then 'Y' else 'N' end,
       is_uniq = case when (i.status & 2) = 2 then 'Y' else 'N' end,
       k1 = index_col('T', i.indid, 1), k2 = index_col('T', i.indid, 2)
from sysindexes i
where i.id = object_id('T') and i.indid > 0 and i.indid < 255

-- 服务器排序规则
select name from master..syscharsets
where id = (select value from master..sysconfigures where config = 123)
```

注意事项：

- 表名**区分大小写**（实验中 `memb` 查不到，实际为 `MEMB`）。
- `derived_stat()`（簇比率等）需要表 owner 或 `sa_role` 权限，普通账号无法使用。
- 别名不要用 `rows`、`plan`、`clustered` 等关键字。

---

## 6. 实验记录

实验环境：ASE 15.7 SP140（64-bit Linux），页大小 4KB，排序规则 `bin_iso_1`（二进制）。客户端为本项目驱动，单连接、串行执行，块间休眠 200～500ms。所有实验**只读**，未写任何数据。

### 6.1 实验对象

| 表     | 行数        | 数据页              | 锁模式   | 分块键            | 键索引                                    |
| ------ | ----------- | ------------------- | -------- | ----------------- | ----------------------------------------- |
| `MEMB` | 182,411     | 11,185（≈44MB）     | datarows | `MEMBkey char(6)` | `PK_MEMB`：**唯一聚簇**                   |
| `PRPW` | 140,162,804 | 2,227,305（≈8.5GB） | datarows | `PRPWrrn numeric` | `PK_PRPW`：**唯一非聚簇**（表无聚簇索引） |

`PRPWrrn` 范围 1,501,902 ～ 218,128,255，约 65% 的值实际存在（有大量空洞）。

### 6.2 实验 A：`MEMB` 全表分块读取（验证"读全"）

方法：每块 N = 20000，先取全部书签，再逐块读取（只取 key 列），最后核对。

```
书签（9 个）: 358568, 570259, 734966, 765632, 799179, 834443, 857994, 880628, 901090   取书签共 2.2s

chunk 0: MEMBkey <= '358568'                    -> 20000 行  000018..358568  226ms
chunk 1: > '358568' and <= '570259'             -> 20000 行  358576..570259  128ms
chunk 2: > '570259' and <= '734966'             -> 20000 行  570267..734966   89ms
chunk 3: > '734966' and <= '765632'             -> 20000 行  734967..765632   97ms
chunk 4: > '765632' and <= '799179'             -> 20000 行  765633..799179  123ms
chunk 5: > '799179' and <= '834443'             -> 20000 行  799180..834443  101ms
chunk 6: > '834443' and <= '857994'             -> 20000 行  834446..857994   72ms
chunk 7: > '857994' and <= '880628'             -> 20000 行  857995..880628  146ms
chunk 8: > '880628' and <= '901090'             -> 20000 行  880629..901090  139ms
chunk 9: > '901090'（无上界）                    ->  2411 行  901091..903532   26ms
```

| 校验项                              | 结果              |
| ----------------------------------- | ----------------- |
| 各块行数之和                        | 182,411           |
| 去重后 key 数                       | 182,411（无重复） |
| `count(*)`                          | 182,411（无遗漏） |
| 每块最后一个 key == 书签            | 全部一致          |
| 相邻块首尾无重叠、无间隙            | 通过              |
| 总耗时（取书签 + 全部读取 + count） | 5.5s              |

单块完整读取（1000 行，3 列）的执行计划：`IndexScan PK_MEMB`、`positioning ByKey`、无 Sort、`MRU`，实际 50 次逻辑读、0 次物理读。

> 注：此实验使用的是 2.7 节的"变量赋值"取书签写法，因为表小没有暴露问题。**正式实现必须改用正确写法。**

### 6.3 实验 B：`PRPW` 抽样读取（验证大表性能与位置无关）

方法：在表的不同位置各取一块（N = 20000），书签用正确写法（返回 key 列表），数据读取取**全部 9 列**（等同整行），结果完整传回客户端。耗时为完整往返时间（含 Sybase 执行、网络传输、Node.js 对象化）。

| 位置                                       | 取书签                                         | 读取 20000 行整行数据                                                      |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `> 1501901`（表头）                        | 94ms，Covered，lio 73，pio 0                   | 246ms，lio 384，pio 41                                                     |
| `> 3000000`（表头附近，未缓存）            | 65ms                                           | **166ms**，lio 434，pio 12                                                 |
| `> 110000000`（中部）                      | 41ms，Covered，lio 73，pio 0                   | 191ms，lio 711，pio 92                                                     |
| `> 218000000`（近表尾）                    | 58ms，Covered，lio 73，pio 10                  | 184ms，lio 721，pio 118                                                    |
| **真正的最后一块** `> 218108255`（无上界） | 102ms，**BackwardScan** Covered，lio 74，pio 9 | **218ms**，lio 664，pio 122；范围 `218108256..218128255`，恰好止于表最大值 |

最后一块的书签取法：倒序覆盖扫描取第 N+1 个 key：

```sql
set rowcount 20001
select PRPWrrn from PRPW (index PK_PRPW) order by PRPWrrn desc
set rowcount 0
```

结论：

1. **第一块与最后一块耗时同一量级**（166ms vs 218ms）。差异来自物理读（12 vs 122，即缓存冷热），与位置无关。
2. 取书签只扫索引叶子层，每 20000 个 key ≈ 73 次逻辑读，非常轻。
3. 虽然 `PK_PRPW` 是非聚簇索引，读 20000 行仅需 400～700 次逻辑读（每页约 30～50 行），说明**数据物理顺序与 `PRPWrrn` 高度相关**，回表近似顺序读，方案可用。
4. 行宽约 40 字节，20000 行 ≈ 1MB。行越宽，网络传输占比越大。

### 6.4 实验 C：`PRPW` 上的错误书签写法（反面案例）

```sql
declare @b numeric(10,0), @n int
set rowcount 20000
select @b = PRPWrrn from PRPW (index PK_PRPW prefetch 16 mru) where PRPWrrn > 1501901 order by PRPWrrn
...
```

- 现象：客户端 60 秒超时（`DB-Lib error 20003: TDS server connection timed out`）。
- `noexec` 下取计划：`Emit → Sort → Restrict`——对约 1.4 亿行做工作表排序后才截断。
- 对照：同条件的普通 `select PRPWrrn ... order by PRPWrrn` 计划仅为 `Emit → IndexScan`，无 Sort。
- 善后：超时后驱动断开连接，查询 `master..sysprocesses` 确认服务器上该查询已终止，无残留会话、无阻塞。

### 6.5 全表推算（`PRPW`）

约 7000 块（每块 20000 行），总读取量约 500 万次逻辑读，物理读上限约等于表的 222 万页。

| 并发 | 预计耗时                      | Sybase 负载          |
| ---- | ----------------------------- | -------------------- |
| 1    | 约 25～30 分钟                | 最低                 |
| 3～5 | 约 6～10 分钟                 | 中（推荐起点）       |
| 20   | 理论约 2 分钟，实际受磁盘限制 | 高，不建议用于生产库 |

（推算基于抽样单块耗时，未实际执行全表读取。）

---

## 7. 多 Lambda 分布式架构（推荐实现）

### 7.1 组件

```
Planner（1 个，必要时可续跑）
  ├─ 计算书签 → 生成块清单
  ├─ 写入状态表（DynamoDB）：每块 PENDING
  └─ 投递到 SQS（每条消息 = 一个块）

Worker（SQS 触发，MaximumConcurrency = 3～20）
  ├─ 取块 → 读区间 → 校验 → 写下游（幂等）→ 标记 DONE
  └─ 剩余时间不足时将未处理消息退回队列

Sweeper（EventBridge 定时，如每 15 分钟）
  ├─ 将长时间未 DONE 的块重新投递
  └─ 检查 DLQ

Finalizer
  └─ 所有块 DONE 且行数总和 == count(*) → 宣告完成
```

### 7.2 为什么用"大量小块 + 队列"而不是"固定 20 段"

- **自动均衡**：块多且小，快的 worker 多拿，慢的少拿，总耗时不受最慢一段拖累。
- **天然跨越 15 分钟限制**：单块 1 分钟内完成，块内无需断点续传；Lambda 超时只会让未完成的块回到队列重做。
- **天然重试**：SQS 可见性超时 + DLQ。

### 7.3 两种切块方式

| 方式                   | 做法                                | 优点                                            | 缺点                                                                              |
| ---------------------- | ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| 按行数切（书签）       | Planner 按 2.7 的正确写法逐段扫 key | 每块行数严格相等                                | Planner 要扫一遍索引（`PRPW` 约 7000 次 × 50ms ≈ 6 分钟，可能需续跑或放 Fargate） |
| 按数值等分（仅数值键） | 把 `[min, max]` 等分为数千个区间    | 无需预扫描，min/max 各一次查询（实测 20～30ms） | 各块行数不等（空洞），但块数足够多时由队列自动均衡                                |

两种方式都满足 2.3 的"首尾相接"，都能保证读全。字符串键只能用按行数切。

### 7.4 状态表设计（DynamoDB）

```
PK: jobId#seq
lo, hi           -- 书签原值（字符串保存，原样回传 SQL）；首块 lo = null，末块 hi = null
status           -- PENDING | DONE
expectedRows     -- 按行数切时为 N（末块未知）
rowsWritten
attempts, updatedAt
```

规则：

- Planner **先写状态表、后投递 SQS**。
- Worker **先写下游、后标记 DONE**；下游对象键固定为 `jobId/seq`，重复执行只会覆盖，天然幂等。
- **完成判定只看状态表**：SQS 至少一次投递、DLQ 中的消息等于丢失，不能作为完成依据。

### 7.5 Worker 伪代码

```ts
const BATCH_SAFETY_MS = 120_000;

export const handler = async (event: SQSEvent, ctx: Context) => {
  const failures: { itemIdentifier: string }[] = [];
  const conn = await connect({ timeout: 60, packetSize: 8192 });
  try {
    for (const msg of event.Records) {
      if (ctx.getRemainingTimeInMillis() < BATCH_SAFETY_MS) {
        failures.push({ itemIdentifier: msg.messageId }); // 退回队列
        continue;
      }
      const { jobId, seq, lo, hi, expectedRows } = JSON.parse(msg.body);
      if (await isDone(jobId, seq)) continue; // 幂等

      const conds = [];
      if (lo !== null) conds.push(`key > ${literal(lo)}`);
      if (hi !== null) conds.push(`key <= ${literal(hi)}`);
      const where = conds.length ? `where ${conds.join(" and ")}` : "";

      const { rows } = await conn.query(
        `select col1, col2 from T (index PK_T prefetch 16 mru) ${where}
         order by key at isolation read committed`
      );

      // R13：校验
      if (expectedRows != null && rows.length !== expectedRows)
        throw new Error("row count mismatch");
      if (hi !== null && rows.length && rows.at(-1).key !== hi)
        throw new Error("boundary mismatch");

      await putObject(`${jobId}/${String(seq).padStart(8, "0")}`, rows); // 先写下游
      await markDone(jobId, seq, rows.length); // 再标记
    }
  } finally {
    conn.close();
  }
  return { batchItemFailures: failures };
};
```

`literal()` 必须按列类型生成字面量：数值直接输出，字符串用单引号并把 `'` 转义为 `''`（本项目导出 `escapeString`）。

### 7.6 Planner 伪代码（按行数切）

```ts
const N = 20000;
let lo: string | null = null;
const bounds: string[] = [];
try {
  for (;;) {
    const where = lo === null ? "" : `where key > ${literal(lo)}`;
    const { rows } = await conn.query(
      `set rowcount ${N}
       select key from T (index PK_T prefetch 16 mru) ${where} order by key
       set rowcount 0`
    );
    if (rows.length < N) break; // R4：不足 N 行 → 剩余归入无上界末块
    lo = rows.at(-1).key;
    bounds.push(lo);
    // 可在此处持久化 lo，实现 Planner 自身的断点续跑
  }
} finally {
  await conn.query("set rowcount 0"); // R5
}
// 块：[null, b0], (b0, b1], ..., (b(m-1), null)
```

---

## 8. 一致性边界（必须向使用方说明）

ASE 15.7 没有快照隔离，读取期间若表有写入：

| 并发事件                          | 结果                    | 应对                                                      |
| --------------------------------- | ----------------------- | --------------------------------------------------------- |
| 新插入的 key **大于**最后一个书签 | 被末块读到（无上界）    | 无需处理                                                  |
| 新插入的 key 落在**尚未读**的块   | 被读到                  | 无需处理                                                  |
| 新插入的 key 落在**已读完**的块   | **漏读**                | 事后逐块 `count(*)` 对比，不一致的块重读；或停写/低峰执行 |
| 行被删除                          | 导出结果多一行          | CDC 或目标端对账                                          |
| 主键被更新                        | 可能漏读或重读          | 确认业务不更新主键（R11）                                 |
| 插入与删除数量恰好抵消            | `count(*)` 核对无法发现 | 严格场景需比对 key 集合、停写或 CDC                       |

**结论：本方案保证"key 空间被完整覆盖、每块读取正确"。若要求某一时间点的完整快照，必须在无写入时执行，或配合 CDC。**

---

## 9. 上线前检查清单

- [ ] 分块键唯一（R1），且业务不更新它（R11）
- [ ] 用 `sysindexes` 确认键索引存在，记录是否聚簇
- [ ] 用 `showplan_in_xml` 验证：取书签 = `IndexScan` + `Covered` + 无 Sort；读数据 = `IndexScan` + `ByKey` + 无 TableScan（R10）
- [ ] 抽样表头、表中、表尾各一块，确认每块逻辑读 ≈ `行数 / 每页行数` 量级（非聚簇索引尤其重要）
- [ ] 取书签未使用 `select @var = ... order by`（R3）
- [ ] 所有 `set rowcount` 都在 `finally` 中复位（R5）
- [ ] 首块无下界、末块无上界（R2）
- [ ] 隔离级别为 read committed（R9）
- [ ] 连接设置了超时（R12）
- [ ] Worker 有行数/边界校验（R13）
- [ ] 完成判定基于状态表 + `count(*)` 核对
- [ ] 并发从小开始，观察 Sybase 负载后再调高
