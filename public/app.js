import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const els = {
  stage:   document.getElementById('stage'),
  intro:   document.getElementById('intro'),
  zoom:    document.getElementById('zoom'),
  canvas:  document.getElementById('three'),
  hud:     document.getElementById('hud'),
  enter:   document.getElementById('enter'),
};

const state = {
  // 'intro' → intro video playing; ends → button shows
  // 'zoom'  → zoom video playing (after click); ends → 3D
  // '3d'    → three.js scene
  phase: 'intro',
  introReady: false,
  zoomReady: false,
  glbReady: false,
  three: null,
  activeCameraIndex: 0,
};

// Loader UI removed — video plays immediately, 3D loads silently in background.
function setLoadProgress() {}
function hideLoader() {}

// ----- Video pipeline ----------------------------------------------------

function pinToLastFrame(v) {
  // Pause and snap to the very last frame so the freeze is visually stable.
  // Clamping to (duration - tinyEpsilon) avoids the browser sometimes
  // rendering nothing when currentTime === duration.
  if (Number.isFinite(v.duration) && v.duration > 0) {
    try { v.currentTime = Math.max(0, v.duration - 1 / 30); } catch {}
  }
}

function initVideos() {
  const intro = els.intro;
  const zoom = els.zoom;

  intro.addEventListener('canplaythrough', () => {
    state.introReady = true;
    maybeStartShow();
  }, { once: true });

  zoom.addEventListener('canplaythrough', () => {
    state.zoomReady = true;
  }, { once: true });

  intro.addEventListener('ended', () => {
    if (state.phase !== 'intro') return;
    intro.pause();
    pinToLastFrame(intro);
    revealEnterButton();
  });

  // Fallback: if the rAF cutoff misses for any reason, the natural end
  // event still triggers the transition.
  zoom.addEventListener('ended', () => {
    if (state.phase !== 'zoom') return;
    zoom.pause();
    pinToLastFrame(zoom);
    transitionToThree();
  });
}

function revealEnterButton() {
  els.hud.classList.remove('hidden');
  els.hud.classList.add('visible');
  els.hud.setAttribute('aria-hidden', 'false');
}

function hideEnterButton() {
  els.hud.classList.remove('visible');
  els.hud.classList.add('hidden');
  els.hud.setAttribute('aria-hidden', 'true');
}

