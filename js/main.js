import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { WebXRController } from './ar.js';
import { FallbackController } from './fallback.js';
import {
  attachDepthOcclusion,
  buildBowlingAlley,
  createBallContactShadow,
  createBallMesh,
  createReticleGroup,
} from './laneBuilder.js';
import { calculateStars, fetchLevels, loadProgress, saveProgress } from './levels.js';
import {
  APPROACH_LENGTH,
  BALL_RADIUS,
  BALL_SPAWN_Z,
  BowlingPhysics,
  GUTTER_FLOOR_Y,
  LANE_LENGTH,
  LANE_SURFACE_Y,
  LANE_WIDTH,
  PIT_DEPTH,
  PIT_FLOOR_Y,
} from './physics.js';
import { SoundFX, triggerHaptic, UIController } from './ui.js';

const ui = new UIController();
const progress = loadProgress();
const sound = new SoundFX(progress.muted);
ui.setMuteIcon(progress.muted);

const videoEl = document.getElementById('video');
const canvasEl = document.getElementById('canvas');
const uiRootEl = document.getElementById('ui');

// Detect software WebGL cleanly
const isSoftwareGl = (() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
})();

// Three.js Renderer, Scene & Camera
const renderer = new THREE.WebGLRenderer({
  canvas: canvasEl,
  alpha: true,
  antialias: !isSoftwareGl,
  powerPreference: 'high-performance',
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.05,
  50
);
renderer.shadowMap.enabled = !isSoftwareGl;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// Neutral indoor studio reflections
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.85;
pmrem.dispose();

// Lighting rig (driven dynamically by WebXR Light Estimation or Video Room Sampling)
const hemiLight = new THREE.HemisphereLight(0xffffff, 0xd8cbb8, 0.85);
scene.add(hemiLight);

const xrLightProbe = new THREE.LightProbe();
xrLightProbe.intensity = 0;
scene.add(xrLightProbe);

const keyLight = new THREE.DirectionalLight(0xfff8f0, 1.35);
keyLight.position.set(2.2, 5.2, 1.8);
keyLight.castShadow = !isSoftwareGl;
keyLight.shadow.mapSize.set(isSoftwareGl ? 512 : 2048, isSoftwareGl ? 512 : 2048);
keyLight.shadow.radius = 3.5;
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 20;
const d = 4.6;
keyLight.shadow.camera.left = -d;
keyLight.shadow.camera.right = d;
keyLight.shadow.camera.top = d;
keyLight.shadow.camera.bottom = -d;
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);
scene.add(keyLight.target);

// Shared depth-sensing uniforms (for WebXR occlusion)
const fallbackDepthTex = new THREE.DataTexture(new Uint8Array([0, 0]), 1, 1, THREE.RGFormat);
fallbackDepthTex.needsUpdate = true;

const depthUniforms = {
  uDepthMap: { value: fallbackDepthTex },
  uDepthNormMatrix: { value: new THREE.Matrix4() },
  uRawValueToMeters: { value: 0.001 },
  uHasDepth: { value: 0.0 },
  uDepthIsFloat: { value: 0.0 },
  uViewportSize: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
};

// Dark floor for Desktop Preview Mode
const previewFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(32, 32),
  new THREE.MeshStandardMaterial({ color: 0x1f1f1f, roughness: 0.9, metalness: 0.0 })
);
previewFloor.rotation.x = -Math.PI / 2;
previewFloor.position.y = -0.003;
previewFloor.receiveShadow = true;
previewFloor.visible = false;
scene.add(previewFloor);

// Perspective floor search reticle (orange ring + scan dots)
const reticleGroup = createReticleGroup();
reticleGroup.visible = false;
scene.add(reticleGroup);

// Lane root group (origin at foul line z=0 on real floor y=0, pointing -Z)
const laneGroup = new THREE.Group();
laneGroup.visible = false;
scene.add(laneGroup);

// Real-time floor ShadowMaterial catcher around lane + pit
const shadowCatcherMat = new THREE.ShadowMaterial({ opacity: 0.36 });
attachDepthOcclusion(shadowCatcherMat, depthUniforms);
const shadowCatcher = new THREE.Mesh(
  new THREE.PlaneGeometry(3.8, LANE_LENGTH + 2.8),
  shadowCatcherMat
);
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.position.set(0, 0.0005, -1.6);
shadowCatcher.receiveShadow = true;
laneGroup.add(shadowCatcher);

const laneContent = new THREE.Group();
laneGroup.add(laneContent);

const _shadowCenter = new THREE.Vector3();

function syncShadowLight() {
  _shadowCenter.set(0, 0, -1.75).applyMatrix4(laneGroup.matrixWorld);
  keyLight.target.position.copy(_shadowCenter);
  keyLight.position.set(
    _shadowCenter.x + currentLightDir.x * 5.2,
    _shadowCenter.y + Math.max(2.5, currentLightDir.y * 5.6),
    _shadowCenter.z + currentLightDir.z * 5.2
  );
}

let alleyObj = null;
let ballMesh = null;
let ballContactShadow = null;
const dustPuffs = [];
const confettiPieces = [];

function disposeObjectTree(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        if (m.map) m.map.dispose();
        if (m.roughnessMap) m.roughnessMap.dispose();
        m.dispose();
      });
    }
  });
}

function buildLaneAndPins(level, physics) {
  while (laneContent.children.length > 0) {
    const child = laneContent.children.pop();
    disposeObjectTree(child);
  }
  alleyObj = null;

  if (ballMesh) {
    laneGroup.remove(ballMesh);
    disposeObjectTree(ballMesh);
    ballMesh = null;
  }
  if (ballContactShadow) {
    laneGroup.remove(ballContactShadow);
    disposeObjectTree(ballContactShadow);
    ballContactShadow = null;
  }

  while (dustPuffs.length > 0) {
    const p = dustPuffs.pop();
    laneGroup.remove(p.mesh);
    p.mesh.material.dispose();
  }
  while (confettiPieces.length > 0) {
    const c = confettiPieces.pop();
    laneGroup.remove(c.mesh);
    c.mesh.material.dispose();
  }

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  alleyObj = buildBowlingAlley(level, physics, maxAniso, depthUniforms);
  laneContent.add(alleyObj.root);
  ballContactShadow = alleyObj.ballContactShadow;
}

