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

## 状态
Phase 1 研究完成，进入 Phase 2 架构设计。