// User clicked ENTRAR → play the zoom video, then transition.
function playZoom() {
  if (state.phase !== 'intro') return;
  state.phase = 'zoom';
  hideEnterButton();

  // Make zoom visible UNDER intro first so the very first frame is decoded
  // and ready, then crossfade.
  els.zoom.classList.remove('hidden');
  const playPromise = els.zoom.play();
  Promise.resolve(playPromise).then(() => {
    requestAnimationFrame(() => {
      els.zoom.classList.add('visible');
      els.intro.classList.add('fade-out');
    });

    // Trigger 3D handoff slightly BEFORE the zoom ends. The video keeps
    // playing under the fading canvas so the cut is hidden inside the
    // crossfade — the user never sees the awkward final frame.
    const v = els.zoom;
    const startHandoff = () => {
      if (state.phase !== 'zoom') return;
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 4.4;
      const CUTOFF_LEAD = 1.6; // seconds before natural end
      const cutoff = Math.max(0.1, dur - CUTOFF_LEAD);
      const tick = () => {
        if (state.phase !== 'zoom') return;
        if (v.currentTime >= cutoff) {
          transitionToThree();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if (Number.isFinite(v.duration)) startHandoff();
    else v.addEventListener('loadedmetadata', startHandoff, { once: true });
  }).catch((err) => {
    console.error('zoom play failed', err);
    transitionToThree();
  });
}

// ----- Three.js pipeline -------------------------------------------------

async function initThree() {
  const renderer = new THREE.WebGLRenderer({
    canvas: els.canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.35;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 1);

  // GLB ships its spot at ~81527 cd (Blender exporter inflates the value).
  // Scale light intensity down to a reasonable cd range — does NOT add any
  // new light, only multiplies what the GLB already had.
  const LIGHT_SCALE = 0.0015;

  const scene = new THREE.Scene();

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  dracoLoader.setDecoderConfig({ type: 'js' });
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  const gltf = await new Promise((res, rej) => {
    loader.load(
      '/media/streamerpronto.glb',
      res,
      (e) => {
        if (e.lengthComputable) {
          const p = 0.05 + (e.loaded / e.total) * 0.95;
          setLoadProgress(p, 'loading 3D');
        }
      },
      rej,
    );
  });

  scene.add(gltf.scene);

  // GLB ships with two animation clips:
  //   • ArmatureAction → character (body+head). LOOP it for idle motion.
  //   • CâmeraAction   → animates the camera node. Skip — we control the
  //                      camera ourselves via cameras[activeCameraIndex].
  let mixer = null;
  const loopingActions = [];
  if (gltf.animations?.length) {
    mixer = new THREE.AnimationMixer(gltf.scene);
    const CAMERA_RX = /(c[âa]mera|camera)/i;
    const allNames = [];
    for (const clip of gltf.animations) {
      allNames.push(`"${clip.name}" (${clip.duration.toFixed(2)}s)`);
      if (CAMERA_RX.test(clip.name)) {
        // Skip — leaving this clip un-played means the camera node keeps
        // its rest-pose transform from the GLB, which is what we want.
        continue;
      }
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      loopingActions.push({ name: clip.name, action });
    }
    console.log(`animations in GLB: ${allNames.join(', ')}`);
    console.log(`looping: ${loopingActions.map(a => a.name).join(', ') || '(none)'}`);
  }

  const glbLights = [];
  scene.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    if (o.isLight) {
      o.castShadow = true;
      if (o.shadow) {
        o.shadow.mapSize.set(2048, 2048);
        o.shadow.bias = -0.0005;
      }
      // Cache the intensity from the GLB so we can rescale interactively.
      o.userData.baseIntensity = o.intensity;
      o.intensity = o.userData.baseIntensity * LIGHT_SCALE;
      glbLights.push(o);
      console.log(`light "${o.name}" type=${o.type} base=${o.userData.baseIntensity.toFixed(0)} → ${o.intensity.toFixed(2)}`);
    }
  });

  // ---------------------------------------------------------------------
  // Restore the missing front fill light using transforms that ARE in the
  // GLB. The Blender export dropped 'Light_Face_Fill' as a light (likely
  // because it was an Area light, not supported by KHR_lights_punctual),
  // but the empty/node still made it in with the intended position.
  //
  // We grab the Light_Face_Fill node + its Spotlight_Target_Face target
  // and rebuild a SpotLight matching the same color/intensity profile as
  // the surviving key light so the look is coherent.
  // ---------------------------------------------------------------------
  // Resolve fill position. The Draco compression step prunes "empty" nodes,
  // and Light_Face_Fill is empty (Blender's Area light didn't export). So
  // in the compressed GLB the node is gone — fall back to the position we
  // captured from the uncompressed source via scripts/inspect-glb.mjs.
  const faceFillNode = gltf.scene.getObjectByName('Light_Face_Fill');
  const faceFillTarget = gltf.scene.getObjectByName('Spotlight_Target_Face');
  let fillPos, fillTarget;
  if (faceFillNode && faceFillTarget) {
    fillPos = faceFillNode.getWorldPosition(new THREE.Vector3());
    fillTarget = faceFillTarget.getWorldPosition(new THREE.Vector3());
    console.log('Light_Face_Fill: using node positions from GLB');
  } else {
    fillPos = new THREE.Vector3(0.12, 2.86, -4.67);
    fillTarget = new THREE.Vector3(0.12, 2.96, -3.48);
    console.log('Light_Face_Fill: nodes pruned, using hardcoded source positions');
  }

  {
    const keyLight = glbLights.find((l) => l.name === 'Light_Top_KeyFocus') || glbLights[0];
    const refColor = keyLight ? keyLight.color.clone() : new THREE.Color(0xffe5cc);
    const refBase = keyLight ? keyLight.userData.baseIntensity : 60000;

    // Wide soft fill — broader cone, heavy penumbra, lower intensity than key.
    const fill = new THREE.SpotLight(refColor, 0, 0, Math.PI / 3, 0.9, 1);
    fill.name = 'Light_Face_Fill_Reconstructed';
    fill.userData.baseIntensity = refBase * 0.18;
    fill.intensity = fill.userData.baseIntensity * LIGHT_SCALE;

    scene.add(fill);
    scene.add(fill.target);
    fill.position.copy(fillPos);
    fill.target.position.copy(fillTarget);

    fill.castShadow = true;
    fill.shadow.mapSize.set(1024, 1024);
    fill.shadow.bias = -0.0005;

    glbLights.push(fill);
    console.log(`reconstructed Light_Face_Fill at ${fillPos.toArray().map(n => n.toFixed(2))} → ${fillTarget.toArray().map(n => n.toFixed(2))}`);
  }

  const cameras = gltf.cameras ?? [];
  if (!cameras.length) throw new Error('GLB has no cameras');
  cameras.forEach((c) => c.updateMatrixWorld(true));

  // 'Camera' (index 0) is the front-of-character shot when the animation
  // is at its end pose. 'Câmera' is the wide cinematic side shot.
  const preferOrder = ['Camera', 'Câmera'];
  let preferredIdx = -1;
  for (const name of preferOrder) {
    preferredIdx = cameras.findIndex((c) => c.name === name);
    if (preferredIdx >= 0) break;
  }
  state.activeCameraIndex = preferredIdx >= 0 ? preferredIdx : 0;

  const ranked = cameras.map((cam, i) => ({
    i, cam, name: cam.name || `Camera ${i}`,
  }));

  // Render camera — its position/quaternion/fov get tweened between the GLB
  // cameras when SOBRE is opened/closed.
  const renderCam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  scene.add(renderCam);

  const updateCameraAspect = () => {
    const w = els.canvas.clientWidth;
    const h = els.canvas.clientHeight;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    cameras.forEach((c) => {
      if (c.isPerspectiveCamera) {
        c.aspect = aspect;
        c.updateProjectionMatrix();
      }
    });
    renderCam.aspect = aspect;
    renderCam.updateProjectionMatrix();
  };
  updateCameraAspect();
  window.addEventListener('resize', updateCameraAspect);

  // Snap renderCam to the active GLB camera. Note: Three.js's
  // PerspectiveCamera.fov is already in DEGREES (GLTFLoader converts it
  // from glTF's radians on load) — do NOT convert again.
  function snapRenderCamTo(cam) {
    cam.updateMatrixWorld(true);
    renderCam.position.setFromMatrixPosition(cam.matrixWorld);
    renderCam.quaternion.setFromRotationMatrix(cam.matrixWorld);
    renderCam.fov = cam.fov;
    renderCam.updateProjectionMatrix();
  }
  snapRenderCamTo(cameras[state.activeCameraIndex]);

  state.three = { renderer, scene, gltf, cameras, ranked, mixer, renderCam, loopingActions };
  state.glbReady = true;

  // ----- Live tuning ------------------------------------------------------
  // [ / ]  = exposure ↓ / ↑      (\)  = reset exposure to 1.0
  // ; / '  = light scale ↓ / ↑   (#)  = reset light scale to default
  let lightScale = LIGHT_SCALE;
  const setExposure = (e) => {
    renderer.toneMappingExposure = Math.max(0.001, e);
    console.log('exposure:', renderer.toneMappingExposure.toFixed(3));
  };
  const setLightScale = (s) => {
    lightScale = Math.max(0.0001, s);
    glbLights.forEach((l) => { l.intensity = l.userData.baseIntensity * lightScale; });
    console.log('light scale:', lightScale.toFixed(5));
  };
  window.addEventListener('keydown', (e) => {
    if      (e.key === '[')  setExposure(renderer.toneMappingExposure * 0.85);
    else if (e.key === ']')  setExposure(renderer.toneMappingExposure / 0.85);
    else if (e.key === '\\') setExposure(0.35);
    else if (e.key === ';')  setLightScale(lightScale * 0.75);
    else if (e.key === "'")  setLightScale(lightScale / 0.75);
    else if (e.key === '#')  setLightScale(LIGHT_SCALE);
  });

  // ----- Click inspector --------------------------------------------------
  // Click any mesh in 3D mode → log mesh + material name + size to console.
  // Used to identify which materials the monitor screens use so we can
  // swap their textures.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  els.canvas.addEventListener('click', (e) => {
    if (state.phase !== '3d') return;
    if (state.three.aboutOpen) return;
    const rect = els.canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, renderCam);
    const hits = raycaster.intersectObject(gltf.scene, true);
    if (!hits.length) {
      console.log('[inspector] no mesh under click');
      return;
    }
    const hit = hits[0];
    const mat = hit.object.material;
    const matNames = Array.isArray(mat) ? mat.map(m => m.name).join(' | ') : mat.name;
    const box = new THREE.Box3().setFromObject(hit.object);
    const size = box.getSize(new THREE.Vector3());
    console.log('[inspector]', {
      mesh: hit.object.name,
      material: matNames,
      size: size.toArray().map(n => n.toFixed(2)),
      distance: hit.distance.toFixed(2),
    });
  });

  // ----- About / camera tween -----------------------------------------
  // Two named cameras drive the experience: 'Camera' = close hero shot,
  // 'Câmera' = wide cinematic shot used when the SOBRE panel is open.
  const camHero = cameras.find((c) => c.name === 'Camera') || cameras[0];
  const camWide = cameras.find((c) => c.name === 'Câmera') || cameras[1] || cameras[0];

  state.three.aboutOpen = false;
  state.three.tween = null; // { from, to, t0, dur, onDone }

  function startCameraTween(targetCam, dur = 1500) {
    targetCam.updateMatrixWorld(true);
    camHero.updateMatrixWorld(true);

    const fromPos = renderCam.position.clone();
    const fromQuat = renderCam.quaternion.clone();
    const fromFov = renderCam.fov;

    const toPos = new THREE.Vector3().setFromMatrixPosition(targetCam.matrixWorld);
    const toQuat = new THREE.Quaternion().setFromRotationMatrix(targetCam.matrixWorld);
    const toFov = targetCam.fov; // already in degrees

    state.three.tween = { fromPos, fromQuat, fromFov, toPos, toQuat, toFov, t0: performance.now(), dur };
  }

  const aboutBtn = document.getElementById('about-btn');
  const aboutPanel = document.getElementById('about-panel');
  const aboutClose = aboutPanel.querySelector('.close');

  function openAbout() {
    if (state.three.aboutOpen) return;
    state.three.aboutOpen = true;
    aboutPanel.classList.add('open');
    aboutPanel.setAttribute('aria-hidden', 'false');
    aboutBtn.classList.remove('visible');
    // Freeze the looping body animation on a stable end-pose frame so the
    // wide cinematic shot doesn't catch the character mid-loop in an
    // awkward position.
    state.three.loopingActions?.forEach(({ action }) => {
      action.paused = true;
      action.time = action.getClip().duration;
    });
    if (state.three.mixer) state.three.mixer.update(0);
    startCameraTween(camWide);
  }
  function closeAbout() {
    if (!state.three.aboutOpen) return;
    state.three.aboutOpen = false;
    aboutPanel.classList.remove('open');
    aboutPanel.setAttribute('aria-hidden', 'true');
    aboutBtn.classList.add('visible');
    // Resume the looping body animation.
    state.three.loopingActions?.forEach(({ action }) => {
      action.paused = false;
    });
    startCameraTween(camHero);
  }
  aboutBtn.addEventListener('click', openAbout);
  aboutClose.addEventListener('click', closeAbout);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.three.aboutOpen) closeAbout();
  });
  state.three.aboutBtn = aboutBtn;

  maybeStartShow();
  // If the user already finished the zoom while the GLB was still loading,
  // the transition was queued — fire it now.
  if (state.queuedTransition) {
    state.queuedTransition = false;
    transitionToThree();
  }
}