const _dustGeo = new THREE.SphereGeometry(0.022, 6, 6);
const _confettiGeo = new THREE.PlaneGeometry(0.04, 0.022);

function spawnDustPuff(pos) {
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(
      _dustGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
    );
    m.position.set(pos.x, Math.max(LANE_SURFACE_Y + 0.02, pos.y), pos.z);
    laneGroup.add(m);
    dustPuffs.push({
      mesh: m,
      vx: (Math.random() - 0.5) * 0.65,
      vy: 0.3 + Math.random() * 0.4,
      vz: (Math.random() - 0.5) * 0.65,
      life: 0,
    });
  }
}

function spawnConfetti() {
  for (let i = 0; i < 36; i++) {
    const m = new THREE.Mesh(
      _confettiGeo,
      new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xf26b1d : 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
      })
    );
    m.position.set(
      (Math.random() - 0.5) * 0.9,
      LANE_SURFACE_Y + 0.45 + Math.random() * 0.5,
      -3.4 + (Math.random() - 0.5) * 0.6
    );
    laneGroup.add(m);
    confettiPieces.push({
      mesh: m,
      vx: (Math.random() - 0.5) * 1.2,
      vy: 1.2 + Math.random() * 1.2,
      vz: (Math.random() - 0.5) * 1.2,
      rot: (Math.random() - 0.5) * 8,
      life: 0,
    });
  }
}

// Controllers & Game State
const xrCtrl = new WebXRController();
const fallbackCtrl = new FallbackController(videoEl);
const physics = new BowlingPhysics();

let levels = [];
let activeMode = 'none'; // 'webxr' | 'camera' | 'preview'
let state = 'start'; // 'start' | 'scanning' | 'ready' | 'placing' | 'aiming' | 'rolling' | 'result'
let currentLevelIdx = Math.min(progress.unlockedLevel - 1, 9);
let ballsLeft = 5;
let pinsDown = 0;
let score = 0;
let firstThrowShown = false;
let laneScale = 1.0;
let placeAnim = 0;
let rollElapsed = 0;
let scanTimer = 0;
let moveMode = false;
let lastHapticTime = 0;

// Dynamic lighting & low-light hysteresis state
const LIGHT_DIR_DEADZONE_RAD = THREE.MathUtils.degToRad(1.5);
const currentLightDir = new THREE.Vector3(0.42, 1.0, 0.35).normalize();
const targetLightColor = new THREE.Color(0xfff8f0);
let targetKeyIntensity = 1.35;
let targetHemiIntensity = 0.85;
let targetEnvIntensity = 0.85;
let isLowLight = false;
let lowLightScore = 0;

// Reusable math scratch objects (zero loop allocations)
const _vecA = new THREE.Vector3();
const _vecB = new THREE.Vector3();
const _vecC = new THREE.Vector3();
const _bufSize = new THREE.Vector2();
const _liveIdsSet = new Set();

// Touch / Gesture state
const pointers = new Map();
let pointerStart = null;
let dragTilt = 0;
let lastTime = performance.now();
let frameId = 0;

function getLevel() {
  return levels[currentLevelIdx] || levels[0];
}

function loadLevelState() {
  const lvl = getLevel();
  if (!lvl) return;
  ballsLeft = lvl.balls;
  pinsDown = 0;
  score = 0;
  moveMode = false;
  ui.els.btnToggleMove.textContent = 'Move lane';
  physics.loadLevel(lvl, (intensity, localPos) => {
    _vecA.set(localPos.x, localPos.y, localPos.z).applyMatrix4(laneGroup.matrixWorld);
    sound.playPinHit(intensity, _vecA);
    spawnDustPuff(localPos);
    const now = performance.now();
    if (now - lastHapticTime > 60) {
      lastHapticTime = now;
      triggerHaptic(Math.round(22 + Math.min(1, intensity) * 22));
    }
  });
  buildLaneAndPins(lvl, physics);
  ui.updateTopBar(lvl.id, pinsDown, lvl.targetPins, ballsLeft, false);
}

function enterScanning() {
  state = 'scanning';
  scanTimer = 0;
  moveMode = false;
  ui.els.btnToggleMove.textContent = 'Move lane';
  laneGroup.visible = false;
  reticleGroup.visible = false;
  xrCtrl.resetPlacement();
  fallbackCtrl.resetRing();
  ui.showTopBar(false);
  ui.setFitVisible(false);
  ui.setReplaceVisible(false);
  ui.setHint('Move your phone slowly to find the floor');
}

function getActiveProjectionCamera() {
  if (activeMode === 'webxr' && renderer.xr.isPresenting) {
    const xrCam = renderer.xr.getCamera();
    return xrCam.cameras && xrCam.cameras.length > 0 ? xrCam.cameras[0] : xrCam;
  }
  return camera;
}

function getHudSafeTopNdcY() {
  const vh = Math.max(200, window.visualViewport?.height ?? window.innerHeight);
  const hudBottomPx = ui.getHudBottomPx();
  const clearancePx = hudBottomPx + 18;
  return THREE.MathUtils.clamp(1 - (2 * clearancePx) / vh, 0.25, 0.78);
}

