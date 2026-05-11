// Detect when the camera/zoom motion starts in the video.
// Strategy: render small grayscale frames with ffmpeg, compare consecutive
// frames, find the first sustained spike of motion. Save the result so the
// front-end knows where to pause.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, '..', 'streamervideo0001-0273.mkv');
const FRAMES_DIR = resolve(ROOT, '.cache', 'frames');
const OUT_JSON = resolve(ROOT, 'public', 'media', 'video-info.json');

mkdirSync(FRAMES_DIR, { recursive: true });
mkdirSync(dirname(OUT_JSON), { recursive: true });

// 1) Probe the video for fps + duration
const probe = spawnSync(ffprobeStatic.path, [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-show_entries', 'stream=r_frame_rate,nb_frames,duration,width,height',
  '-of', 'json',
  SRC,
], { encoding: 'utf8' });

if (probe.status !== 0) {
  console.error(probe.stderr);
  process.exit(probe.status ?? 1);
}

const info = JSON.parse(probe.stdout).streams[0];
const [n, d] = info.r_frame_rate.split('/').map(Number);
const fps = n / d;
const duration = parseFloat(info.duration);
const nbFrames = parseInt(info.nb_frames, 10) || Math.round(duration * fps);
console.log(`fps=${fps} duration=${duration}s frames=${nbFrames}`);

// 2) Extract small grayscale PGM frames (fast to read, no decoders needed)
const SCALE = 64; // tiny — we just want motion delta
const r = spawnSync(ffmpegPath, [
  '-y',
  '-i', SRC,
  '-vf', `scale=${SCALE}:-1,format=gray`,
  '-f', 'image2',
  '-pix_fmt', 'gray',
  join(FRAMES_DIR, 'f%04d.pgm'),
], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);

const files = readdirSync(FRAMES_DIR).filter(f => f.endsWith('.pgm')).sort();

function readPgm(path) {
  // Minimal P5 PGM parser
  const buf = readFileSync(path);
  // Parse header: P5\n<w> <h>\n<maxval>\n<binary>
  let i = 0;
  function readToken() {
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0A || buf[i] === 0x0D || buf[i] === 0x09)) i++;
    const start = i;
    while (i < buf.length && buf[i] !== 0x20 && buf[i] !== 0x0A && buf[i] !== 0x0D && buf[i] !== 0x09) i++;
    return buf.slice(start, i).toString('ascii');
  }
  const magic = readToken();
  if (magic !== 'P5') throw new Error('not P5: ' + magic);
  const w = parseInt(readToken(), 10);
  const h = parseInt(readToken(), 10);
  const max = parseInt(readToken(), 10);
  // skip single whitespace after maxval
  i++;
  return { w, h, max, data: buf.slice(i) };
}

// 3) Compute mean abs difference between consecutive frames
const diffs = [];
let prev = null;
for (const f of files) {
  const img = readPgm(join(FRAMES_DIR, f));
  if (prev) {
    let s = 0;
    const a = prev.data, b = img.data;
    const len = Math.min(a.length, b.length);
    for (let k = 0; k < len; k++) s += Math.abs(a[k] - b[k]);
    diffs.push(s / len);
  } else {
    diffs.push(0);
  }
  prev = img;
}

// 4) Find zoom start: the first frame where motion stays elevated.
// Use a baseline = median of first 20% of frames; spike when diff > baseline * threshold for >= W frames.
const baselineWindow = diffs.slice(1, Math.max(5, Math.floor(diffs.length * 0.2)));
const sorted = [...baselineWindow].sort((a, b) => a - b);
const baseline = sorted[Math.floor(sorted.length / 2)] || 0.5;
const THRESH = Math.max(baseline * 2.5, baseline + 0.8);
const SUSTAIN = 4;

let zoomStartFrame = -1;
for (let k = 0; k < diffs.length - SUSTAIN; k++) {
  let ok = true;
  for (let j = 0; j < SUSTAIN; j++) {
    if (diffs[k + j] < THRESH) { ok = false; break; }
  }
  if (ok) { zoomStartFrame = k; break; }
}

// Fallback: if nothing detected, pause at 90% of duration
if (zoomStartFrame < 0) {
  zoomStartFrame = Math.floor(diffs.length * 0.9);
  console.log('No clear zoom spike found, falling back to 90%');
}

// Pause a little BEFORE the zoom starts (give a few frames buffer)
const PAUSE_BUFFER_FRAMES = 2;
const pauseFrame = Math.max(0, zoomStartFrame - PAUSE_BUFFER_FRAMES);
const pauseTime = pauseFrame / fps;

const out = {
  fps,
  duration,
  totalFrames: diffs.length,
  zoomStartFrame,
  pauseFrame,
  pauseTime,
  baseline,
  threshold: THRESH,
};
writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
console.log('Wrote', OUT_JSON);
console.log(out);