const clock = new THREE.Clock();
// easeInOutCubic — slow-in / slow-out, natural for camera moves.
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function renderLoop() {
  const { renderer, scene, mixer, renderCam, tween } = state.three;
  const dt = clock.getDelta();
  if (mixer) mixer.update(dt);

  if (tween) {
    const raw = Math.min(1, (performance.now() - tween.t0) / tween.dur);
    const t = easeInOutCubic(raw);
    renderCam.position.lerpVectors(tween.fromPos, tween.toPos, t);
    renderCam.quaternion.copy(tween.fromQuat).slerp(tween.toQuat, t);
    renderCam.fov = tween.fromFov + (tween.toFov - tween.fromFov) * t;
    renderCam.updateProjectionMatrix();
    if (raw >= 1) state.three.tween = null;
  }

  renderer.render(scene, renderCam);
  requestAnimationFrame(renderLoop);
}

// ----- Orchestration -----------------------------------------------------

function maybeStartShow() {
  // Start the video as soon as it's ready. GLB keeps loading silently in
  // background — by the time the user clicks the button, it's almost
  // always ready. If not, transitionToThree() queues the handoff.
  if (!state.introReady || state.introStarted) return;
  state.introStarted = true;
  els.intro.play().catch(() => {
    // Autoplay blocked — show button to let the user start manually.
    revealEnterButton();
    els.enter.querySelector('.label').textContent = 'start';
    els.enter.addEventListener('click', () => {
      if (state.phase === 'intro' && els.intro.paused && els.intro.currentTime < 0.05) {
        hideEnterButton();
        els.enter.querySelector('.label').textContent = 'enter';
        els.intro.play();
      }
    }, { once: true });
  });
}

