import { MAGIC, VERSION, MY_PEER_ID, PacketType } from './constants.js';
import { createHeader } from './packet.js';
import { getPeerManager } from './peer_manager.js';
import { wrapPacket } from './crypto.js';

const WS_OPEN = (typeof WebSocket !== 'undefined' && WebSocket.OPEN) ? WebSocket.OPEN : 1;

// 同一个 networkName 只接受第一份摘要；后续摘要不一致的连接会被拒绝，
// 这样可以避免不同网络意外混进同一个 relay 逻辑分组。
const networkDigestRegistry = new Map();

export function handleHandshake(ws, header, payload, types) {
  try {
    const req = types.HandshakeRequest.decode(payload);
    try {
      const dig = req.networkSecretDigrest ? Buffer.from(req.networkSecretDigrest) : Buffer.alloc(0);
      console.log(`Handshake networkSecretDigest(hex)=${dig.toString('hex')}`);
    } catch (_) {
      // 这里只是调试日志，不影响正常握手流程。
    }

    if (req.magic !== MAGIC) {
      console.error('Invalid magic');
      ws.close();
      return;
    }

    const clientNetworkName = req.networkName || '';
    const clientDigest = req.networkSecretDigrest ? Buffer.from(req.networkSecretDigrest) : Buffer.alloc(0);
    const digestHex = clientDigest.toString('hex');
    const existingDigest = networkDigestRegistry.get(clientNetworkName);
    if (existingDigest && existingDigest !== digestHex) {
      console.error(`Rejecting handshake from ${req.myPeerId}: digest mismatch for network "${clientNetworkName}" (existing=${existingDigest}, incoming=${digestHex})`);
      ws.close();
      return;
    }
    if (!existingDigest) {
      networkDigestRegistry.set(clientNetworkName, digestHex);
    }
    const groupDigest = networkDigestRegistry.get(clientNetworkName) || '';
    const groupKey = `${clientNetworkName}:${groupDigest}`;
    const serverNetworkName = process.env.EASYTIER_PUBLIC_SERVER_NETWORK_NAME || 'public_server';
    const digest = new Uint8Array(32);

    ws.domainName = clientNetworkName;

    const respPayload = {
      magic: MAGIC,
      myPeerId: MY_PEER_ID,
      version: VERSION,
      features: ["node-server-v1"],
      networkName: serverNetworkName,
      networkSecretDigrest: digest
    };

    ws.groupKey = groupKey;
    ws.peerId = req.myPeerId;
    const pm = getPeerManager();
    pm.addPeer(req.myPeerId, ws);
    // 先注册一份最小可用的 PeerInfo，后续路由同步会再补齐更多字段。
    pm.updatePeerInfo(ws.groupKey, req.myPeerId, {
      peerId: req.myPeerId,
      version: 1,
      lastUpdate: { seconds: Math.floor(Date.now() / 1000), nanos: 0 },
      instId: { part1: 0, part2: 0, part3: 0, part4: 0 },
      networkLength: Number(process.env.EASYTIER_NETWORK_LENGTH || 24),
    });
    pm.setPublicServerFlag(true);
    ws.crypto = { enabled: false };

    const respBuffer = types.HandshakeRequest.encode(respPayload).finish();
    const respHeader = createHeader(MY_PEER_ID, req.myPeerId, PacketType.HandShake, respBuffer.length);
    ws.send(Buffer.concat([respHeader, Buffer.from(respBuffer)]));
    // 握手完成后只标记会话需要同步，由 session scheduler 按统一节奏发包。
    pm.syncPeerNow(ws.groupKey, req.myPeerId, 'handshake_initial', { forceFull: true });
    pm.syncGroupNow(ws.groupKey, 'handshake_broadcast', { excludePeerId: req.myPeerId });

  } catch (e) {
    console.error('Handshake error:', e);
    ws.close();
  }
}

export function handlePing(ws, header, payload) {
  // Ping 原样回 Pong，让对端确认链路仍然连通。
  const msg = wrapPacket(createHeader, MY_PEER_ID, header.fromPeerId, PacketType.Pong, payload, ws);
  ws.send(msg);
}

export function handleForwarding(sourceWs, header, fullMessage, types) {
  const targetPeerId = header.toPeerId;
  const pm = getPeerManager();
  const targetWs = pm.getPeerWs(targetPeerId, sourceWs && sourceWs.groupKey);

  if (targetWs && targetWs.readyState === WS_OPEN) {
    const srcGroup = sourceWs && sourceWs.groupKey;
    const dstGroup = targetWs && targetWs.groupKey;
    if (srcGroup && dstGroup && srcGroup !== dstGroup) {
      // 不允许跨 group 转发，避免不同网络组串线。
      return;
    }
    try {
      targetWs.send(fullMessage);
    } catch (e) {
      console.error(`Forward to ${targetPeerId} failed: ${e.message}`);
      pm.removePeer(targetWs);
    }
  }
}
