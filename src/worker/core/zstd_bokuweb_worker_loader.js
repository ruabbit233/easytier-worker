import wasmModule from '../../../node_modules/@bokuweb/zstd-wasm/dist/common/zstd.wasm';

let workerApiPromise = null;

export async function loadWorkerCompatibleZstd() {
  if (workerApiPromise) return workerApiPromise;

  workerApiPromise = (async () => {
    const [{ Module, waitInitialized }, compressMod, decompressMod] = await Promise.all([
      import('../../../node_modules/@bokuweb/zstd-wasm/dist/common/module.js'),
      import('../../../node_modules/@bokuweb/zstd-wasm/dist/common/simple/compress.js'),
      import('../../../node_modules/@bokuweb/zstd-wasm/dist/common/simple/decompress.js'),
    ]);

    if (!Module.__easytierZstdInitialized) {
      Module.instantiateWasm = (imports, receiveInstance) => {
        WebAssembly.instantiate(wasmModule, imports)
          .then((result) => receiveInstance(result.instance, wasmModule))
          .catch((e) => {
            throw e;
          });
        return {};
      };
      Module.init();
      await waitInitialized();
      Module.__easytierZstdInitialized = true;
    }

    return {
      compress: compressMod.compress,
      decompress: decompressMod.decompress,
    };
  })();

  return workerApiPromise;
}
