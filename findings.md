# Findings — nebula-typescript SDK 研究阶段汇总

## 核心结论
NebulaGraph 5.3（Java/Go/Python 三个官方 SDK release-5.3 分支验证一致）：
- 传输协议：**gRPC (proto3) + Protocol Buffers**，非 Thrift。
- 服务定义 `GraphService`：`Authenticate` / `Execute` / `StreamingExecute`（后者三个 SDK 均未在客户端调用，服务端预留）。
- 结果集不是行式强类型 Value，而是**列式二进制 `VectorResultTable`**（`NestedVector` 嵌套结构），
  三个 SDK 都是**手写字节级解码**，不依赖 protobuf message 直接反序列化出业务值。
- 三者共享同一套 wire 布局（v5.0.0 proto），Go 报告中的字节偏移/位运算公式已抽查源码验证一致（
  `internal/decode/utils.go` 确认 `order = binary.LittleEndian`，`columnType.go` 的递归类型解析逻辑吻合）。

详细报告见（供实现阶段查阅，不纳入最终代码库）：
- /tmp/nebula-sdk-research/findings-go.md（758 行，最详尽，含完整字节布局公式）
- /tmp/nebula-sdk-research/findings-python.md（379 行，含大量"文档与实现不一致"提示）
- /tmp/nebula-sdk-research/findings-java.md（361 行，含 commons-pool2 池化细节与优缺点分析）

## 关键技术决策依据（供后续实现对照）

### Proto 文件结构（三仓库一致）
- `common.proto`：Value（33 种 oneof）、Node/Edge/Path/Duration/Date/Time/Decimal/Geography 等消息定义，
  ClientInfo.Language 枚举（UNKNOWN=0,CPP=1,GO=2,JAVA=3,PYTHON=4,JAVASCRIPT=5 —— TS 用 5）
- `graph.proto`：GraphService + AuthRequest/AuthResponse/ExecuteRequest/ExecuteResponse/Summary
- `vector.proto`：VectorResultTable/VectorBatch/NestedVector/RowType/PropertyGraphSchema

### 认证
- `AuthRequest{ username(bytes), auth_info(bytes)=JSON序列化的{"password":...}, client_info }`
- 成功状态码固定字符串 `"00000"`；`protocol_version="5.0.0"`
- 响应：`session_id(int64)`, `version(bytes)`

### Session/并发模型（三 SDK 一致，是设计核心约束）
- 一个连接 = 一个已认证 session（session_id），**同一 session 不能并发执行请求**
- Go/Java 用 mutex/synchronized 在连接对象上串行化；Python 同步版用 threading.Lock，异步版用 asyncio.Lock
- 并发靠"多个连接/session"实现，不是单 session 内并发
- 连接池管理的是"已初始化好 session 的连接对象"整体（不是裸 channel 池 + session 池分离）

### 连接池设计参考点（融合 Go 健壮性 + Python/Java API 习惯）
- Go（最健壮）：LIFO 空闲栈、请求排队 channel、后台 ticker 定期清理空闲/补最小连接、
  round-robin 建连、Ping 健康检查失败自动剔除重取、maxOpen/minOpen/maxIdle/maxLifetime/maxWait 全套参数
- Java：commons-pool2，testOnBorrow、healthCheckTime 后台 testWhileIdle、maxLifeTime、
  **blockWhenExhausted 默认 false（耗尽直接抛错，反直觉，TS 实现应考虑更友好默认值或至少显式文档说明）**
- Python：get_client()/return_client() 命名（不是 getSession），min/max_client_size，
  忙等待實現（性能较差，TS 应用真正的 Promise 队列而非忙等）

### gRPC 连接选项（三者高度一致，TS 应对齐）
- 消息大小：不限制（Go: MaxInt64, Python/Java: -1 / Integer.MAX_VALUE）——
  **但需注意 Java 报告指出这是潜在 OOM 风险，TS 实现可考虑给出合理默认上限 + 可配置**（属于比官方 SDK 更稳健的改进点，非必须但建议）
- 均未配置 keepalive —— TS 保持简单对齐，可选支持配置但默认不开启
- TLS 最低 TLS1.2

