// Read a GLB file and report its cameras and lights (KHR_lights_punctual).
// Pure binary parsing — no extra deps.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, '..', 'streamerpronto.glb');
const OUT = resolve(ROOT, 'public', 'media', 'glb-info.json');
mkdirSync(dirname(OUT), { recursive: true });

const buf = readFileSync(SRC);
// GLB header
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb');
const length = buf.readUInt32LE(8);

// First chunk is JSON
let off = 12;
const jsonLen = buf.readUInt32LE(off); off += 4;
const jsonType = buf.readUInt32LE(off); off += 4;
if (jsonType !== 0x4e4f534a) throw new Error('first chunk not JSON');
const json = JSON.parse(buf.slice(off, off + jsonLen).toString('utf8'));

const cameras = json.cameras ?? [];
const lights = json.extensions?.KHR_lights_punctual?.lights ?? [];
const nodes = json.nodes ?? [];

// Walk nodes to compute world transforms
function mat4Identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function mat4Mul(a, b) {
  const r = new Array(16);
  for (let i=0;i<4;i++) for (let j=0;j<4;j++) {
    r[i*4+j] = a[i*4+0]*b[0*4+j] + a[i*4+1]*b[1*4+j] + a[i*4+2]*b[2*4+j] + a[i*4+3]*b[3*4+j];
  }
  return r;
}
function trsToMat(t, r, s) {
  // r is quaternion [x,y,z,w]
  const [tx,ty,tz] = t ?? [0,0,0];
  const [qx,qy,qz,qw] = r ?? [0,0,0,1];
  const [sx,sy,sz] = s ?? [1,1,1];
  const x2=qx+qx, y2=qy+qy, z2=qz+qz;
  const xx=qx*x2, xy=qx*y2, xz=qx*z2;
  const yy=qy*y2, yz=qy*z2, zz=qz*z2;
  const wx=qw*x2, wy=qw*y2, wz=qw*z2;
  return [
    (1-(yy+zz))*sx, (xy+wz)*sx,     (xz-wy)*sx,     0,
    (xy-wz)*sy,    (1-(xx+zz))*sy,  (yz+wx)*sy,     0,
    (xz+wy)*sz,    (yz-wx)*sz,      (1-(xx+yy))*sz, 0,
    tx, ty, tz, 1,
  ];
}

// Build parent map
const parent = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => {
  for (const c of n.children ?? []) parent[c] = i;
});

function localMatrix(i) {
  const n = nodes[i];
  if (n.matrix) return n.matrix;
  return trsToMat(n.translation, n.rotation, n.scale);
}

function worldMatrix(i) {
  const chain = [];
  let cur = i;
  while (cur !== -1) { chain.push(cur); cur = parent[cur]; }
  let m = mat4Identity();
  for (let k = chain.length - 1; k >= 0; k--) {
    m = mat4Mul(m, localMatrix(chain[k]));
  }
  return m;
}

const cameraNodes = [];
const lightNodes = [];
nodes.forEach((n, i) => {
  if (typeof n.camera === 'number') {
    const m = worldMatrix(i);
    cameraNodes.push({
      nodeIndex: i,
      name: n.name ?? null,
      cameraIndex: n.camera,
      camera: cameras[n.camera],
      worldMatrix: m,
      worldPosition: [m[12], m[13], m[14]],
    });
  }
  const lp = n.extensions?.KHR_lights_punctual;
  if (lp && typeof lp.light === 'number') {
    const m = worldMatrix(i);
    lightNodes.push({
      nodeIndex: i,
      name: n.name ?? null,
      lightIndex: lp.light,
      light: lights[lp.light],
      worldPosition: [m[12], m[13], m[14]],
    });
  }
});

// Find emissive materials (could be acting as "light")
const materials = json.materials ?? [];
const emissiveMaterials = materials.filter((m) => {
  const ef = m.emissiveFactor;
  const hasFactor = ef && (ef[0] > 0.01 || ef[1] > 0.01 || ef[2] > 0.01);
  const strength = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength;
  return hasFactor || (strength && strength > 0);
}).map((m) => ({
  name: m.name,
  emissiveFactor: m.emissiveFactor,
  emissiveStrength: m.extensions?.KHR_materials_emissive_strength?.emissiveStrength,
}));

// List ALL node names that contain "light", "luz", "lamp", or "key" — case insensitive
const suspiciousNodes = nodes
  .map((n, i) => ({ i, name: n.name }))
  .filter(({ name }) => name && /light|luz|lamp|key|fill|rim|front|frente/i.test(name));

// Animations
const animations = (json.animations ?? []).map((a, i) => {
  // Compute approximate duration from accessor max times in samplers
  let dur = 0;
  for (const s of a.samplers ?? []) {
    const acc = json.accessors?.[s.input];
    if (acc?.max && acc.max[0] > dur) dur = acc.max[0];
  }
  return {
    index: i,
    name: a.name ?? `animation_${i}`,
    channels: a.channels?.length ?? 0,
    samplers: a.samplers?.length ?? 0,
    duration: dur,
    targetPaths: [...new Set((a.channels ?? []).map(c => c.target?.path))],
  };
});

const out = {
  fileSize: buf.length,
  totalLength: length,
  numNodes: nodes.length,
  numMeshes: (json.meshes ?? []).length,
  numMaterials: materials.length,
  numCameras: cameras.length,
  numLights: lights.length,
  cameras,
  lights,
  cameraNodes,
  lightNodes,
  emissiveMaterials,
  suspiciousNodes,
  animations,
  numAnimations: animations.length,
  extensionsUsed: json.extensionsUsed ?? [],
  extensionsRequired: json.extensionsRequired ?? [],
};

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('Wrote', OUT);
console.log({
  cameras: out.numCameras,
  lights: out.numLights,
  meshes: out.numMeshes,
  materials: out.numMaterials,
  nodes: out.numNodes,
  cameraNames: cameraNodes.map(c => c.name),
  lightNames: lightNodes.map(l => `${l.name} (${l.light?.type})`),
  emissiveMaterials: emissiveMaterials.length,
  emissiveMaterialNames: emissiveMaterials.map(e => `${e.name} (factor=${JSON.stringify(e.emissiveFactor)} strength=${e.emissiveStrength ?? 1})`),
  suspiciousNodeNames: suspiciousNodes.map(n => n.name),
  numAnimations: animations.length,
  animations: animations.map(a => `${a.name} (${a.duration.toFixed(2)}s, ${a.channels}ch, paths=[${a.targetPaths.join(',')}])`),
});
