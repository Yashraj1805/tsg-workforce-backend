// Small JPEG thumbnails for list screens. A punch selfie or registration photo is
// several hundred KB; the attendance register, exceptions and dashboards only need a
// 192 px face. Lists return the thumbnail as the image, detail screens the full photo,
// so an HR phone no longer downloads hundreds of MB to draw one screen.
//
// Decoding a multi-megapixel JPEG is CPU-heavy, so it runs in a worker thread and never
// blocks punch handling; a thumbnail that fails (PNG, corrupt data) just stays null and
// the list falls back to the full image for that row.
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const jpeg = require('jpeg-js');

const THUMB_PX = 192;

function makeThumbSync(dataUrl, maxPx) {
  const m = /^data:image\/(jpeg|jpg);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const src = jpeg.decode(Buffer.from(m[2], 'base64'), { useTArray: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 24, formatAsRGBA: true });
  const scale = Math.min(1, maxPx / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
  const out = Buffer.alloc(w * h * 4);
  // Box-filter downscale: average the source block behind each target pixel.
  const bx = src.width / w, by = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * by), y1 = Math.max(y0 + 1, Math.floor((y + 1) * by));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * bx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * bx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) { const i = (sy * src.width + sx) * 4; r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++; }
      const o = (y * w + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  const enc = jpeg.encode({ data: out, width: w, height: h }, 62);
  return 'data:image/jpeg;base64,' + enc.data.toString('base64');
}

if (!isMainThread) {
  parentPort.on('message', ({ id, dataUrl, maxPx }) => {
    let thumb = null;
    try { thumb = makeThumbSync(dataUrl, maxPx); } catch (e) { /* unreadable → no thumb */ }
    parentPort.postMessage({ id, thumb });
  });
}

let worker = null, seq = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(__filename);
  worker.unref();
  worker.on('message', ({ id, thumb }) => { const p = pending.get(id); if (p) { pending.delete(id); p(thumb); } });
  worker.on('error', (e) => { console.error('[thumbs] worker error:', e.message); for (const p of pending.values()) p(null); pending.clear(); worker = null; });
  worker.on('exit', () => { worker = null; });
  return worker;
}

// Resolves to a data URL thumbnail, or null if one can't be made. Never throws.
function makeThumb(dataUrl, maxPx = THUMB_PX) {
  if (!dataUrl || typeof dataUrl !== 'string') return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    try { getWorker().postMessage({ id, dataUrl, maxPx }); } catch (e) { pending.delete(id); resolve(null); }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 20000).unref();
  });
}

module.exports = { makeThumb, makeThumbSync, THUMB_PX };