const _fitProjMat = new THREE.Matrix4();
const _fitFwdXZ = new THREE.Vector3();
const _fitRightXZ = new THREE.Vector3();
const _fitCamPos = new THREE.Vector3();
const _fitOrigin = new THREE.Vector3();
const _fitWorldPt = new THREE.Vector3();
const _fitHalfOuterW = LANE_WIDTH * 0.5 + 0.14;
const _fitLocalPts = [
  new THREE.Vector3(0, 0, APPROACH_LENGTH),
  new THREE.Vector3(-_fitHalfOuterW, 0, APPROACH_LENGTH),
  new THREE.Vector3(_fitHalfOuterW, 0, APPROACH_LENGTH),
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(-_fitHalfOuterW, 0, -LANE_LENGTH),
  new THREE.Vector3(_fitHalfOuterW, 0, -LANE_LENGTH),
  new THREE.Vector3(-_fitHalfOuterW, 0.36, -(LANE_LENGTH + PIT_DEPTH)),
  new THREE.Vector3(_fitHalfOuterW, 0.36, -(LANE_LENGTH + PIT_DEPTH)),
  new THREE.Vector3(0, LANE_SURFACE_Y + 0.32, -2.75),
];

/**
 * Positions the lane so the far end (pins & masking unit) starts cleanly
 * just below the HUD buttons row with zero overlap, while keeping the approach
 * inside the bottom viewport and scale fixed/consistent.
 */
function computeFittedPlacement(basePos, yawQuat, preferredScale = null) {
  const activeCam = getActiveProjectionCamera();
  activeCam.updateMatrixWorld(true);
  activeCam.getWorldPosition(_fitCamPos);
  _fitProjMat.multiplyMatrices(activeCam.projectionMatrix, activeCam.matrixWorldInverse);

  _fitFwdXZ.set(0, 0, -1).applyQuaternion(yawQuat).setY(0).normalize();
  _fitRightXZ.set(1, 0, 0).applyQuaternion(yawQuat).setY(0).normalize();

  const maxTopNdcY = getHudSafeTopNdcY();
  const targetFarTopY = maxTopNdcY - 0.05;
  const pushes = [-1.6, -1.2, -0.9, -0.6, -0.4, -0.2, 0.0, 0.2, 0.4, 0.6, 0.9, 1.2, 1.6];
  const baseScales = [1.0, 0.85, 0.75, 0.65, 0.55];
  const scales =
    preferredScale && preferredScale > 0
      ? [preferredScale, ...baseScales.filter((s) => Math.abs(s - preferredScale) > 0.03)]
      : baseScales;

  let best = null;

  for (const s of scales) {
    for (const push of pushes) {
      _fitOrigin.copy(basePos).addScaledVector(_fitFwdXZ, push);

      // Keep the near approach edge at least 0.55m ahead of the camera horizontally
      const dxApp = _fitOrigin.x - _fitFwdXZ.x * APPROACH_LENGTH * s - _fitCamPos.x;
      const dzApp = _fitOrigin.z - _fitFwdXZ.z * APPROACH_LENGTH * s - _fitCamPos.z;
      if (dxApp * _fitFwdXZ.x + dzApp * _fitFwdXZ.z < 0.55) {
        continue;
      }

      let fits = true;
      for (let i = 0; i < _fitLocalPts.length; i++) {
        const lp = _fitLocalPts[i];
        _fitWorldPt
          .copy(_fitOrigin)
          .addScaledVector(_fitRightXZ, lp.x * s)
          .addScaledVector(_fitFwdXZ, -lp.z * s);
        _fitWorldPt.y = basePos.y + lp.y * s;
        _fitWorldPt.applyMatrix4(_fitProjMat);

        if (
          _fitWorldPt.z < -1.0 ||
          _fitWorldPt.z > 1.0 ||
          Math.abs(_fitWorldPt.x) > 0.9 ||
          _fitWorldPt.y < -0.9 ||
          _fitWorldPt.y > maxTopNdcY
        ) {
          fits = false;
          break;
        }
      }

      if (!fits) continue;

      // Measure far end top (pins / masking front) and near approach
      _fitWorldPt.copy(_fitOrigin).addScaledVector(_fitFwdXZ, 2.85 * s);
      _fitWorldPt.y = basePos.y + 0.36 * s;
      _fitWorldPt.applyMatrix4(_fitProjMat);
      const farTopNdcY = _fitWorldPt.y;

      _fitWorldPt.copy(_fitOrigin).addScaledVector(_fitFwdXZ, -APPROACH_LENGTH * s);
      _fitWorldPt.y = basePos.y;
      _fitWorldPt.applyMatrix4(_fitProjMat);
      const appNdcY = _fitWorldPt.y;

      const scaleMatchBonus =
        preferredScale && Math.abs(s - preferredScale) < 0.03 ? 8.0 : 0.0;
      const candScore =
        scaleMatchBonus +
        s * 6.0 -
        Math.abs(farTopNdcY - targetFarTopY) * 5.0 -
        Math.abs(appNdcY + 0.64) * 1.2;

      if (!best || candScore > best.score) {
        best = { pos: _fitOrigin.clone(), scale: s, score: candScore };
      }
    }
    if (best && preferredScale && Math.abs(best.scale - preferredScale) < 0.03) {
      break;
    }
  }

  if (best) return best;
  return {
    pos: basePos.clone().addScaledVector(_fitFwdXZ, 0.8),
    scale: preferredScale || 0.75,
  };
}

function getCenteredFloorAnchor(activeCam, floorY) {
  const hit = fallbackCtrl.raycastFloor(0, 0, activeCam, floorY);
  if (!hit) return null;
  activeCam.getWorldPosition(_fitCamPos);
  const dx = hit.x - _fitCamPos.x;
  const dz = hit.z - _fitCamPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 5.5) {
    const k = 5.5 / dist;
    return new THREE.Vector3(_fitCamPos.x + dx * k, floorY, _fitCamPos.z + dz * k);
  }
  if (dist < 1.2 && dist > 1e-4) {
    const k = 1.2 / dist;
    return new THREE.Vector3(_fitCamPos.x + dx * k, floorY, _fitCamPos.z + dz * k);
  }
  return hit.clone();
}

