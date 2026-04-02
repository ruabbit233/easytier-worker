# easytier-worker

## 项目简介

`easytier-worker` 是基于 `IceSoulHanxi/easytier-ws-relay` 分叉出来的 EasyTier WebSocket Relay。

它保留了原项目基于 Cloudflare Workers + Durable Objects 的实现方式，同时把项目名、部署配置和基础运维入口整理成了更适合长期继续优化的形态。

当前这个 fork 的初始目标是：

- 保持和 `easytier-ws-relay` 的兼容思路
- 方便继续增加连接稳定性、可观测性和管理能力

> **注意：本项目仅供学习交流使用**

## 技术架构

- 基于 Cloudflare Workers 和 Durable Objects
- 使用 WebSocket 协议进行实时通信
- 采用 Protocol Buffers 进行高效序列化
- 支持消息加密与完整性保护
- 模块化设计，便于扩展和维护

## 开发环境搭建

### 前置要求

- Node.js (>= 16.0.0)
- pnpm (推荐) 或 npm
- Wrangler CLI (Cloudflare Workers 工具链)

### 安装步骤

1. 克隆项目仓库：
```bash
git clone <your-repo-url>
cd easytier-worker
```

2. 安装依赖：
```bash
pnpm install
# 或者使用 npm
npm install
```

3. 安装 Wrangler CLI：
```bash
npm install -g wrangler
```

4. 登录 Cloudflare：
```bash
wrangler login
```

## 本地开发

### 启动开发服务器

```bash
pnpm run dev
# 或者
wrangler dev --ip 0.0.0.0
```

### 直接启动（不监听文件变化）

```bash
pnpm run start
# 或者
wrangler dev
```

## 部署到 Cloudflare

### 部署命令

```bash
wrangler deploy
```

### 配置说明

项目使用 `wrangler.toml` 文件进行配置，主要配置项包括：

- `name`: Worker 名称
- `main`: 入口文件路径
- `compatibility_date`: 兼容性日期
- Durable Objects 配置
- 环境变量配置

## 项目结构

下面按“目录 + 文件职责”展开说明，便于快速定位问题和理解数据流。

```text
easytier-worker/
├── protos/
│   ├── common.proto                    # 公共消息结构、RPC 包装体、压缩信息等基础协议定义
│   ├── error.proto                     # RPC 错误类型定义
│   ├── peer_rpc.proto                  # EasyTier 相关 RPC、握手包、路由同步协议定义
│   └── google/protobuf/timestamp.proto # protobuf 时间戳依赖
├── src/
│   ├── worker.js                       # Cloudflare Worker 入口；处理 HTTP 路由并把 WebSocket 请求分发到 Durable Object
│   └── worker/
│       ├── relay_room.js               # Durable Object 房间实例；管理单个 room 内的 WebSocket 会话、消息分发和心跳
│       └── core/
│           ├── basic_handlers.js       # 握手、Ping/Pong、普通包转发等基础协议处理
│           ├── compress.js             # RPC 负载压缩与解压的兼容封装
│           ├── constants.js            # 协议常量、包类型枚举、包头长度等基础常量
│           ├── crypto.js               # 摘要、密钥派生、AES-GCM 加解密、封包辅助方法
│           ├── packet.js               # EasyTier 自定义包头的解析与构造
│           ├── peer_manager.js         # 房间内 Peer 状态中心；维护连接、路由会话、PeerInfo 和路由广播
│           ├── protos.js               # protobuf 类型装载入口；统一暴露运行时要用到的消息类型
│           ├── protos_generated.js     # 由 `.proto` 自动生成的 JS 类型文件，一般不直接手改
│           └── rpc_handler.js          # RPC 请求/响应处理；负责 PeerCenter 与路由同步等核心逻辑
├── package.json                        # Node 依赖、脚本命令、项目元信息
├── package-lock.json                   # npm 依赖锁定文件
├── wrangler.toml                       # Cloudflare Worker / Durable Object 部署配置与环境变量
├── LICENSE                             # MIT 许可证
└── README.md                           # 项目说明与使用文档
```

### 代码主链路

1. 客户端访问 `src/worker.js` 暴露的 `WS_PATH`，Worker 根据 `room` 参数定位对应的 `RelayRoom`。
2. `src/worker/relay_room.js` 接管 WebSocket 生命周期，解析包头并按包类型分发。
3. 握手、心跳、普通转发由 `core/basic_handlers.js` 处理，RPC 类消息由 `core/rpc_handler.js` 处理。
4. `core/peer_manager.js` 维护当前房间的 Peer 列表、路由会话和广播状态。
5. 协议编解码依赖 `protos/*.proto` 与生成出的 `core/protos_generated.js`。

## 功能特性

- WebSocket 双向通信中继
- 基于 Room 的连接管理
- 使用 Protobuf 进行高效序列化
- 消息加密与完整性保护
- RPC 请求/响应处理机制
- `/healthz` 与 `/info` 基础信息接口
- 可配置的心跳间隔与连接超时

## 可配置项

在 `wrangler.toml` 的 `[vars]` 中配置：

- `WS_PATH`: WebSocket 路径，默认 `ws`
- `EASYTIER_DISABLE_RELAY`: `"1"` 开启纯 P2P，默认 `"0"`
- `EASYTIER_COMPRESS_RPC`: `"0"` 关闭 RPC 压缩（调试用），默认 `"1"`
- `LOCATION_HINT`: Durable Object 地区提示，默认 `apac`
- `EASYTIER_HEARTBEAT_INTERVAL`: 心跳发送间隔，默认 `25000`
- `EASYTIER_CONNECTION_TIMEOUT`: 连接超时阈值，默认 `60000`

修改完配置后按正常方式运行 `wrangler dev` 或部署即可生效。

## 客户端连接说明

部署后，EasyTier 客户端连接地址需要添加路径 `/ws`，实际路径由 `WS_PATH` 控制。

easytier 中端口号使用 `0` 表示使用协议默认端口，`ws` 对应 `80`，`wss` 对应 `443`。

开发模式：
```text
ws://your-network-ip:0/ws
```

部署后：
```text
wss://your-deployment.workers.dev:0/ws
```

## 许可证

[MIT License](./LICENSE)

## 免责声明

本项目仅供学习交流使用，请勿用于任何商业用途或非法用途。使用本项目代码造成的任何后果，原作者概不负责。
