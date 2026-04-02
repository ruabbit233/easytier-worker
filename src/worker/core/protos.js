// 需要先配置 long.js，再加载 protobuf 生成代码，否则 int64 会解析不稳定。
import Long from 'long';
import * as protobuf from 'protobufjs/minimal';

// 显式告诉 protobufjs 使用 long.js 处理 64 位整数。
protobuf.util.Long = Long;
protobuf.configure(); // 应用上面的 Long 配置。

import root from './protos_generated.js';

let cachedTypes;

export function loadProtos() {
  if (cachedTypes) return cachedTypes;
  const peerRpc = root.peer_rpc;
  const common = root.common;
  // 只暴露运行时真正会用到的消息类型，避免业务侧每次都从 root 深层取值。
  return cachedTypes = {
    root,
    HandshakeRequest: peerRpc.HandshakeRequest,
    RpcPacket: common.RpcPacket,
    RpcRequest: common.RpcRequest,
    RpcResponse: common.RpcResponse,
    SyncRouteInfoRequest: peerRpc.SyncRouteInfoRequest,
    SyncRouteInfoResponse: peerRpc.SyncRouteInfoResponse,
    RouteConnBitmap: peerRpc.RouteConnBitmap,
    RoutePeerInfo: peerRpc.RoutePeerInfo,
    ReportPeersRequest: peerRpc.ReportPeersRequest,
    ReportPeersResponse: peerRpc.ReportPeersResponse,
    GetGlobalPeerMapRequest: peerRpc.GetGlobalPeerMapRequest,
    GetGlobalPeerMapResponse: peerRpc.GetGlobalPeerMapResponse,
    PeerInfoForGlobalMap: peerRpc.PeerInfoForGlobalMap,
    GlobalPeerMap: peerRpc.GlobalPeerMap,
  };
}