function fitExistingLane() {
  if (!laneGroup.visible) return;
  const activeCam = getActiveProjectionCamera();
  const floorY = laneGroup.position.y;
  const yawQuat =
    activeMode === 'webxr'
      ? xrCtrl.computeLevelYawQuat(activeCam).clone()
      : fallbackCtrl.computeLevelYawQuat(camera).clone();

  const centeredHit = getCenteredFloorAnchor(activeCam, floorY);
  const basePos = centeredHit || laneGroup.position.clone();

  const fitted = computeFittedPlacement(basePos, yawQuat, laneScale);
  laneScale = fitted.scale;
  laneGroup.position.copy(fitted.pos);
  laneGroup.quaternion.copy(yawQuat);
  laneGroup.scale.setScalar(laneScale);
  laneGroup.updateMatrixWorld(true);
  syncShadowLight();

  if (activeMode === 'webxr') {
    xrCtrl.reanchorAt(laneGroup.position, laneGroup.quaternion);
  }
}

function placeLaneAt(basePos, quat) {
  const fitted = computeFittedPlacement(basePos, quat, null);
  laneScale = fitted.scale;

  laneGroup.position.copy(fitted.pos);
  laneGroup.quaternion.copy(quat);
  laneGroup.scale.setScalar(laneScale);
  laneGroup.visible = true;
  laneGroup.updateMatrixWorld(true);
  syncShadowLight();
  reticleGroup.visible = false;

  if (activeMode === 'webxr') {
    xrCtrl.reanchorAt(laneGroup.position, laneGroup.quaternion);
  }

  loadLevelState();
  placeAnim = 0;
  applyUnfoldProgress(0);
  state = 'placing';
  ui.setFitVisible(true);
  ui.setReplaceVisible(true);
  ui.setHint('');
}

// Authoritative resize using visualViewport (skipped while WebXR session is presenting)
function resize() {
  if (renderer.xr.isPresenting) return;
  const w = Math.round(window.visualViewport?.width ?? window.innerWidth);
  const h = Math.round(window.visualViewport?.height ?? window.innerHeight);
  if (!w || !h) return;

  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, true);
  fallbackCtrl.syncCameraFOV(camera, w, h);
}

ui.bindViewportSync(resize);
videoEl.addEventListener('loadedmetadata', resize);
videoEl.addEventListener('resize', resize);
ui.initDebugOverlay(fallbackCtrl.getCalibratedFOV(), (deg) => {
  fallbackCtrl.setCalibratedFOV(deg);
  resize();
});

function applyUnfoldProgress(u) {
  if (!alleyObj) return;
  const { plinthGroup, slabGroup, gutterGroup, structureGroup, returnGroup } = alleyObj.parts;

  // 0.0 - 0.40s: plinth and slab rise cleanly
  const tBase = THREE.MathUtils.clamp(u / 0.4, 0, 1);
  const eBase = 1 - Math.pow(1 - tBase, 3);
  plinthGroup.scale.set(eBase, Math.max(0.05, eBase), eBase);
  slabGroup.scale.set(1, Math.max(0.05, eBase), eBase);
  slabGroup.position.y = (1 - eBase) * -0.03;

  // 0.15 - 0.65s: gutters, kickbacks, masking unit, and ball return unfold
  const tStruct = THREE.MathUtils.clamp((u - 0.15) / 0.5, 0, 1);
  const eStruct = 1 - Math.pow(1 - tStruct, 3);
  gutterGroup.scale.set(eStruct, Math.max(0.01, eStruct), 1);
  structureGroup.scale.set(1, Math.max(0.01, eStruct), 1);
  returnGroup.scale.setScalar(Math.max(0.01, eStruct));

  // 0.40 - 1.00s: pins stand up one by one
  const pinCount = alleyObj.pinMeshes.size;
  let idx = 0;
  for (const [, pMesh] of alleyObj.pinMeshes.entries()) {
    const start = 0.38 + (idx / Math.max(1, pinCount)) * 0.4;
    const tPin = THREE.MathUtils.clamp((u - start) / 0.22, 0, 1);
    const ePin = 1 - Math.pow(1 - tPin, 3);
    pMesh.scale.setScalar(Math.max(0.001, ePin));
    pMesh.visible = tPin > 0.01;
    idx++;
  }

  // Ball appears cleanly at the end of unfold
  const tBall = THREE.MathUtils.clamp((u - 0.8) / 0.2, 0, 1);
  alleyObj.previewBall.scale.setScalar(Math.max(0.001, tBall));
  alleyObj.previewBall.visible = tBall > 0.02;
  alleyObj.ballContactShadow.material.opacity = 0.55 * tBall;
}

async function startExperience(forcePreview = false) {
  sound.unlock();
  await fallbackCtrl.requestMotionPermission();

  if (!forcePreview && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }

  ui.els.screenStart.classList.add('hidden');
  ui.hideMessage();

  if (levels.length === 0) {
    levels = await fetchLevels();
    currentLevelIdx = Math.min(progress.unlockedLevel - 1, levels.length - 1);
  }

  if (!forcePreview && (await xrCtrl.isSupported())) {
    try {
      await xrCtrl.start(renderer, uiRootEl, () => {
        if (state !== 'start') {
          ui.showHUD(false);
          ui.setARBlend(false);
          ui.setFitVisible(false);
          ui.setReplaceVisible(false);
          ui.setLowLight(false);
          ui.els.screenStart.classList.remove('hidden');
          state = 'start';
        }
      });
      activeMode = 'webxr';
      previewFloor.visible = false;
      scene.background = null;
      ui.setARBlend(true, !isSoftwareGl);
      ui.showHUD(true);
      enterScanning();
      renderer.setAnimationLoop((now, xrFrame) => tick(now, xrFrame));
      return;
    } catch {
      // Fall through to Camera-AR
    }
  }

  if (!forcePreview) {
    const camRes = await fallbackCtrl.startCamera(camera);
    if (camRes.ok) {
      activeMode = 'camera';
      previewFloor.visible = false;
      scene.background = null;
      ui.setARBlend(true, !isSoftwareGl);
      ui.showHUD(true);
      resize();
      enterScanning();
      if (camRes.gyroDenied) {
        ui.setHint('Motion access denied. Drag sideways while rolling to curve.');
      }
      renderer.setAnimationLoop(null);
      return;
    }

    let title = 'Camera unavailable';
    let msg = 'Back camera not available on this browser. You can use Preview mode to test.';
    if (camRes.reason === 'denied') {
      msg = 'Camera permission was denied. Allow camera access in browser settings or use Preview mode.';
    } else if (camRes.reason === 'unsupported') {
      title = 'Browser not supported';
      msg = 'This browser does not support AR camera access. Use Preview mode to play.';
    }
    ui.showMessage(title, msg);
    return;
  }

  // Desktop Preview mode
  fallbackCtrl.startPreview(camera);
  activeMode = 'preview';
  previewFloor.visible = true;
  scene.background = new THREE.Color(0x1f1f1f);
  ui.setARBlend(false);
  ui.showHUD(true);
  resize();
  enterScanning();
  renderer.setAnimationLoop(null);
}

