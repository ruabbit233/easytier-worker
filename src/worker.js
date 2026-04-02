// EasyTier WebSocket Relay 的 Cloudflare Worker 入口。
// 这里必须使用 ES Module 写法，Durable Object 才能正常导出和绑定。
import { RelayRoom } from './worker/relay_room';

export { RelayRoom };

const SERVICE_NAME = 'easytier-worker';

function resolveWsPath(env) {
  const rawPath = String(env.WS_PATH || 'ws').trim();
  const normalized = rawPath.replace(/^\/+|\/+$/g, '');
  return `/${normalized || 'ws'}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const wsPath = resolveWsPath(env);

    // 基础健康检查，方便探活和确认当前配置是否生效。
    if (pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: SERVICE_NAME,
        wsPath,
        locationHint: env.LOCATION_HINT || 'auto',
      });
    }

    // 返回当前服务的基础信息，便于部署后快速确认入口是否正常。
    if (pathname === '/' || pathname === '/info') {
      return Response.json({
        service: SERVICE_NAME,
        wsPath,
        room: searchParams.get('room') || 'default',
        features: {
          durableObjectRelay: true,
          heartbeat: true,
        },
      });
    }

    // WebSocket 请求会被转交给对应 room 的 Durable Object 处理。
    if (pathname === wsPath || pathname === wsPath + '/') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 400 });
      }

      const roomId = searchParams.get('room') || 'default';
      const options = env.LOCATION_HINT ? { locationHint: env.LOCATION_HINT } : {};
      const roomStub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(roomId), options);
      return roomStub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
