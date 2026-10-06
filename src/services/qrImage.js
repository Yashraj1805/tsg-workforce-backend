// Decode a QR code from a photo (fallback for the Aadhaar Secure QR, BRD R04). The
// Secure QR is very dense; a phone's live scanner often can't lock onto it from a printed
// card, but a full-resolution still photo usually can be read. The app first tries ML Kit
// on the photo on the phone; this is the second attempt, on the server, with jsQR.
const jpeg = require('jpeg-js');
const jsQR = require('jsqr');

// Nearest-neighbour downscale of an RGBA buffer (jsQR finds dense codes more reliably at
// moderate sizes than on a 12 MP frame).
function downscale(img, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  if (scale === 1) return img;
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// Returns the QR text, or null if no QR could be read.
function decodeQrFromDataUrl(dataUrl) {
  const m = /^data:image\/jpe?g;base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Expected a JPEG photo');
  const raw = jpeg.decode(Buffer.from(m[1], 'base64'), { useTArray: true, maxMemoryUsageInMB: 160, maxResolutionInMP: 20 });
  const full = { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength) };
  for (const size of [1600, 2400, 1200, 900, Math.max(full.width, full.height)]) {
    const img = downscale(full, size);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (code && code.data) return code.data;
  }
  return null;
}

module.exports = { decodeQrFromDataUrl };
