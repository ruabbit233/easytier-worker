// EasyTier Worker 里共用的协议常量。
export const MAGIC = 0xd1e1a5e1;
export const VERSION = 1;
export const MY_PEER_ID = 10000001; // 当前 Worker 在协议里使用的服务端 Peer ID
export const HEADER_SIZE = 16;

export const PacketType = {
  Invalid: 0,
  Data: 1,
  HandShake: 2,
  RoutePacket: 3, // 已废弃，保留仅用于兼容旧枚举值
  Ping: 4,
  Pong: 5,
  TaRpc: 6, // 已废弃，保留仅用于兼容旧枚举值
  Route: 7, // 已废弃，保留仅用于兼容旧枚举值
  RpcReq: 8,
  RpcResp: 9,
  ForeignNetworkPacket: 10,
  KcpSrc: 11,
  KcpDst: 12,
};
