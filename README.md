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

```text
easytier-worker/
├── protos/                 # Protocol Buffers 定义
├── src/
│   ├── worker/             # Worker 实现
│   │   ├── core/           # Worker 核心功能
│   │   └── relay_room.js   # 中继房间实现
│   └── worker.js           # Worker 入口文件
├── package.json            # 项目配置
├── wrangler.toml           # Cloudflare Workers 配置
└── README.md               # 项目说明
```

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
