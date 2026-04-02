import { Buffer } from 'buffer';
import { Zstd } from '@hpcc-js/wasm-zstd';

// 对齐 EasyTier v2.4.5 的语义：
// CompressionAlgoPb.None = 1, CompressionAlgoPb.Zstd = 2。
export const RPC_COMPRESSION_NONE = 1;
export const RPC_COMPRESSION_ZSTD = 2;

const DEFAULT_ZSTD_LEVEL = Number(process.env.EASYTIER_ZSTD_LEVEL || 3);

let zstd = null;
let zstdLoadError = null;

try {
  zstd = await Zstd.load();
} catch (e) {
  zstdLoadError = e;
  console.warn(`[compress] failed to load @hpcc-js/wasm-zstd, RPC compression will fall back to None: ${e.message}`);
}

export function isZstdAvailable() {
  return !!zstd;
}

export function getSupportedRpcCompressionInfo() {
  return {
    algo: RPC_COMPRESSION_NONE,
    acceptedAlgo: isZstdAvailable() ? RPC_COMPRESSION_ZSTD : RPC_COMPRESSION_NONE,
  };
}

export function compressRpcBody(data, opts = {}) {
  const enabled = opts.enabled !== undefined ? !!opts.enabled : true;
  const minBytes = opts.minBytes !== undefined ? Number(opts.minBytes) : 256;
  const level = opts.level !== undefined ? Number(opts.level) : DEFAULT_ZSTD_LEVEL;
  const preferredAlgo = opts.preferredAlgo !== undefined ? Number(opts.preferredAlgo) : RPC_COMPRESSION_ZSTD;
  const supported = getSupportedRpcCompressionInfo();
  const input = Buffer.from(data || []);

  if (!enabled || input.length === 0 || input.length <= minBytes) {
    return { body: input, compressionInfo: supported };
  }

  if (preferredAlgo !== RPC_COMPRESSION_ZSTD || !isZstdAvailable()) {
    return { body: input, compressionInfo: supported };
  }

  try {
    const resolvedLevel = Math.max(zstd.minCLevel(), Math.min(zstd.maxCLevel(), level));
    const compressed = zstd.compress(input, resolvedLevel);
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

export function decompressRpcBody(data, compressionInfo, context = 'rpc') {
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

  if (!isZstdAvailable()) {
    const reason = zstdLoadError ? `: ${zstdLoadError.message}` : '';
    throw new Error(`Zstd requested for ${context}, but @hpcc-js/wasm-zstd is unavailable${reason}`);
  }

  try {
    const decompressed = zstd.decompress(input);
    return Buffer.from(decompressed);
  } catch (e) {
    throw new Error(`Zstd decompress failed for ${context}: ${e.message}`);
  }
}