### VectorResultTable 解码（重点难点，实现顺序建议）
1. 基础定长类型（bool/int8~64/uint8~64/float32/64/date/time/datetime/duration，位打包公式见 findings-go.md 5.7 节）
2. String/Decimal（16B header: length+prefix+chunkOffset+chunkIndex，≤12字节内联）
3. Embedding Vector（纯 float32 数组）、Geography（Point/LineString/Polygon）
4. List/Set/Map/Record（依赖 nested_vectors + offset/size header）
5. Node/Edge（16B/32B header + special_meta_data 属性名→向量下标映射）
6. Path（最复杂：pair机制 + adjHeader 64位位解析遍历）
7. Any 类型（独立的自描述递归 TLV 格式，比列式简单，可提前实现）
- null_bit_map：bit=1非空，LSB优先，逐字节8行
- 全部小端序（is_little_endian字段存在但三SDK默认按小端处理）
- vector_content_type：低8位=vectorType(1Const/2Flat/3Parallel)，第9位=nullAllSet

### 错误码体系
- 客户端错误：自定义枚举（Go: 99000-99011 地址/连接/超时/TLS/解码失败等）
- 服务端错误：GQLSTATUS风格5字符码字符串，成功="00000"，数百个业务码（语法/语义/session/raft等）
- 建议：TS 定义 ClientErrorCode enum + 移植 ServerErrorCode 表（可从 Go pkg/errors/error.go 或
  Python _error_code.py 提取，两者应完全一致，做交叉校验后确定最终表）

### 关于三个参考 SDK 的注意事项（避免 TS 重复其缺陷）
- Python 文档与实现严重不一致（很多文档 API 在源码中不存在），TS 设计/文档需保证一致性并配自动化测试防止漂移
- Python 忙等待式 get_client()，Node.js 应用基于 Promise/事件的真正异步等待队列（这也是 Node 的天然优势）
- Java blockWhenExhausted 默认 false 令人意外，TS 应选择更符合直觉的默认（例如默认等待，超时后拒绝），并在文档明确说明
- 三者均未做自动重试（即使 isRetryable() 已分类），TS 可考虑作为增值特性（但非本次范围强制项，先对齐功能，重试作为可选增强）

## 状态（研究阶段）
Phase 1 研究完成，进入 Phase 2 架构设计。SDK 实现已在此后完成并发布（见 task_plan.md / progress.md）。

---

# 安全与性能审查结论（2026-09-11）

## 方法
两个子代理并行审查（安全面 + 性能面），随后逐项亲自读代码核实，只修复验证为真实存在的问题。

## 确认为真实问题（将修复）

### 安全
1. **[中] anyValue.ts List/Set 解码的 null bitmap 分配放大攻击面**
   - 位置：src/decode/anyValue.ts `readNullBitmapFlags()` + List/Set 分支
   - 问题：`size` 来自服务器（List: uint16 最大65535；Set: uint32 最大~42亿），`bitSize=ceil(size/8)`
     用于 `r.readN(bitSize)`（有边界检查），但检查通过后才做 `boolean[size]` 数组分配+循环。
     由于 gRPC 接收消息大小设置为 -1（无限制），恶意/异常服务器发送约536MB真实字节即可让
     bitSize校验通过，进而触发42亿次数组push——在真正开始读元素数据前就可能OOM或长时间阻塞。
   - 验证：亲自读代码确认 readN 在数组分配*之前*调用，且顺序验证了 Set 的 size 是 uint32（不是 List 的 uint16），
     放大倍数确实存在（536MB输入 -> 试图分配42亿元素数组）
   - 修复方案：在分配数组前加合理性检查（size 与 r.remaining() 的比例关系），避免用声明的巨大 size
     驱动内存分配

2. **[中] 默认传输未加密时明文发送密码，缺少显式警告**
   - 位置：src/connection/connection.ts buildChannelCredentials() 默认走 grpc.credentials.createInsecure()
   - 验证：确认无 tls 配置时确实走明文通道，且 README/API.md 均未显式提示这一点
   - 修复方案：README 增加安全提示；代码层不强制拦截（保持与参考SDK行为一致和向后兼容），
     但要让用户知情