// Button Bindings
ui.els.btnStart.addEventListener('click', () => startExperience(false));
ui.els.btnRetryAR.addEventListener('click', () => startExperience(false));
ui.els.btnPreviewMode.addEventListener('click', () => startExperience(true));
ui.els.btnFit.addEventListener('click', () => fitExistingLane());
ui.els.btnReplace.addEventListener('click', () => enterScanning());

ui.els.btnMute.addEventListener('click', () => {
  sound.unlock();
  progress.muted = !progress.muted;
  saveProgress(progress);
  ui.setMuteIcon(progress.muted);
  sound.setMuted(progress.muted);
});

ui.els.btnMenu.addEventListener('click', () => {
  ui.els.screenMenu.classList.remove('hidden');
});
ui.els.btnCloseMenu.addEventListener('click', () => {
  ui.els.screenMenu.classList.add('hidden');
});

ui.els.btnOpenLevels.addEventListener('click', () => {
  ui.els.screenMenu.classList.add('hidden');
  ui.renderLevelsGrid(levels, progress, currentLevelIdx, (idx) => {
    currentLevelIdx = idx;
    ui.els.screenLevels.classList.add('hidden');
    ui.hideResult();
    loadLevelState();
    state = laneGroup.visible ? 'aiming' : 'scanning';
  });
  ui.els.screenLevels.classList.remove('hidden');
});

ui.els.btnCloseLevels.addEventListener('click', () => {
  ui.els.screenLevels.classList.add('hidden');
});

ui.els.btnToggleMove.addEventListener('click', () => {
  moveMode = !moveMode;
  ui.els.btnToggleMove.textContent = moveMode ? 'Done moving' : 'Move lane';
  ui.els.screenMenu.classList.add('hidden');
  ui.setHint(moveMode ? 'Drag to move the lane' : '');
});

ui.els.btnRecenter.addEventListener('click', () => {
  ui.els.screenMenu.classList.add('hidden');
  enterScanning();
});

ui.els.btnRetryLevel.addEventListener('click', () => {
  ui.hideResult();
  loadLevelState();
  state = 'aiming';
});

ui.els.btnNextLevel.addEventListener('click', () => {
  ui.hideResult();
  if (currentLevelIdx < levels.length - 1) currentLevelIdx++;
  loadLevelState();
  state = 'aiming';
});

// Touch & Mouse Controls
const dom = renderer.domElement;

dom.addEventListener('pointerdown', (e) => {
  sound.unlock();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // Ignore multi-touch pinch so lane scale remains fixed and consistent
  if (pointers.size > 1) {
    pointerStart = null;
    return;
  }

  if (state === 'ready') {
    if (activeMode === 'webxr') {
      const placed = xrCtrl.placeLane(getActiveProjectionCamera());
      if (placed) placeLaneAt(placed.position, placed.quaternion);
    } else {
      const centerHit = fallbackCtrl.raycastFloor(0, 0, camera, 0);
      const basePos =
        centerHit && centerHit.length() <= 7.0 ? centerHit.clone() : fallbackCtrl.smoothedPos.clone();
      const quat = fallbackCtrl.computeLevelYawQuat(camera).clone();
      placeLaneAt(basePos, quat);
    }
    return;
  }

  if (state === 'aiming' || state === 'rolling' || activeMode === 'preview') {
    pointerStart = {
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      t: performance.now(),
      button: e.button,
    };
  }
});

dom.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  if (pointers.size > 1 || !pointerStart) return;

  if (moveMode && state === 'aiming') {
    const w = window.visualViewport ? window.visualViewport.width : window.innerWidth;
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const ndcX = (e.clientX / w) * 2 - 1;
    const ndcY = -(e.clientY / h) * 2 + 1;
    const targetY = laneGroup.position.y;
    const activeCam = getActiveProjectionCamera();
    const hit = fallbackCtrl.raycastFloor(ndcX, ndcY, activeCam, targetY);
    if (hit) {
      laneGroup.position.set(
        THREE.MathUtils.clamp(hit.x, -8.0, 8.0),
        targetY,
        THREE.MathUtils.clamp(hit.z, -8.0, 8.0)
      );
      laneGroup.updateMatrixWorld(true);
      syncShadowLight();
    }
    return;
  }

  if (state === 'rolling' && pointerStart.button === 0) {
    const dx = e.clientX - pointerStart.x;
    dragTilt = THREE.MathUtils.clamp(dx / (window.innerWidth * 0.25), -1, 1);
  } else if (activeMode === 'preview' && (e.buttons & 2)) {
    fallbackCtrl.orbitPreview(e.clientX - pointerStart.lastX, e.clientY - pointerStart.lastY);
  }

  pointerStart.lastX = e.clientX;
  pointerStart.lastY = e.clientY;
});

function launchThrow(aimAngle, speedNorm, sideSpin) {
  state = 'rolling';
  rollElapsed = 0;
  firstThrowShown = true;
  ui.setHint('');
  triggerHaptic(15);
  physics.throwBall(aimAngle, speedNorm, sideSpin);
}

