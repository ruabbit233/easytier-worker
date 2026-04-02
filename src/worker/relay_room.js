import { Buffer } from 'buffer';
import { parseHeader, createHeader } from './core/packet.js';
import { PacketType, HEADER_SIZE, MY_PEER_ID } from './core/constants.js';
import { loadProtos } from './core/protos.js';
import { handleHandshake, handlePing, handleForwarding } from './core/basic_handlers.js';
import { handleRpcReq, handleRpcResp } from './core/rpc_handler.js';
import { getPeerManager } from './core/peer_manager.js';
import { randomU64String } from './core/crypto.js';

const WS_OPEN = (typeof WebSocket !== 'undefined' && WebSocket.OPEN) ? WebSocket.OPEN : 1;

// 每个 RelayRoom 对应一个 Durable Object 实例，负责单个 room 内的连接和转发。
function resolveWsPath(env) {
  const rawPath = String(env.WS_PATH || 'ws').trim();
  const normalized = rawPath.replace(/^\/+|\/+$/g, '');
  return `/${normalized || 'ws'}`;
}

export class RelayRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.types = loadProtos();
    this.peerManager = getPeerManager();
    this.peerManager.setTypes(this.types);

    // Durable Object 从休眠恢复后，把已有 socket 的附加元数据重新挂回内存。
    this.state.getWebSockets().forEach((ws) => this._restoreSocket(ws));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const wsPath = resolveWsPath(this.env);
    if (url.pathname !== wsPath) {
      return new Response('Not found', { status: 404 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    const client = pair[0];
    await this.handleSession(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(webSocket) {
    this.state.acceptWebSocket(webSocket);
    this._initSocket(webSocket);
  }

  async webSocketMessage(ws, message) {
    try {
      let buffer = null;
      if (message instanceof ArrayBuffer) {
        buffer = Buffer.from(message);
      } else if (message instanceof Uint8Array) {
        buffer = Buffer.from(message);
      } else if (ArrayBuffer.isView(message) && message.buffer) {
        buffer = Buffer.from(message.buffer);
      } else {
        console.warn('[ws] unsupported message type', typeof message);
        return;
      }
      console.log(`[ws] recv len=${buffer.length}`);
      ws.lastSeen = Date.now();
      const header = parseHeader(buffer);
      if (!header) {
        console.error('[ws] parseHeader failed, raw hex=', buffer.toString('hex'));
        return;
      }
      console.log(`[ws] header from=${header.fromPeerId} to=${header.toPeerId} type=${header.packetType} len=${header.len}`);
      const payload = buffer.subarray(HEADER_SIZE);
      switch (header.packetType) {
        case PacketType.HandShake:
          console.log(`[ws] -> handleHandshake payload hex=${payload.toString('hex')}`);
          handleHandshake(ws, header, payload, this.types);
          break;
        case PacketType.Ping:
          handlePing(ws, header, payload);
          break;
        case PacketType.Pong:
          this._handlePong(ws);
          break;
        case PacketType.RpcReq:
          if (header.toPeerId !== PacketType.Invalid && header.toPeerId !== undefined && header.toPeerId !== null && header.toPeerId !== 0 && header.toPeerId !== PacketType.Invalid && header.toPeerId !== undefined && header.toPeerId !== null && header.toPeerId !== 0 && header.toPeerId !== PacketType.Invalid) {
            // 这里只是保留显式判断，真正的处理逻辑在下面分支里完成。
          }
          if (header.toPeerId === PacketType.Invalid /* 理论上不会命中 */) {
            // 保留占位分支，不做处理。
          }
          if (header.toPeerId === undefined || header.toPeerId === null) {
            await handleRpcReq(ws, header, payload, this.types);
            break;
          }
          if (header.toPeerId === MY_PEER_ID) {
            await handleRpcReq(ws, header, payload, this.types);
            break;
          }
          handleForwarding(ws, header, buffer, this.types);
          break;
        case PacketType.RpcResp:
          if (header.toPeerId === undefined || header.toPeerId === null || header.toPeerId === MY_PEER_ID) {
            await handleRpcResp(ws, header, payload, this.types);
            break;
          }
          // 响应目标不是当前 Worker，就继续在房间内转发给对应 Peer。
          if (header.packetType !== PacketType.Data) {
            console.log(`[ws] -> forward RpcResp type=${header.packetType} from=${header.fromPeerId} to=${header.toPeerId} len=${payload.length}`);
          }
          handleForwarding(ws, header, buffer, this.types);
          break;
        case PacketType.Data:
        default:
          if (header.packetType !== PacketType.Data) {
            console.log(`[ws] -> forward type=${header.packetType} len=${payload.length}`);
          }
          handleForwarding(ws, header, buffer, this.types);
      }
    } catch (e) {
      console.error('relay_room message handling error:', e);
      // 尽量不要因为单次报文异常就立刻断线，避免客户端频繁重连。
    }
  }

  async webSocketClose(ws) {
    if (ws.heartbeatInterval) {
      clearInterval(ws.heartbeatInterval);
      ws.heartbeatInterval = null;
    }

    if (ws.peerId) {
      this.peerManager.removePeer(ws);
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  _initSocket(ws, meta = {}) {
    ws.peerId = meta.peerId || null;
    ws.groupKey = meta.groupKey || null;
    ws.domainName = meta.domainName || null;
    ws.lastSeen = Date.now();
    ws.lastPingSent = 0;
    ws.lastPongReceived = Date.now();
    ws.serverSessionId = meta.serverSessionId || randomU64String();
    ws.weAreInitiator = false;
    ws.crypto = { enabled: false };
    ws.heartbeatInterval = null;
    ws.serializeAttachment?.({
      peerId: ws.peerId,
      groupKey: ws.groupKey,
      domainName: ws.domainName,
      serverSessionId: ws.serverSessionId,
    });
    this._startHeartbeat(ws);
  }

  _restoreSocket(ws) {
    const meta = ws.deserializeAttachment ? (ws.deserializeAttachment() || {}) : {};
    this._initSocket(ws, meta);

    if (ws.peerId && ws.groupKey) {
      this.peerManager.addPeer(ws.peerId, ws);
    }
  }

  _startHeartbeat(ws) {
    if (ws.heartbeatInterval) {
      clearInterval(ws.heartbeatInterval);
    }

    const heartbeatInterval = Number(this.env.EASYTIER_HEARTBEAT_INTERVAL || 25000);
    const connectionTimeout = Number(this.env.EASYTIER_CONNECTION_TIMEOUT || 60000);
    const checkInterval = Math.max(1000, Math.min(Math.floor(heartbeatInterval / 5), 5000));

    ws.heartbeatInterval = setInterval(() => {
      try {
        if (ws.readyState !== WS_OPEN) {
          clearInterval(ws.heartbeatInterval);
          ws.heartbeatInterval = null;
          return;
        }

        const now = Date.now();
        if (now - ws.lastPingSent >= heartbeatInterval) {
          // 主动发 Ping，让客户端持续回 Pong，便于判定连接是否仍然可用。
          this._sendPing(ws);
          ws.lastPingSent = now;
        }

        if (now - ws.lastPongReceived >= connectionTimeout) {
          console.warn(`[heartbeat] connection timeout for peer ${ws.peerId}`);
          ws.close();
        }
      } catch (error) {
        console.error('[heartbeat] interval error:', error);
      }
    }, checkInterval);
  }

  _sendPing(ws) {
    try {
      if (ws.readyState !== WS_OPEN || !ws.peerId) {
        return;
      }

      const payload = Buffer.from('ping');
      const header = createHeader(MY_PEER_ID, ws.peerId, PacketType.Ping, payload.length);
      ws.send(Buffer.concat([header, payload]));
    } catch (error) {
      console.error('[heartbeat] send ping failed:', error);
    }
  }

  _handlePong(ws) {
    ws.lastPongReceived = Date.now();
  }
}
