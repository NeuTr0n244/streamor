// Minimal static file server with HTTP range support (for video) and
// proper MIME for .glb. No external deps.
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const MEDIA_DIR = resolve(PUBLIC_DIR, 'media');

// Stage the GLB into /public/media so it's served from a single root.
// Files this big shouldn't be copied; symlink would be ideal but Windows
// usually requires admin. Cheap fallback: pass through from the source.
const SRC_GLB = resolve(ROOT, '..', 'streamerpronto.glb');
const PUB_GLB = resolve(MEDIA_DIR, 'streamerpronto.glb');
mkdirSync(MEDIA_DIR, { recursive: true });
let glbPath = PUB_GLB;
if (!existsSync(PUB_GLB)) {
  // Don't copy 266MB. Just keep a registry: when /media/streamerpronto.glb is
  // requested, serve it from SRC_GLB.
  glbPath = SRC_GLB;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.glb':  'model/gltf-binary',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

const PORT = parseInt(process.env.PORT || '5173', 10);

function safeJoin(base, rel) {
  const p = normalize(join(base, rel)).replace(/\\/g, '/');
  const b = base.replace(/\\/g, '/');
  if (!p.startsWith(b)) return null;
  return p;
}

createServer((req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const rel = url === '/' ? '/index.html' : url;

    let filePath;
    if (rel === '/media/streamerpronto.glb') {
      filePath = glbPath;
    } else {
      filePath = safeJoin(PUBLIC_DIR, rel);
    }

    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found: ' + rel);
    }

    const st = statSync(filePath);
    if (st.isDirectory()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('forbidden');
    }

    const type = TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const total = st.size;
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        const len = (end - start) + 1;
        const noCacheRange = type.startsWith('text/') || type.startsWith('application/json');
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': len,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': noCacheRange ? 'no-store' : 'public, max-age=3600',
        });
        return createReadStream(filePath, { start, end }).pipe(res);
      }
    }

    // During dev: never cache HTML/CSS/JS/JSON. Cache big media only.
    const noCache = type.startsWith('text/') || type.startsWith('application/json');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': noCache ? 'no-store' : 'public, max-age=3600',
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('server error');
  }
}).listen(PORT, () => {
  console.log(`streamer site running at http://localhost:${PORT}`);
  console.log(`  public dir: ${PUBLIC_DIR}`);
  console.log(`  glb served from: ${glbPath}`);
});
