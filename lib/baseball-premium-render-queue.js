const globalForBaseballRender = globalThis;

if (!globalForBaseballRender.__cfBaseballPremiumRenderQueue) {
  globalForBaseballRender.__cfBaseballPremiumRenderQueue = Promise.resolve();
}

/**
 * Sharp/libvips rasteriza el mosaico 4K fuera del heap de V8. Varias
 * solicitudes simultaneas pueden superar el limite de memoria de PM2 aunque
 * cada render aislado sea sano. Esta cola conserva la resolucion y garantiza
 * un unico render pesado por proceso.
 */
export function runBaseballPremiumRenderExclusive(task) {
  if (typeof task !== 'function') {
    throw new TypeError('Baseball premium render task must be a function');
  }

  const previous = globalForBaseballRender.__cfBaseballPremiumRenderQueue;
  const current = previous.then(task, task);
  globalForBaseballRender.__cfBaseballPremiumRenderQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