### 性能 / 正确性
3. **[高，正确性bug] ExecutionResult.rowSize() 会消费迭代器游标**
   - 位置：src/connection/connection.ts ResultTableAdapter.rowSize()
   - 问题：`for (const _ of this.table) count++` 会推进 ResultTable 内部的 batchIndex/currentBatchRowIndex，
     调用 rowSize() 后再调用 next()/迭代会拿不到完整数据（表已被"消费"）
   - 验证：读 resultTable.ts 确认 RowBatch.numRecords() 已存在且是 O(1)（读 commonMetaData.numRecords），
     ResultTable 可以直接提供不消费游标的求和方法，但当前没有暴露
   - 修复方案：ResultTable 增加 rowCountHint()方法（对 batches 的 numRecords() 求和，不推进游标），
     ResultTableAdapter.rowSize() 改用它

4. **[中] connectionPool.ts release() 每次 O(n) 扫描 + 数组分配**
   - 位置：src/pool/connectionPool.ts release() `Array.from(this.allConnections).find(...)`
   - 验证：确认 allConnections 是 Set<PooledConnection>，release 每次转数组再线性查找
   - 修复方案：改用 Map<Connection, PooledConnection>，release 变 O(1)

5. **[中] Node/Edge 解码每行重建 propSchemas Map**
   - 位置：src/decode/values.ts decodeElementValue() 内的 propSchemaLookup 闭包 +
     src/decode/compositeValue.ts decodeNodeFlatValue/decodeEdgeFlatValue
   - 验证：确认 propSchemaLookup 每次调用都 new Map() 并全量拷贝 props，而这个结果对
     同一 (graphId, elementTypeId) 是不变的，且该函数每行调用一次
   - 修复方案：改变 propSchemaLookup 的返回类型为原始的 ReadonlyMap<string, PropSchema>
     （已存在于 typeSchema 中，无需拷贝），调用侧改为 `.get(name)?.schema`，完全消除每行的 Map 拷贝

6. **[低] ZonedTime/ZonedDatetime 每值构造 Date 对象，即使 offset=0**
   - 位置：src/decode/basicValue.ts applyOffsetUtc()
   - 验证：确认无条件构造 new Date()，即使 offsetSec===0（UTC，无需偏移）
   - 修复方案：offsetSec===0 时直接返回原始字段，跳过 Date 构造

## 修复实施记录（2026-09-11）

全部6项已修复，详见各自 commit。npm audit 补充说明：devDependency 保守升级
（tsup 8.3.5→8.5.1, vitest 2.1.8→2.1.9，均为非破坏性 patch/minor 版本），修复了 8 个中的 1 个。
剩余 7 个需要 vitest 大版本跳到 5.0.0（breaking change）才能修复，鉴于：
(a) 全部在 devDependencies，`npm audit --omit=dev` 确认发布产物 0 漏洞；
(b) 剩余的漏洞利用场景是"本机同时跑 Vitest dev server + 访问恶意网站"，与本 SDK 实际
使用场景（CI/Node服务端）无关；
(c) 发版前不宜为此引入测试框架大版本升级的兼容性风险；
故不做进一步升级，作为已知、可接受的风险记录在案。
- enqueue() 的 Promise 链：两份报告都承认这不是经典内存泄漏（只持有最新一节引用，V8 正常GC），
  微任务开销可忽略，改造成本大于收益，不修
- geography.ts 的 numCoords/loops 循环：每次迭代都单独走 readFloat64LE()->readN(8)（有边界检查），
  代价与实际收到字节数成正比，不存在"声明超大数字空转"的放大效应，风险远低于 anyValue.ts 的情况，不修
- npm audit 的8个漏洞：全部在devDependencies（vitest/vite/esbuild/tsup链），`npm audit --omit=dev`
  验证为0（已用真实命令确认），不影响发布产物；仍会顺手 `npm audit fix` 升级（低风险、非破坏性）
- BASIC_TYPE_SIZE用Map.get查表 / bytesReader每次读取都subarray：确实有微小开销，但影响远小于
  上述已列问题，且改动面较大（涉及多处签名），本轮不做，记录为未来优化候选
- connectionPool.acquire()的for(;;)循环无重试上限：真实存在但影响面是可用性而非安全崩溃，
  且已有pingTimeout做超时保护，非本轮阻塞项，记录为未来改进候选
