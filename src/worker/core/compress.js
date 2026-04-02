import { Buffer } from 'buffer';

// 对齐 EasyTier v2.4.5 的语义：
// CompressionAlgoPb.None = 1, CompressionAlgoPb.Zstd = 2。
export const RPC_COMPRESSION_NONE = 1;
export const RPC_COMPRESSION_ZSTD = 2;

const DEFAULT_ZSTD_LEVEL = Number(process.env.EASYTIER_ZSTD_LEVEL || 3);
const IS_WORKERS_RUNTIME = typeof WebSocketPair !== 'undefined';
const ZSTD_ENABLED = process.env.EASYTIER_COMPRESS_RPC !== '0';

let zstdApi = null;
let zstdLoadError = null;
const zstdInitPromise = ZSTD_ENABLED
  ? (async () => {
    if (IS_WORKERS_RUNTIME) {
      const { loadWorkerCompatibleZstd } = await import('./zstd_bokuweb_worker_loader.js');
      zstdApi = await loadWorkerCompatibleZstd();
    } else {
      const zstd = await import('@bokuweb/zstd-wasm');
      await zstd.init();
      zstdApi = {
        compress: zstd.compress,
        decompress: zstd.decompress,
      };
    }
    return zstdApi;
  })().catch((e) => {
    zstdLoadError = e;
    console.warn(`[compress] failed to load @bokuweb/zstd-wasm, RPC compression will fall back to None: ${e.message}`);
    return null;
  })
  : Promise.resolve(null);

async function ensureZstdLoaded() {
  if (zstdApi) return zstdApi;
  if (zstdLoadError) return null;
  return zstdInitPromise;
}

export function isZstdAvailable() {
  return !!zstdApi;
}

export function getSupportedRpcCompressionInfo() {
  return {
    algo: RPC_COMPRESSION_NONE,
    acceptedAlgo: (ZSTD_ENABLED && !zstdLoadError) ? RPC_COMPRESSION_ZSTD : RPC_COMPRESSION_NONE,
  };
}

export async function compressRpcBody(data, opts = {}) {
  const enabled = opts.enabled !== undefined ? !!opts.enabled : true;
  const minBytes = opts.minBytes !== undefined ? Number(opts.minBytes) : 256;
  const level = opts.level !== undefined ? Number(opts.level) : DEFAULT_ZSTD_LEVEL;
  const preferredAlgo = opts.preferredAlgo !== undefined ? Number(opts.preferredAlgo) : RPC_COMPRESSION_ZSTD;
  const supported = getSupportedRpcCompressionInfo();
  const input = Buffer.from(data || []);

  if (!enabled || input.length === 0 || input.length <= minBytes) {
    return { body: input, compressionInfo: supported };
  }

  if (preferredAlgo !== RPC_COMPRESSION_ZSTD) {
    return { body: input, compressionInfo: supported };
  }

  const api = await ensureZstdLoaded();
  if (!api) {
    return {
      body: input,
      compressionInfo: {
        algo: RPC_COMPRESSION_NONE,
        acceptedAlgo: RPC_COMPRESSION_NONE,
      },
    };
  }

  try {
    const compressed = api.compress(input, level);
    return {
      body: Buffer.from(compressed),
      compressionInfo: {
        algo: RPC_COMPRESSION_ZSTD,
        acceptedAlgo: supported.acceptedAlgo,
      },
    };
  } catch (e) {
    console.warn(`Compress rpc body with zstd failed: ${e.message}`);
    return { body: input, compressionInfo: supported };
  }
}

export async function decompressRpcBody(data, compressionInfo, context = 'rpc') {
  const algo = compressionInfo && typeof compressionInfo.algo === 'number'
    ? compressionInfo.algo
    : RPC_COMPRESSION_NONE;
  const input = Buffer.from(data || []);

  if (algo <= RPC_COMPRESSION_NONE) {
    return input;
  }

  if (algo !== RPC_COMPRESSION_ZSTD) {
    throw new Error(`Unsupported ${context} compression algo=${algo}`);
  }

  const api = await ensureZstdLoaded();
  if (!api) {
    const reason = zstdLoadError ? `: ${zstdLoadError.message}` : '';
    throw new Error(`Zstd requested for ${context}, but @bokuweb/zstd-wasm is unavailable${reason}`);
  }

  try {
    const decompressed = api.decompress(input);
    return Buffer.from(decompressed);
  } catch (e) {
    throw new Error(`Zstd decompress failed for ${context}: ${e.message}`);
  }
}
