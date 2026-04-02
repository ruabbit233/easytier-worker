import { MY_PEER_ID, PacketType } from './constants.js';
import { createHeader } from './packet.js';
import { getPeerManager } from './peer_manager.js';
import { wrapPacket, sha256 } from './crypto.js';
import { compressRpcBody, decompressRpcBody } from './compress.js';
import { loadProtos } from './protos.js';

// 把 transactionId 统一转换成 protobuf 可稳定编码的 int64 形式。
function toLongForProto(value) {
  if (value === null || value === undefined) return value;

  // 已经是 { low, high } 这类 Long-like 结构时直接返回。
  if (value && typeof value === 'object' && typeof value.low === 'number' && typeof value.high === 'number') {
    return value;
  }

  // 如果本来就是 Long 实例，也无需再转换。
  if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'Long') {
    return value;
  }

  // 字符串优先按 BigInt 解析，避免大整数在 Number 中丢精度。
  if (typeof value === 'string') {
    try {
      const big = BigInt(value);
      const low = Number(big & 0xffffffffn);
      const high = Number((big >> 32n) & 0xffffffffn);
      return { low, high, unsigned: false };
    } catch (e) {
      console.warn(`Failed to parse transactionId string as BigInt: ${value}`);
      return value;
    }
  }

  // Number 只能安全表示 53 位以内整数，这里按 64 位拆成 low/high。
  if (typeof value === 'number') {
    const low = value | 0;
    const high = Math.floor(value / 4294967296);
    return { low, high, unsigned: false };
  }

  // BigInt 是最理想的来源类型，直接拆分即可。
  if (typeof value === 'bigint') {
    const low = Number(value & 0xffffffffn);
    const high = Number((value >> 32n) & 0xffffffffn);
    return { low, high, unsigned: false };
  }

  return value;
}

const peerCenterStateByGroup = new Map();
const PEER_CENTER_TTL_MS = Number(process.env.EASYTIER_PEER_CENTER_TTL_MS || 180_000);
const PEER_CENTER_CLEAN_INTERVAL = Math.max(30_000, Math.min(PEER_CENTER_TTL_MS / 2, 120_000));
let lastPeerCenterClean = 0;
function pm() {
  return getPeerManager();
}

function getPeerCenterState(groupKey) {
  const k = String(groupKey || '');
  let s = peerCenterStateByGroup.get(k);
  if (!s) {
    s = {
      globalPeerMap: new Map(),
      digest: '0',
    };
    peerCenterStateByGroup.set(k, s);
  }
  const now = Date.now();
  if (now - lastPeerCenterClean > PEER_CENTER_CLEAN_INTERVAL) {
    cleanPeerCenterState(now);
  }
  s.lastTouch = Date.now();
  return s;
}

function cleanPeerCenterState(now = Date.now()) {
  lastPeerCenterClean = now;
  for (const [gk, s] of peerCenterStateByGroup.entries()) {
    for (const [pid, info] of s.globalPeerMap.entries()) {
      if (now - (info.lastSeen || 0) > PEER_CENTER_TTL_MS) {
        s.globalPeerMap.delete(pid);
      }
    }
    if (now - (s.lastTouch || 0) > PEER_CENTER_TTL_MS && s.globalPeerMap.size === 0) {
      peerCenterStateByGroup.delete(gk);
    }
  }
}

function calcPeerCenterDigestFromMap(mapObj) {
  const h = sha256();
  const keys = Object.keys(mapObj).sort();
  for (const k of keys) {
    h.update(k);
    const directPeers = mapObj[k].directPeers || {};
    const dKeys = Object.keys(directPeers).sort();
    for (const dk of dKeys) {
      h.update(dk);
      const v = directPeers[dk];
      h.update(Buffer.from(String(v && v.latencyMs !== undefined ? v.latencyMs : 0)));
    }
  }
  const b = h.digest();
  let x = 0n;
  for (let i = 0; i < 8; i++) {
    x = (x << 8n) | BigInt(b[i]);
  }
  const u64 = x & 0xFFFFFFFFFFFFFFFFn;
  return u64.toString();
}