function onPointerEnd(e) {
  pointers.delete(e.pointerId);
  if (moveMode && state === 'aiming' && activeMode === 'webxr' && pointerStart) {
    xrCtrl.reanchorAt(laneGroup.position, laneGroup.quaternion);
  } else if (state === 'aiming' && !moveMode && pointerStart && pointerStart.button === 0) {
    const dy = pointerStart.y - e.clientY;
    const dx = e.clientX - pointerStart.x;
    const elapsedMs = Math.max(40, performance.now() - pointerStart.t);

    if (dy > 32) {
      const speedNorm = THREE.MathUtils.clamp(dy / (elapsedMs * 1.35), 0.25, 1.0);
      const aimAngle = THREE.MathUtils.clamp(dx / (window.innerWidth * 0.9), -0.2, 0.2);
      const sideSpin = THREE.MathUtils.clamp(dx / 240, -1, 1);
      launchThrow(aimAngle, speedNorm, sideSpin);
    }
  }
  pointerStart = null;
  dragTilt = 0;
}

dom.addEventListener('pointerup', onPointerEnd);
dom.addEventListener('pointercancel', onPointerEnd);
dom.addEventListener('contextmenu', (e) => e.preventDefault());

// Desktop keyboard helper for Preview mode
window.addEventListener('keydown', (e) => {
  if (state === 'ready' && (e.key === 'Enter' || e.key === ' ')) {
    const quat = fallbackCtrl.computeLevelYawQuat(camera);
    placeLaneAt(fallbackCtrl.smoothedPos, quat);
  } else if (state === 'aiming' && e.key === ' ') {
    e.preventDefault();
    launchThrow(0, 0.74, 0);
  } else if (state === 'rolling') {
    if (e.key === 'ArrowLeft') dragTilt = -0.8;
    if (e.key === 'ArrowRight') dragTilt = 0.8;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') dragTilt = 0;
});

function syncMeshes(dt) {
  if (!alleyObj) return;
  const { pinMeshes, obstacleMeshes, previewBall } = alleyObj;

  for (const pin of physics.pins) {
    const m = pinMeshes.get(pin.id);
    if (m) {
      m.position.set(pin.body.position.x, pin.body.position.y, pin.body.position.z);
      m.quaternion.set(
        pin.body.quaternion.x,
        pin.body.quaternion.y,
        pin.body.quaternion.z,
        pin.body.quaternion.w
      );

      // Fade out and hide pins that drop into the rear dark pit
      if (pin.inPit && m.visible) {
        m.userData.pitFade += dt;
        const alpha = Math.max(0, 1 - m.userData.pitFade / 0.65);
        m.userData.pinMat.transparent = true;
        m.userData.bandMat.transparent = true;
        m.userData.pinMat.opacity = alpha;
        m.userData.bandMat.opacity = alpha;
        if (alpha <= 0.01) {
          m.visible = false;
        }
      }
    }
  }

  _liveIdsSet.clear();
  for (let i = 0; i < physics.pins.length; i++) {
    _liveIdsSet.add(physics.pins[i].id);
  }
  for (const [id, m] of pinMeshes.entries()) {
    if (!_liveIdsSet.has(id)) {
      alleyObj.root.remove(m);
      disposeObjectTree(m);
      pinMeshes.delete(id);
    }
  }

  physics.obstacles.forEach((obs, i) => {
    const m = obstacleMeshes[i];
    if (m) m.position.x = obs.body.position.x;
  });

  if (physics.ballBody) {
    previewBall.visible = false;
    if (!ballMesh) {
      ballMesh = createBallMesh(depthUniforms);
      laneGroup.add(ballMesh);
    }
    ballMesh.visible = true;
    const bp = physics.ballBody.position;
    ballMesh.position.set(bp.x, bp.y, bp.z);
    ballMesh.quaternion.set(
      physics.ballBody.quaternion.x,
      physics.ballBody.quaternion.y,
      physics.ballBody.quaternion.z,
      physics.ballBody.quaternion.w
    );

    if (ballContactShadow) {
      const halfW = (LANE_WIDTH * (getLevel().laneWidthScale || 1.0)) * 0.5;
      let surfY = LANE_SURFACE_Y;
      if (bp.z < -LANE_LENGTH) surfY = PIT_FLOOR_Y;
      else if (Math.abs(bp.x) > halfW) surfY = GUTTER_FLOOR_Y;

      const clearance = Math.max(0, bp.y - BALL_RADIUS - surfY);
      const vis = Math.max(0, 1 - clearance / 0.25);
      ballContactShadow.visible = bp.z >= -LANE_LENGTH - PIT_DEPTH;
      ballContactShadow.position.set(bp.x, surfY + 0.002, bp.z);
      ballContactShadow.scale.setScalar(1 + clearance * 2.2);
      ballContactShadow.material.opacity = 0.58 * vis;
    }
  } else {
    if (ballMesh) ballMesh.visible = false;
    if (state !== 'placing') {
      previewBall.visible = true;
      if (ballContactShadow) {
        ballContactShadow.visible = true;
        ballContactShadow.position.set(0, LANE_SURFACE_Y + 0.002, BALL_SPAWN_Z);
        ballContactShadow.scale.setScalar(1);
        ballContactShadow.material.opacity = 0.55;
      }
    }
  }
}

function updateEffects(dt) {
  for (let i = dustPuffs.length - 1; i >= 0; i--) {
    const p = dustPuffs[i];
    p.life += dt;
    if (p.life > 0.42) {
      laneGroup.remove(p.mesh);
      p.mesh.material.dispose();
      dustPuffs.splice(i, 1);
    } else {
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const t = p.life / 0.42;
      p.mesh.scale.setScalar(1 + t * 1.4);
      p.mesh.material.opacity = (1 - t) * 0.6;
    }
  }

  for (let i = confettiPieces.length - 1; i >= 0; i--) {
    const c = confettiPieces[i];
    c.life += dt;
    if (c.life > 1.8) {
      laneGroup.remove(c.mesh);
      c.mesh.material.dispose();
      confettiPieces.splice(i, 1);
    } else {
      c.vy -= 3.2 * dt;
      c.mesh.position.x += c.vx * dt;
      c.mesh.position.y += c.vy * dt;
      c.mesh.position.z += c.vz * dt;
      c.mesh.rotation.x += c.rot * dt;
      c.mesh.rotation.y += c.rot * dt;
      if (c.life > 1.2) c.mesh.material.opacity = (1.8 - c.life) / 0.6;
    }
  }
}

function updateLowLightState(rawLevel, darkThresh, brightThresh, dt) {
  if (rawLevel < darkThresh) {
    lowLightScore = Math.min(2.0, lowLightScore + dt);
  } else if (rawLevel > brightThresh) {
    lowLightScore = Math.max(0, lowLightScore - dt * 1.5);
  }
  const nextLow = isLowLight ? lowLightScore > 0.25 : lowLightScore >= 0.9;
  if (nextLow !== isLowLight) {
    isLowLight = nextLow;
    ui.setLowLight(isLowLight);
  }
}

function updateRoomLighting(dt, xrRes) {
  if (activeMode === 'webxr' && xrRes && xrRes.lightData && xrRes.lightData.valid) {
    const ld = xrRes.lightData;
    if (currentLightDir.angleTo(ld.dir) > LIGHT_DIR_DEADZONE_RAD) {
      currentLightDir.lerp(ld.dir, 0.08).normalize();
      syncShadowLight();
    }
    targetLightColor.copy(ld.color);
    targetKeyIntensity = 0.55 + ld.intensity * 0.95;
    targetHemiIntensity = 0.35 + ld.intensity * 0.55;
    targetEnvIntensity = 0.45 + ld.intensity * 0.5;

    if (ld.shCoefficients && ld.shCoefficients.length >= 27) {
      xrLightProbe.sh.fromArray(ld.shCoefficients);
      xrLightProbe.intensity = 0.85;
    }
    updateLowLightState(ld.rawIntensity, 0.26, 0.35, dt);
  } else if (activeMode === 'camera') {
    xrLightProbe.intensity = 0;
    const sample = fallbackCtrl.sampleRoomLight(dt);
    if (sample) {
      targetLightColor.copy(sample.color);
      targetKeyIntensity = 0.35 + sample.brightness * 1.45;
      targetHemiIntensity = 0.25 + sample.brightness * 0.8;
      targetEnvIntensity = 0.3 + sample.brightness * 0.75;
      updateLowLightState(sample.rawLuminance, 0.16, 0.22, 0.5);
    }
  } else {
    xrLightProbe.intensity = 0;
    targetLightColor.setHex(0xfff8f0);
    targetKeyIntensity = 1.35;
    targetHemiIntensity = 0.85;
    targetEnvIntensity = 0.85;
    if (isLowLight) {
      isLowLight = false;
      lowLightScore = 0;
      ui.setLowLight(false);
    }
  }

  const dampRate = 5.0;
  keyLight.color.lerp(targetLightColor, Math.min(1, dt * dampRate));
  keyLight.intensity = THREE.MathUtils.damp(keyLight.intensity, targetKeyIntensity, dampRate, dt);
  hemiLight.intensity = THREE.MathUtils.damp(hemiLight.intensity, targetHemiIntensity, dampRate, dt);
  scene.environmentIntensity = THREE.MathUtils.damp(
    scene.environmentIntensity,
    targetEnvIntensity,
    dampRate,
    dt
  );
}

function tick(now, xrFrame) {
  const t = now || performance.now();
  const dt = Math.min((t - lastTime) / 1000, 0.05);
  lastTime = t;

  let xrRes = null;

  if (activeMode === 'webxr') {
    xrRes = xrCtrl.updateFrame(xrFrame, camera, dt);
    const lost = Boolean(xrRes && xrRes.trackingLost);
    ui.setTrackingLost(lost && state !== 'start');

    // Sync WebXR CPU depth occlusion uniforms
    if (xrRes && xrRes.hasDepth && xrCtrl.depthTexture) {
      renderer.getDrawingBufferSize(_bufSize);
      depthUniforms.uDepthMap.value = xrCtrl.depthTexture;
      depthUniforms.uDepthNormMatrix.value.copy(xrCtrl.depthNormMatrix);
      depthUniforms.uRawValueToMeters.value = xrCtrl.rawValueToMeters;
      depthUniforms.uDepthIsFloat.value = xrCtrl.depthIsFloat ? 1.0 : 0.0;
      depthUniforms.uViewportSize.value.copy(_bufSize);
      depthUniforms.uHasDepth.value = 1.0;
    } else {
      depthUniforms.uHasDepth.value = 0.0;
    }

    if (lost && state !== 'start') {
      renderer.render(scene, camera);
      return;
    }

    // Only update placement reticle before placement; lane transform stays locked afterward
    if ((state === 'scanning' || state === 'ready') && xrRes && xrRes.ringReady) {
      reticleGroup.position.copy(xrRes.ringPos);
      reticleGroup.position.y += 0.002;
      reticleGroup.rotation.y += dt * 0.6;
      reticleGroup.visible = true;
      if (state === 'scanning') {
        state = 'ready';
        ui.setHint('Tap to place');
      }
    }
  } else if (activeMode === 'camera' || activeMode === 'preview') {
    depthUniforms.uHasDepth.value = 0.0;
    ui.setTrackingLost(false);
    const fbRes = fallbackCtrl.updateCameraAndRing(camera, laneGroup.visible, dt);
    if ((state === 'scanning' || state === 'ready') && fbRes) {
      scanTimer += dt;
      if (fbRes.ringReady && scanTimer > 0.45) {
        reticleGroup.position.copy(fbRes.ringPos);
        reticleGroup.position.y += 0.002;
        reticleGroup.rotation.y += dt * 0.6;
        reticleGroup.visible = true;
        if (state === 'scanning') {
          state = 'ready';
          ui.setHint('Tap to place');
        }
      }
    }
  }

  updateRoomLighting(dt, xrRes);

  // Sync spatial audio listener to camera world pose
  camera.getWorldPosition(_vecA);
  camera.getWorldDirection(_vecB);
  _vecC.copy(camera.up).applyQuaternion(camera.quaternion);
  sound.updateListener(_vecA, _vecB, _vecC);

  // 1.0s physical alley unfold animation
  if (state === 'placing') {
    placeAnim += dt;
    const u = Math.min(1, placeAnim / 1.0);
    applyUnfoldProgress(u);
    if (u >= 1) {
      state = 'aiming';
      ui.showTopBar(true);
      if (activeMode === 'camera' && fallbackCtrl.gyroDenied) {
        ui.setHint('Motion denied. Swipe up to bowl, drag sideways to curve.');
      } else if (!firstThrowShown) {
        ui.setHint('Swipe up to bowl');
      }
    }
  }

  // Fixed-timestep Physics & Scoring
  if (state === 'rolling') {
    rollElapsed += dt;
    const tilt = THREE.MathUtils.clamp(fallbackCtrl.getTiltCurve() + dragTilt, -1, 1);
    physics.setTiltCurve(tilt);

    const knocked = physics.step(dt);
    if (knocked.length > 0) {
      pinsDown += knocked.length;
      score += knocked.length;
      for (const p of knocked) spawnDustPuff(p.body.position);
      const lvl = getLevel();
      ui.updateTopBar(lvl.id, pinsDown, lvl.targetPins, ballsLeft, true);
    }

    if (physics.ballBody) {
      _vecA
        .set(physics.ballBody.position.x, physics.ballBody.position.y, physics.ballBody.position.z)
        .applyMatrix4(laneGroup.matrixWorld);
      const onSurface = physics.ballBody.position.y <= LANE_SURFACE_Y + BALL_RADIUS + 0.02;
      sound.updateRoll(physics.ballBody.velocity.length(), onSurface, _vecA);
    }

    if (physics.isSettled(rollElapsed)) {
      sound.updateRoll(0, false);
      const lvl = getLevel();
      const before = physics.pins.length;
      physics.clearKnockedAndResetStanding();
      const hitThisThrow = before - physics.pins.length;
      if (hitThisThrow === lvl.layout.length && ballsLeft === lvl.balls) {
        score += 2; // Strike bonus
      }

      ballsLeft--;
      ui.updateTopBar(lvl.id, pinsDown, lvl.targetPins, ballsLeft, false);

      if (pinsDown >= lvl.targetPins) {
        state = 'result';
        const ballsUsed = lvl.balls - ballsLeft;
        const stars = calculateStars(lvl, ballsUsed);
        progress.stars[lvl.id] = Math.max(progress.stars[lvl.id] || 0, stars);
        if (lvl.id >= progress.unlockedLevel && lvl.id < levels.length) {
          progress.unlockedLevel = lvl.id + 1;
        }
        saveProgress(progress);
        sound.playSuccess();
        triggerHaptic([30, 50, 45]);
        spawnConfetti();
        ui.showResult(true, stars, pinsDown, score, currentLevelIdx < levels.length - 1);
      } else if (ballsLeft <= 0) {
        state = 'result';
        ui.showResult(false, 0, pinsDown, score, false);
      } else {
        state = 'aiming';
      }
    }
  }

  syncMeshes(dt);
  updateEffects(dt);
  renderer.render(scene, camera);

  if (ui.debugEnabled) {
    const vvW = window.visualViewport ? Math.round(window.visualViewport.width) : '-';
    const vvH = window.visualViewport ? Math.round(window.visualViewport.height) : '-';
    const activeCam = getActiveProjectionCamera();
    renderer.getDrawingBufferSize(_bufSize);
    const laneDist = laneGroup.visible
      ? activeCam.getWorldPosition(_vecA).distanceTo(laneGroup.position).toFixed(2)
      : '-';
    ui.updateDebugInfo(
      [
        `win: ${window.innerWidth}x${window.innerHeight} | vv: ${vvW}x${vvH} | dpr: ${window.devicePixelRatio}`,
        `canvas css: ${canvasEl.clientWidth}x${canvasEl.clientHeight} | buf: ${_bufSize.x}x${_bufSize.y}`,
        `video src: ${videoEl.videoWidth}x${videoEl.videoHeight} | css: ${videoEl.clientWidth}x${videoEl.clientHeight}`,
        `cam: aspect=${camera.aspect.toFixed(3)} fov=${camera.fov.toFixed(1)} | XR=${renderer.xr.isPresenting ? 'on' : 'off'} (${activeMode})`,
        `lane: scale=${laneScale.toFixed(2)} dist=${laneDist}m`,
      ].join('\n')
    );
  }
}

function afterDraw(cb) {
  const gl = renderer.getContext();
  if (!gl || typeof gl.fenceSync !== 'function') {
    frameId = window.setTimeout(cb, 80);
    return;
  }
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  const poll = () => {
    const status = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
    if (status === gl.UNSIGNALED) {
      frameId = window.setTimeout(poll, 5);
    } else {
      if (sync) gl.deleteSync(sync);
      frameId = window.setTimeout(cb, 80);
    }
  };
  frameId = window.setTimeout(poll, 5);
}

function loop(now) {
  if (activeMode !== 'webxr') {
    tick(now);
  }
  if (isSoftwareGl) {
    afterDraw(() => {
      frameId = window.setTimeout(() => loop(performance.now()), 0);
    });
  } else {
    frameId = requestAnimationFrame(loop);
  }
}

if (isSoftwareGl) {
  frameId = window.setTimeout(() => loop(performance.now()), 0);
} else {
  frameId = requestAnimationFrame(loop);
}
void frameId;
