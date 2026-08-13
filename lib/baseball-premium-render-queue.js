import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const globalForBaseballRender = globalThis;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RENDER_TIMEOUT_MS = 300_000;
const MAX_RENDER_BYTES = 50 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function hasRenderAssets(root) {
  return root && (
    existsSync(join(root, 'scripts', 'render-baseball-premium-mosaic.mjs'))
    && existsSync(join(root, 'lib', 'baseball-premium-mosaic-image.js'))
  );
}

function ancestors(start, maxDepth = 8) {
  const roots = [];
  let current = start;
  for (let depth = 0; current && depth <= maxDepth; depth += 1) {
    roots.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

export function resolveBaseballPremiumProjectRoot(extraStarts = []) {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const starts = [
    process.env.CFANALISIS_PROJECT_ROOT,
    ...extraStarts,
    process.cwd(),
    moduleDir,
    // Último salvavidas operacional para el standalone de producción. No se
    // usa si cualquiera de los ancestros reales ya contiene los assets.
    '/apps/futbol',
  ].filter(Boolean);
  const roots = [...new Set(starts.flatMap((start) => ancestors(start)))];
  const projectRoot = roots.find(hasRenderAssets);
  if (!projectRoot) {
    throw new Error('Baseball premium render script not found');
  }
  return projectRoot;
}

function renderScriptPath() {
  const projectRoot = resolveBaseballPremiumProjectRoot();
  return join(projectRoot, 'scripts', 'render-baseball-premium-mosaic.mjs');
}

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

/**
 * Ejecuta Satori/Sharp en un proceso efimero. libvips reserva memoria nativa
 * que glibc no siempre devuelve al SO; incluso con renders seriales el RSS del
 * servidor web puede crecer hasta el limite de PM2. Al terminar cada hijo, el
 * sistema operativo recupera toda esa memoria de forma determinista.
 */
export function renderBaseballPremiumMosaicPngIsolated(payload) {
  return new Promise((resolve, reject) => {
    let script;
    try {
      script = renderScriptPath();
    } catch (error) {
      reject(error);
      return;
    }
    const projectRoot = dirname(dirname(script));
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error, png) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(png);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Baseball premium render exceeded ${RENDER_TIMEOUT_MS} ms`));
    }, RENDER_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RENDER_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('Baseball premium render exceeded 50 MB'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      const kept = chunk.subarray(0, remaining);
      stderr.push(kept);
      stderrBytes += kept.length;
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      const png = Buffer.concat(stdout);
      if (code === 0 && png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        finish(null, png);
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      finish(new Error(
        `Baseball premium render failed (${signal || code})${detail ? `: ${detail}` : ''}`,
      ));
    });

    child.stdin.on('error', (error) => finish(error));
    child.stdin.end(JSON.stringify(payload));
  });
}