function buildPeerCenterResponseMap(groupKey, state) {
  const out = {};
  const set = new Set(pm().listPeerIdsInGroup(groupKey));
  const infos = pm()._getPeerInfosMap(groupKey, false);
  if (infos) {
    for (const pid of infos.keys()) set.add(pid);
  }
  for (const peerId of set) {
    const key = String(peerId);
    const existing = state.globalPeerMap.get(key);
    out[key] = existing ? { ...existing } : { directPeers: {} };
    if (!out[key].directPeers) out[key].directPeers = {};
    out[key].directPeers[String(MY_PEER_ID)] = { latencyMs: 0 };
  }
  return out;
}

async function sendRpcResponse(ws, toPeerId, reqRpcPacket, types, responseBodyBytes) {
  if (!ws || ws.readyState !== 1) { // WebSocket 仍未处于可发送状态
    console.error(`sendRpcResponse aborted: socket not open (readyState=${ws ? ws.readyState : 'nil'}) toPeer=${toPeerId}`);
    return;
  }
  const requestedAcceptedAlgo = reqRpcPacket?.compressionInfo?.acceptedAlgo;
  const { body: responseBody, compressionInfo } = await compressRpcBody(responseBodyBytes, {
    enabled: process.env.EASYTIER_COMPRESS_RPC !== '0',
    preferredAlgo: requestedAcceptedAlgo,
  });

  const rpcResponsePayload = {
    response: responseBody,
    error: null,
    runtimeUs: 0,
  };
  const rpcResponseBytes = types.RpcResponse.encode(rpcResponsePayload).finish();

  // 这里保留详细 transactionId 日志，方便定位 int64 编解码问题。
  const txId = reqRpcPacket.transactionId;
  let txIdValue, txIdType;
  if (txId && typeof txId === 'object' && txId.constructor && txId.constructor.name === 'Long') {
    // protobufjs 解码后的 Long 实例
    txIdValue = txId.toString();
    txIdType = 'Long';
  } else if (typeof txId === 'bigint') {
    txIdValue = txId.toString();
    txIdType = 'BigInt';
  } else if (typeof txId === 'string') {
    txIdValue = txId;
    txIdType = 'String';
  } else if (typeof txId === 'number') {
    txIdValue = String(txId);
    txIdType = 'Number';
  } else if (txId && typeof txId === 'object' && typeof txId.low === 'number' && typeof txId.high === 'number') {
    // 普通的 Long-like 对象
    const combined = (BigInt(txId.high) << 32n) | BigInt(txId.low >>> 0);
    txIdValue = combined.toString();
    txIdType = 'Long-like';
  } else {
    txIdValue = String(txId);
    txIdType = typeof txId;
  }
  console.log(`sendRpcResponse: transactionId=${txIdValue} (${txIdType}) raw=${JSON.stringify(txId)}`);

  // 编码前统一整理 transactionId 格式，避免不同来源类型导致的兼容问题。
  const txIdForEncoding = toLongForProto(txId);

  const rpcRespPacket = {
    fromPeer: MY_PEER_ID,
    toPeer: toPeerId,
    transactionId: txIdForEncoding,
    descriptor: reqRpcPacket.descriptor,
    body: rpcResponseBytes,
    isRequest: false,
    totalPieces: 1,
    pieceIdx: 0,
    traceId: reqRpcPacket.traceId,
    compressionInfo,
  };
  const rpcPacketBytes = types.RpcPacket.encode(rpcRespPacket).finish();
  const buf = wrapPacket(createHeader, MY_PEER_ID, toPeerId, PacketType.RpcResp, rpcPacketBytes, ws);
  try {
    ws.send(buf);
    console.log(`RpcResp -> to=${toPeerId} txLen=${buf.length} txTransaction=${txIdValue} SUCCESS`);
  } catch (e) {
    console.error(`sendRpcResponse to ${toPeerId} failed: ${e.message}`);
    // 继续抛出，让上层知道这次响应没有真正发出去。
    throw new Error(`Failed to send RPC response to ${toPeerId}: ${e.message}`);
  }
}

