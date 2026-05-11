// Compress the source GLB with Draco so it fits in static hosting limits.
// Reads from ../streamerpronto.glb (the Blender export) and writes
// public/media/streamerpronto.glb (Draco-compressed).
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'gltf-pipeline';
const { processGlb } = pkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, '..', 'streamerpronto.glb');
const OUT = resolve(ROOT, 'public', 'media', 'streamerpronto.glb');

mkdirSync(dirname(OUT), { recursive: true });

const inSize = statSync(SRC).size;
console.log('input :', SRC, `(${(inSize / 1024 / 1024).toFixed(1)} MB)`);

const glb = readFileSync(SRC);

const options = {
  dracoOptions: {
    compressionLevel: 7,           // 0-10, higher = smaller + slower decode
    quantizePositionBits: 14,
    quantizeNormalBits: 10,
    quantizeTexcoordBits: 12,
    quantizeColorBits: 8,
    quantizeGenericBits: 12,
    unifiedQuantization: false,
  },
};

console.log('compressing with Draco — this can take 1–3 minutes for big files...');
const t0 = Date.now();
const result = await processGlb(glb, options);
const t1 = Date.now();

writeFileSync(OUT, result.glb);
const outSize = statSync(OUT).size;
console.log('output:', OUT, `(${(outSize / 1024 / 1024).toFixed(1)} MB)`);
console.log(`saved ${(100 * (1 - outSize / inSize)).toFixed(1)}% in ${((t1 - t0) / 1000).toFixed(1)}s`);
