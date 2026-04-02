import zlib from 'zlib';

// Worker 运行时不一定总能拿到完整 zlib，这里统一做一层兼容判断。
const hasZlib = !!(zlib && typeof zlib.gzipSync === 'function' && typeof zlib.gunzipSync === 'function');

export function gzipMaybe(data) {
  if (hasZlib) {
    return zlib.gzipSync(data);
  }
  console.warn('zlib.gzipSync 不可用，返回原始数据');
  return data;
}

export function gunzipMaybe(data) {
  if (hasZlib) {
    return zlib.gunzipSync(data);
  }
  console.warn('zlib.gunzipSync 不可用，返回原始数据');
  return data;
}

export function isCompressionAvailable() {
  return hasZlib;
}