export async function handleRpcReq(ws, header, payload, types) {
  try {
    const rpcPacket = types.RpcPacket.decode(payload);

    // 记录 transactionId 的原始形态，方便排查 64 位整数兼容问题。
    const txId = rpcPacket.transactionId;
    let txIdValue, txIdType, txIdDetails;
    if (txId && typeof txId === 'object' && txId.constructor && txId.constructor.name === 'Long') {
      txIdValue = txId.toString();
      txIdType = 'Long';
      txIdDetails = `low=${txId.low}, high=${txId.high}, unsigned=${txId.unsigned}`;
    } else if (typeof txId === 'bigint') {
      txIdValue = txId.toString();
      txIdType = 'BigInt';
      txIdDetails = '';
    } else if (typeof txId === 'string') {
      txIdValue = txId;
      txIdType = 'String';
      txIdDetails = '';
    } else if (typeof txId === 'number') {
      txIdValue = String(txId);
      txIdType = 'Number';
      txIdDetails = '';
    } else if (txId && typeof txId === 'object' && typeof txId.low === 'number' && typeof txId.high === 'number') {
      const combined = (BigInt(txId.high) << 32n) | BigInt(txId.low >>> 0);
      txIdValue = combined.toString();
      txIdType = 'Long-like';
      txIdDetails = `low=${txId.low}, high=${txId.high}`;
    } else {
      txIdValue = String(txId);
      txIdType = typeof txId;
      txIdDetails = '';
    }
    console.log(`handleRpcReq: from=${header.fromPeerId} transactionId=${txIdValue} (${txIdType}) ${txIdDetails} raw=${JSON.stringify(txId)}`);

    if (rpcPacket.compressionInfo) {
      try {
        rpcPacket.body = await decompressRpcBody(
          rpcPacket.body,
          rpcPacket.compressionInfo,
          `rpc request from ${header.fromPeerId}`
        );
      } catch (e) {
        console.error(e.message);
        return;
      }
    }
    const descriptor = rpcPacket.descriptor;

    let innerReqBody = rpcPacket.body;
    try {
      const rpcReqWrapper = types.RpcRequest.decode(rpcPacket.body);
      if (rpcReqWrapper.request && rpcReqWrapper.request.length > 0) {
        innerReqBody = rpcReqWrapper.request;
      }
    } catch (e) {
      console.log("RpcRequest 外层包装解析失败，按裸 body 继续处理:", e.message);
    }

    if ((descriptor.serviceName === 'peer_rpc.PeerCenterRpc' || descriptor.serviceName === 'PeerCenterRpc')
      && (descriptor.protoName === 'peer_rpc' || !descriptor.protoName)) {
      const groupKey = ws && ws.groupKey ? String(ws.groupKey) : '';
      const state = getPeerCenterState(groupKey);
      if (descriptor.methodIndex === 0) {
        // ReportPeers: 客户端上报自己看到的直连关系，我们合并到房间级视图。
        const req = types.ReportPeersRequest.decode(innerReqBody);
        const myPeerId = req.myPeerId;
        const peers = req.peerInfos || { directPeers: {} };

        const directPeers = {};
        if (peers.directPeers) {
          for (const [dstPeerId, info] of Object.entries(peers.directPeers)) {
            directPeers[String(dstPeerId)] = { latencyMs: (info && typeof info.latencyMs === 'number') ? info.latencyMs : 0 };
          }
        }
        state.globalPeerMap.set(String(myPeerId), { directPeers, lastSeen: Date.now() });

        const snapshot = buildPeerCenterResponseMap(groupKey, state);
        state.digest = calcPeerCenterDigestFromMap(snapshot);

        const respBytes = types.ReportPeersResponse.encode({}).finish();
        await sendRpcResponse(ws, header.fromPeerId, rpcPacket, types, respBytes);
        return;
      }

      if (descriptor.methodIndex === 1) {
        // GetGlobalPeerMap: 客户端按 digest 拉取最新快照，未变化时返回空响应节省带宽。
        const req = types.GetGlobalPeerMapRequest.decode(innerReqBody);
        const reqDigest = req.digest !== undefined && req.digest !== null ? String(req.digest) : '0';
        if (reqDigest === state.digest && reqDigest !== '0') {
          const respBytes = types.GetGlobalPeerMapResponse.encode({}).finish();
          await sendRpcResponse(ws, header.fromPeerId, rpcPacket, types, respBytes);
          return;
        }

        const snapshot = buildPeerCenterResponseMap(groupKey, state);
        state.digest = calcPeerCenterDigestFromMap(snapshot);
        const respBytes = types.GetGlobalPeerMapResponse.encode({
          globalPeerMap: snapshot,
          digest: state.digest,
        }).finish();
        await sendRpcResponse(ws, header.fromPeerId, rpcPacket, types, respBytes);
        return;
      }

      console.log(`Unhandled PeerCenterRpc methodIndex=${descriptor.methodIndex}`);
      return;
    }

    if ((descriptor.serviceName === 'peer_rpc.OspfRouteRpc' || descriptor.serviceName === 'OspfRouteRpc')
      && (descriptor.protoName === 'peer_rpc' || descriptor.protoName === 'peer_rpc.OspfRouteRpc' || descriptor.protoName === 'OspfRouteRpc' || !descriptor.protoName)) {
      const req = types.SyncRouteInfoRequest.decode(innerReqBody);
      const desc = descriptor || {};
      const fromPeerId = header.fromPeerId;
      console.log(`RPC Request descriptor from ${fromPeerId}: domain=${desc.domainName}, service=${desc.serviceName}, proto=${desc.protoName}, method=${desc.methodIndex}`);
      const peerInfosCount = req.peerInfos ? req.peerInfos.items.length : 0;
      const hasConnBitmap = !!req.connBitmap;
      const hasForeignNet = !!req.foreignNetworkInfos;
      console.log(`SyncRouteInfo details: SessionID=${req.mySessionId}, Initiator=${req.isInitiator}, PeerInfosCount=${peerInfosCount}, HasConnBitmap=${hasConnBitmap}, HasForeignNet=${hasForeignNet}`);
      if (descriptor.methodIndex === 0 || descriptor.methodIndex === 1) {
        await handleSyncRouteInfo(ws, fromPeerId, rpcPacket, req, types);
        return;
      }
      console.log(`Unhandled OspfRouteRpc methodIndex=${descriptor.methodIndex}`);
      return;
    }

    console.log(`Unhandled RPC Service: ${descriptor.serviceName} (proto: ${descriptor.protoName})`);

  } catch (e) {
    console.error('RPC Decode error:', e);
  }
}

