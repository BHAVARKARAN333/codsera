/**
 * Script to generate professional high-resolution AI IDE icon assets (PNG and ICO)
 * using pure Node.js (built-in zlib) and resedit.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const resedit = require('resedit');

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function renderPixel(u, v, pixelSize) {
  // Normalize coordinates: center is (0, 0), span [-1, 1]
  const nx = (u - 0.5) * 2;
  const ny = (v - 0.5) * 2;

  // 1. Rounded rectangle background
  const halfW = 0.82;
  const halfH = 0.82;
  const radius = 0.24;
  const qx = Math.abs(nx) - (halfW - radius);
  const qy = Math.abs(ny) - (halfH - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  const dBox = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;

  // Background coverage with anti-aliasing
  const boxAlpha = clamp(0.5 - dBox / pixelSize, 0, 1);
  if (boxAlpha <= 0) {
    return [0, 0, 0, 0];
  }

  // Gradient background: dark indigo-slate
  // Top-left: rgb(26, 30, 48), Bottom-right: rgb(13, 14, 22)
  const gradT = (nx + ny + 2) / 4;
  let bgR = Math.round(13 + (26 - 13) * (1 - gradT));
  let bgG = Math.round(15 + (30 - 15) * (1 - gradT));
  let bgB = Math.round(24 + (48 - 24) * (1 - gradT));

  // Subtle inner glowing border
  const borderThickness = 0.035;
  if (dBox > -borderThickness && dBox <= 0) {
    const borderFactor = clamp(1 - Math.abs(dBox + borderThickness / 2) / (borderThickness / 2), 0, 1);
    // Cyan to purple border gradient
    const bGrad = (nx + 1) / 2;
    const borderR = 56 + (140 - 56) * bGrad;
    const borderG = 189 + (90 - 189) * bGrad;
    const borderB = 248 + (248 - 248) * bGrad;

    bgR = Math.round(bgR * (1 - borderFactor * 0.7) + borderR * (borderFactor * 0.7));
    bgG = Math.round(bgG * (1 - borderFactor * 0.7) + borderG * (borderFactor * 0.7));
    bgB = Math.round(bgB * (1 - borderFactor * 0.7) + borderB * (borderFactor * 0.7));
  }

  let finalR = bgR;
  let finalG = bgG;
  let finalB = bgB;
  let finalA = 1;

  // 2. Left Chevron (<) - Cyan: rgb(56, 189, 248)
  const dChevL1 = distToSegment(nx, ny, -0.28, -0.38, -0.58, 0);
  const dChevL2 = distToSegment(nx, ny, -0.58, 0, -0.28, 0.38);
  const dChevL = Math.min(dChevL1, dChevL2);
  const chevLAlpha = clamp(0.5 - (dChevL - 0.055) / pixelSize, 0, 1);

  if (chevLAlpha > 0) {
    finalR = finalR * (1 - chevLAlpha) + 56 * chevLAlpha;
    finalG = finalG * (1 - chevLAlpha) + 189 * chevLAlpha;
    finalB = finalB * (1 - chevLAlpha) + 248 * chevLAlpha;
  }

  // 3. Right Chevron (>) - Violet: rgb(168, 85, 247)
  const dChevR1 = distToSegment(nx, ny, 0.28, -0.38, 0.58, 0);
  const dChevR2 = distToSegment(nx, ny, 0.58, 0, 0.28, 0.38);
  const dChevR = Math.min(dChevR1, dChevR2);
  const chevRAlpha = clamp(0.5 - (dChevR - 0.055) / pixelSize, 0, 1);

  if (chevRAlpha > 0) {
    finalR = finalR * (1 - chevRAlpha) + 168 * chevRAlpha;
    finalG = finalG * (1 - chevRAlpha) + 85 * chevRAlpha;
    finalB = finalB * (1 - chevRAlpha) + 247 * chevRAlpha;
  }

  // 4. Center AI Spark / Star - 4-pointed star
  // Parametric star curve: (|nx|^0.6 + |ny|^0.6)
  const starScale = 3.6;
  const sx = Math.abs(nx) * starScale;
  const sy = Math.abs(ny) * starScale;
  const starDist = Math.pow(sx, 0.6) + Math.pow(sy, 0.6);
  const dStar = (starDist - 1.0) / starScale;
  const starAlpha = clamp(0.5 - dStar / (pixelSize * 1.5), 0, 1);

  if (starAlpha > 0) {
    // Center glowing core
    const coreDist = Math.hypot(nx, ny);
    const coreGlow = clamp(1 - coreDist / 0.15, 0, 1);

    const sR = 180 + (255 - 180) * coreGlow;
    const sG = 220 + (255 - 220) * coreGlow;
    const sB = 255;

    finalR = finalR * (1 - starAlpha) + sR * starAlpha;
    finalG = finalG * (1 - starAlpha) + sG * starAlpha;
    finalB = finalB * (1 - starAlpha) + sB * starAlpha;
  }

  return [Math.round(finalR), Math.round(finalG), Math.round(finalB), Math.round(boxAlpha * 255)];
}

function createPng(width, height) {
  const bytesPerPixel = 4;
  const scanlineLength = 1 + width * bytesPerPixel;
  const rawData = Buffer.alloc(height * scanlineLength);
  const pixelSize = 2.0 / Math.min(width, height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength;
    rawData[rowOffset] = 0; // Filter None
    const v = (y + 0.5) / height;

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const pxOffset = rowOffset + 1 + x * bytesPerPixel;
      const [r, g, b, a] = renderPixel(u, v, pixelSize);
      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  const deflated = zlib.deflateSync(rawData);

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(4 + 4 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 'ascii');
    data.copy(buf, 8);
    const crc = zlib.crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', deflated),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function createIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(count, 4); // count

  let offset = 6 + count * 16;
  const entries = [];
  const datas = [];

  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
    entry.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(img.data.length, 8); // size
    entry.writeUInt32LE(offset, 12); // offset

    entries.push(entry);
    datas.push(img.data);
    offset += img.data.length;
  }

  return Buffer.concat([header, ...entries, ...datas]);
}

async function main() {
  const buildDir = path.resolve(__dirname, '../build');
  await fs.promises.mkdir(buildDir, { recursive: true });

  console.log('[IconGenerator] Rendering AI IDE icon assets...');

  // Standard Windows icon dimensions
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];

  for (const size of icoSizes) {
    const pngBuf = createPng(size, size);
    images.push({ width: size, height: size, data: pngBuf });
  }

  // 1. Build multi-resolution .ico file
  const icoBuffer = createIco(images);

  // Validate with resedit to ensure 100% binary compatibility with Windows PE & electron-builder
  const parsed = resedit.Data.IconFile.from(icoBuffer);
  console.log(`[IconGenerator] Validated with resedit: contains ${parsed.icons.length} valid icon entries.`);

  const icoPath = path.join(buildDir, 'icon.ico');
  await fs.promises.writeFile(icoPath, icoBuffer);
  console.log(`[IconGenerator] Written: ${icoPath} (${icoBuffer.length} bytes)`);

  // 2. Write 512x512 high-resolution icon.png
  const highResPng = createPng(512, 512);
  const pngPath = path.join(buildDir, 'icon.png');
  await fs.promises.writeFile(pngPath, highResPng);
  console.log(`[IconGenerator] Written: ${pngPath} (${highResPng.length} bytes)`);

  console.log('[IconGenerator] Icon generation complete!');
}

main().catch((err) => {
  console.error('[IconGenerator] Error:', err);
  process.exit(1);
});
