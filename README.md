# damage. — streamer site

Real-time 3D model of a streamer setup, rendered in the browser via Three.js.
Pre-rendered intro video transitions into a live 3D scene.

## Stack

- Three.js (with Draco-compressed GLB)
- Plain HTML/CSS/JS — no framework, no build step
- Local dev server in `scripts/server.mjs` (range requests, no-cache for HTML/JS)

## Local dev

```bash
npm install
npm run serve
# → http://localhost:5173
```

## Rebuilding assets

The repo ships the production assets in `public/media/`. To regenerate them
from the source files at `../streamerpronto.glb`, `../intro video.mp4`, etc:

```bash
npm run convert        # MKV/MP4 → web MP4
node scripts/compress-glb.mjs   # 255MB → 45MB via Draco
node scripts/inspect-glb.mjs    # dump cameras / lights / animations
```

## Deploy

Static deployment on Vercel — see `vercel.json` for cache headers. The whole
`public/` directory is the output; no build step required.
