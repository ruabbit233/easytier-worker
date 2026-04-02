// Cloudflare Worker entry for EasyTier WebSocket relay backed by Durable Object
// Module syntax is required for Durable Objects.
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

    if (pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: SERVICE_NAME,
        wsPath,
        locationHint: env.LOCATION_HINT || 'auto',
      });
    }

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