export async function handleRpcResp(ws, header, payload, types) {
  try {
    console.log(`RpcResp <- from=${header.fromPeerId} to=${header.toPeerId} len=${payload.length} packetType=${header.packetType} forwardCounter=${header.forwardCounter}`);
    const rpcPacket = types.RpcPacket.decode(payload);

    // 响应侧同样保留 transactionId 细节，便于请求与响应对应排查。
    const txId = rpcPacket.transactionId;
    let txIdValue, txIdType, txIdDetails;
    if (txId && typeof txId === 'object' && txId.constructor && txId.constructor.name === 'Long') {
      txIdValue = txId.toString();
      txIdType = 'Long';
      txIdDetails = `low=${txId.low}, high=${txId.high}, unsigned=${txId.unsigned}`;
    } else if (typeof txId === 'bigint') {
      txIdValue = txId.toString();
      txIdType = 'BigInt';
      txIdDetails = '';
    } else if (typeof txId === 'string') {
      txIdValue = txId;
      txIdType = 'String';
      txIdDetails = '';
    } else if (typeof txId === 'number') {
      txIdValue = String(txId);
      txIdType = 'Number';
      txIdDetails = '';
    } else if (txId && typeof txId === 'object' && typeof txId.low === 'number' && typeof txId.high === 'number') {
      const combined = (BigInt(txId.high) << 32n) | BigInt(txId.low >>> 0);
      txIdValue = combined.toString();
      txIdType = 'Long-like';
      txIdDetails = `low=${txId.low}, high=${txId.high}`;
    } else {
      txIdValue = String(txId);
      txIdType = typeof txId;
      txIdDetails = '';
    }
    console.log(`handleRpcResp: transactionId=${txIdValue} (${txIdType}) ${txIdDetails} raw=${JSON.stringify(txId)}`);
    if (rpcPacket.compressionInfo) {
      try {
        rpcPacket.body = await decompressRpcBody(
          rpcPacket.body,
          rpcPacket.compressionInfo,
          `rpc response from ${header.fromPeerId}`
        );
      } catch (e) {
        console.error(e.message);
        return;
      }
    }

    const descriptor = rpcPacket.descriptor || {};
    let rpcRespBody = rpcPacket.body;
    // 先尝试按通用 RpcResponse 外层包装解码。
    let rpcResponseDecoded = null;
    try {
      rpcResponseDecoded = types.RpcResponse.decode(rpcRespBody);
      rpcRespBody = rpcResponseDecoded.response || rpcRespBody;
    } catch (e) {
      // 外层解不出来时保留原始 body，尽量继续往下兼容处理。
      console.warn(`RpcResp wrapper decode failed from ${header.fromPeerId}: ${e.message}`);
    }
    // OspfRouteRpc 的响应主要用于确认路由同步会话 sessionId。
    if ((descriptor.serviceName === 'peer_rpc.OspfRouteRpc' || descriptor.serviceName === 'OspfRouteRpc')
      && (descriptor.protoName === 'peer_rpc' || descriptor.protoName === 'peer_rpc.OspfRouteRpc' || descriptor.protoName === 'OspfRouteRpc' || !descriptor.protoName)) {
      try {
        const resp = types.SyncRouteInfoResponse.decode(rpcRespBody);
        const sessionId = resp && resp.sessionId ? resp.sessionId : null;
        if (sessionId && ws && ws.groupKey !== undefined) {
          pm().onRouteSessionAck(ws.groupKey, header.fromPeerId, sessionId, {
            dstIsInitiator: resp.isInitiator,
          });
          console.log(`RpcResp SyncRouteInfoResponse from=${header.fromPeerId} sessionId=${sessionId} acked`);
        }
      } catch (e) {
        console.error(`Decode SyncRouteInfoResponse failed from ${header.fromPeerId}: ${e.message}`);
      }
      return;
    }

    // 其他 RPC 目前只做通用结果记录。
    if (rpcResponseDecoded) {
      if (rpcResponseDecoded.error) {
        console.warn(`RpcResp error from ${header.fromPeerId}:`, rpcResponseDecoded.error);
      } else {
        console.log(`RpcResp from=${header.fromPeerId} ok`);
      }
    }
  } catch (e) {
    console.error('RPC Resp Decode error:', e);
  }
}

