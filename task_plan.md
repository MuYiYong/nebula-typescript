# Task Plan: nebula-typescript SDK (对齐 NebulaGraph 5.3)

## 目标
基于 NebulaGraph 5.3 版本的官方 SDK（nebula-java/nebula-go/nebula-python 的 release-5.3 分支）
生成一个 nebula-typescript SDK。注意：5.3 内核未开源，因此协议层需以三个参考 SDK 的
Thrift IDL / 客户端实现为准（它们应该内置或引用相同的 .thrift 定义）。

## 参考仓库
- https://github.com/vesoft-inc/nebula-java/tree/release-5.3
- https://github.com/vesoft-inc/nebula-go/tree/release-5.3
- https://github.com/vesoft-inc/nebula-python/tree/release-5.3

## 阶段
- [ ] Phase 1: 研究阶段 — 分析三个参考 SDK 的：
  - Thrift IDL 定义（common.thrift, graph.thrift, meta.thrift, storage.thrift 等）
  - 连接管理（session, connection pool, 重连机制）
  - 认证 (Authenticate) / execute (execute/executeJson) 接口
  - 数据类型映射 (Value, DataSet, Vertex, Edge, Path 等)
  - 错误码 / ErrorCode 处理
- [ ] Phase 2: 架构设计 — 确定 TS SDK 的模块划分、依赖（thrift transport 库）、目标 Node.js 版本
- [ ] Phase 3: 实现 — 生成 Thrift 代码 / 手写协议层，实现 Session/Pool/Client
- [ ] Phase 4: 测试与文档 — 单测、README、示例代码
- [ ] Phase 5: 打包发布准备（package.json, tsconfig, build）

## 关键决策（修订版 — 见下方"重大发现"）

### ⚠️ 重大发现：协议基础从 Thrift 变为 gRPC + Protobuf
研究三个 release-5.3 分支后确认：**NebulaGraph 5.x（至少 5.0+）已从 Thrift 迁移到 gRPC + Protocol Buffers**。
证据：
- `nebula-go/go.mod`：依赖 `google.golang.org/grpc v1.79.3`、`google.golang.org/protobuf`，无 thrift 依赖
- `nebula-go/proto/nebula/graph.proto`：`service GraphService { rpc Authenticate(...); rpc Execute(...);
  rpc StreamingExecute(...) returns (stream ExecuteResponse) {} }` —— 标准 gRPC service 定义，
  用 `syntax = "proto3"`，注释明确写 "gRPC requires the proto3 syntax"
- `nebula-python/pyproject.toml`：依赖 `grpcio`, `protobuf`, `grpcio-tools`（开发依赖），无 thrift
- `nebula-java/client/pom.xml`：依赖 `io.grpc:grpc-netty-shaded`, `io.grpc:grpc-protobuf`,
  `io.grpc:grpc-stub`, `com.google.protobuf:protobuf-java`，使用 `protobuf-maven-plugin` +
  `protoc-gen-grpc-java` 插件生成代码，无 thrift 依赖
- 三个仓库均有 `proto/` 目录，包含 `common.proto` / `graph.proto` / `vector.proto`，非 `.thrift` 文件

**这推翻了此前"决策 1：用 Thrift 编译器生成 stub"的假设。** 之前的判断依据是 NebulaGraph
历史版本（3.x 及更早）确实用 Thrift，但 5.x 系列已经整体切换为 gRPC。

### 影响链
1. **实现方式（原决策1，需修订）**：应改为用官方 `protoc` + `@grpc/grpc-js` +
   `grpc-tools`（或 `ts-proto` / `protobufjs`）从 `.proto` 生成 TS 类型和 gRPC 客户端 stub，
   在其上封装 ConnectionPool / Session 高层 API。**不再需要任何 Thrift 相关依赖。**
2. **运行环境判断（原决策2，结论不变但理由需修正）**：`@grpc/grpc-js` 是纯 Node.js 实现的
   gRPC（不依赖 grpc 原生扩展），仍然只能跑在 Node.js/服务端环境，浏览器无法直接发起 gRPC-over-HTTP2
   的裸连接（需要 grpc-web 网关转译，且 NebulaGraph 官方 SDK 未提供 grpc-web 支持）。
   结论不变：**Node.js only（服务端）**，dual package (ESM+CJS) 发布。
3. **高并发/性能影响（原决策5，实际是利好）**：gRPC 基于 HTTP/2，原生支持同一物理连接上的
   多路复用（multiplexing），相比 Thrift 裸 TCP 连接每 session 独占一条连接，gRPC 可以让多个
   并发请求共享同一 HTTP/2 connection 的不同 stream，**性能/并发模型比原计划更优**，连接池设计
   要点变为：连接池管理的是 gRPC Channel（可复用），而不是必须一对一绑定的 TCP 连接；
   Session（NebulaGraph 里的会话状态，通过 session_id 传递）仍然是有状态的，同一 session_id
   不能并发两个请求（服务端会拒绝或产生未定义行为），所以池要在 session 粒度做请求串行化/排队，
   而不是在 TCP 连接粒度。
4. **API 风格（原决策3，不变）**：继续参考 nebula-python 的 ConnectionPool + Session 接口
   习惯 + nebula-go 的健康检查/负载均衡策略（`driverPool` 的 `openMinConn`/`clearIdleConn`/
   `getHostIndexLocked` 轮询逻辑）+ nebula-java 的 gRPC stub 调用范式。
5. **范围（原决策4，不变）**：仅 GraphService（`Authenticate` / `Execute` / `StreamingExecute`），
   不做 Meta/Storage。

### 用户确认（第二轮，2026-09-10）
1. proto 文件复用 nebula-go 的 v5.0.0 proto（保留 Apache-2.0 版权声明）——已同意
2. 完整实现（M1+M2 合并一次性做完，包括 Path/Geography/EmbeddingVector/Any 全部类型）——已确认
3. 连接池默认行为：池耗尽时排队等待直到超时（而非 Java 参考的默认立即拒绝），可配置为立即拒绝——已同意
4. 测试环境：真实 NebulaGraph 5.3 实例可用
   - host: 192.168.15.240  port: 39669  user: root  password: <redacted>
   （凡涉及此密码的地方使用环境变量/配置对象传递，不在代码中硬编码、不在文档示例中明文展示真实密码）

Phase 1（研究）与关键决策全部完成，进入 Phase 3（实现）。

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|

## 状态
**全部14个任务已完成**（2026-09-11）。SDK 实现完整，含字节级解码器（NebulaGraph 5.x全部值类型）、
gRPC连接层、连接池、Session/Client高层API、错误码体系。68个自动化测试通过（49单测+19集成测试，
针对真实NebulaGraph 5.3.0实例192.168.15.240:39669验证）。dual ESM+CJS构建产物验证通过。
README/API.md/示例代码完整。详见 progress.md 完整实现时间线。