function transitionToThree() {
  if (state.phase === '3d') return;
  if (!state.three) {
    // 3D still loading — queue the handoff and bail. initThree() will
    // call us again once the GLB is ready.
    state.queuedTransition = true;
    return;
  }
  state.phase = '3d';

  hideEnterButton();

  // Render one frame of the 3D scene first so the canvas isn't blank when
  // it starts fading in.
  const { renderer, scene, cameras } = state.three;
  renderer.render(scene, cameras[state.activeCameraIndex]);
  renderLoop();

  const FADE_MS = 1500;

  // Make canvas a transition target with starting opacity 0.
  els.canvas.classList.remove('hidden');
  els.canvas.classList.add('handoff-in');
  void els.canvas.offsetWidth;
  els.canvas.classList.add('visible');

  // Crossfade videos out — zoom keeps playing under the fading canvas, so
  // the awkward final frames stay hidden inside the transition.
  els.zoom.classList.add('handoff-out');
  els.intro.classList.add('handoff-out');

  setTimeout(() => {
    [els.intro, els.zoom].forEach((v) => {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.style.display = 'none';
    });
    if (state.three.aboutBtn) state.three.aboutBtn.classList.add('visible');
  }, FADE_MS + 50);
}

// ----- Boot --------------------------------------------------------------

(async function boot() {
  setLoadProgress(0.05, 'loading video');
  initVideos();

  initThree().catch((err) => {
    console.error(err);
    els.loaderLbl.textContent = 'failed to load 3D';
  });

  els.enter.addEventListener('click', () => {
    if (state.phase === 'intro') playZoom();
  });
})();