async function handleSyncRouteInfo(ws, fromPeerId, reqRpcPacket, syncReq, types) {
  const groupKey = ws && ws.groupKey ? String(ws.groupKey) : '';
  const session = pm().onRouteSessionAck(groupKey, fromPeerId, syncReq.mySessionId, {
    dstIsInitiator: syncReq.isInitiator,
  });

  let hasNewPeers = false;
  if (syncReq.peerInfos && syncReq.peerInfos.items) {
    // 把对端带来的 PeerInfo 合并进当前房间视图，用于后续继续广播。
    syncReq.peerInfos.items.forEach(info => {
      if (info.peerId !== MY_PEER_ID) {
        const infos = pm()._getPeerInfosMap(groupKey, false);
        const isNew = !infos || !infos.has(info.peerId);
        pm().updatePeerInfo(groupKey, info.peerId, info);
        if (isNew) hasNewPeers = true;
      }
      if (info.peerId === MY_PEER_ID) {
        pm().updatePeerInfo(groupKey, info.peerId, info);
      }
    });
  }

  const respPayload = {
    isInitiator: !!session.weAreInitiator,
    sessionId: session.mySessionId
  };
  const respBytes = types.SyncRouteInfoResponse.encode(respPayload).finish();
  if (reqRpcPacket.compressionInfo && reqRpcPacket.compressionInfo.algo > 1) {
    console.log(`Client sent compressed RPC body (algo=${reqRpcPacket.compressionInfo.algo}); decoded successfully before handling.`);
  }

  // 先回 ACK，避免客户端因为等待超时而认为本次路由同步失败。
  try {
    await sendRpcResponse(ws, fromPeerId, reqRpcPacket, types, respBytes);
    console.log(`Sent SyncRouteInfoResponse to peer ${fromPeerId}, transactionId=${reqRpcPacket.transactionId}`);
  } catch (e) {
    console.error(`CRITICAL: Failed to send SyncRouteInfoResponse to peer ${fromPeerId}: ${e.message}`);
    // 这里不再抛出，尽量让后续流程还能继续推进。
  }

  pm().syncGroupNow(groupKey, hasNewPeers ? 'sync_route_info:new_peer' : 'sync_route_info');
}
