// Convert source MKV/MP4 → web-friendly MP4 so browsers can play them.
// If the source is already MP4 we just copy it (avoid double compression).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_DIR = resolve(ROOT, '..');
const OUT_DIR = resolve(ROOT, 'public', 'media');
mkdirSync(OUT_DIR, { recursive: true });

// For each job: pick the freshest source matching the regex.
// This way the script keeps working when Blender bumps the frame count
// (e.g. zoomvideo0001-0105.mkv → zoomvideo0001-0143.mp4).
const JOBS = [
  { match: /^(streamervideo|intro\s*video|intro)/i,  out: 'intro.mp4' },
  { match: /^(zoomvideo|zoom)/i,                       out: 'zoom.mp4'  },
];

function findSource(regex) {
  const candidates = readdirSync(SRC_DIR)
    .filter((f) => /\.(mkv|mp4|mov)$/i.test(f) && regex.test(f))
    .map((f) => ({ f, mtime: statSync(resolve(SRC_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.f;
}

// Force-rebuild if --force is passed (since the source files changed).
const FORCE = process.argv.includes('--force');

for (const job of JOBS) {
  const srcName = findSource(job.match);
  if (!srcName) {
    console.warn('skip — no source matching', job.match, 'in', SRC_DIR);
    continue;
  }
  const src = resolve(SRC_DIR, srcName);
  const out = resolve(OUT_DIR, job.out);
  const srcMtime = statSync(src).mtimeMs;

  if (!FORCE && existsSync(out)) {
    const outMtime = statSync(out).mtimeMs;
    if (outMtime >= srcMtime && statSync(out).size > 0) {
      console.log('up-to-date:', out, '(from', srcName, ')');
      continue;
    }
    unlinkSync(out);
  }

  // If the source is already MP4, skip re-encode (no double compression):
  // copy it directly. Otherwise transcode MKV/MOV → MP4 H.264.
  if (extname(src).toLowerCase() === '.mp4') {
    console.log('copying (already mp4)', srcName, '→', job.out);
    copyFileSync(src, out);

    // Ensure +faststart so the browser can start playback before fully
    // downloading. If already faststart, this is a no-op rewrite, but
    // it's a one-time cost and lets us serve the file efficiently.
    const tmp = out + '.tmp.mp4';
    const r2 = spawnSync(ffmpegPath, [
      '-y', '-i', out,
      '-c', 'copy',
      '-movflags', '+faststart',
      tmp,
    ], { stdio: 'inherit' });
    if (r2.status === 0 && existsSync(tmp)) {
      unlinkSync(out);
      copyFileSync(tmp, out);
      unlinkSync(tmp);
    }
    continue;
  }

  console.log('converting', srcName, '→', job.out);
  const args = [
    '-y',
    '-i', src,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'slow',     // better compression at same quality
    '-crf', '14',          // visually lossless (lower = higher quality)
    '-tune', 'film',
    '-movflags', '+faststart',
    '-an',
    out,
  ];
  const r = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('ffmpeg failed for', srcName);
    process.exit(r.status ?? 1);
  }
}

console.log('all done.');
