import * as THREE from 'three';
import {
  APPROACH_LENGTH,
  BALL_RADIUS,
  BALL_SPAWN_Z,
  GUTTER_WIDTH,
  LANE_LENGTH,
  LANE_SURFACE_Y,
  LANE_WIDTH,
  PIN_HEIGHT,
  PIN_RADIUS,
  PIT_DEPTH,
  PIT_FLOOR_Y,
} from './physics.js';

export function attachDepthOcclusion(material, depthUniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDepthMap = depthUniforms.uDepthMap;
    shader.uniforms.uDepthNormMatrix = depthUniforms.uDepthNormMatrix;
    shader.uniforms.uRawValueToMeters = depthUniforms.uRawValueToMeters;
    shader.uniforms.uHasDepth = depthUniforms.uHasDepth;
    shader.uniforms.uDepthIsFloat = depthUniforms.uDepthIsFloat;
    shader.uniforms.uViewportSize = depthUniforms.uViewportSize;

    shader.vertexShader =
      `varying float vArDepth;\n` +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `
        #include <project_vertex>
        vArDepth = -mvPosition.z;
        `
      );

    shader.fragmentShader =
      `
      varying float vArDepth;
      uniform sampler2D uDepthMap;
      uniform mat4 uDepthNormMatrix;
      uniform float uRawValueToMeters;
      uniform float uHasDepth;
      uniform float uDepthIsFloat;
      uniform vec2 uViewportSize;
      ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <logdepthbuf_fragment>',
      `
      #include <logdepthbuf_fragment>
      if (uHasDepth > 0.5) {
        vec2 screenUv = gl_FragCoord.xy / max(uViewportSize, vec2(1.0));
        vec4 depthUv = uDepthNormMatrix * vec4(screenUv, 0.0, 1.0);
        if (depthUv.x >= 0.0 && depthUv.x <= 1.0 && depthUv.y >= 0.0 && depthUv.y <= 1.0) {
          vec4 dSample = texture2D(uDepthMap, depthUv.xy);
          float realMeters = uDepthIsFloat > 0.5
            ? dSample.r * uRawValueToMeters
            : (dSample.g * 255.0 * 256.0 + dSample.r * 255.0) * uRawValueToMeters;
          if (realMeters > 0.05 && realMeters + 0.025 < vArDepth) {
            discard;
          }
        }
      }
      `
    );
  };
  material.customProgramCacheKey = () => 'ar_depth_occlusion_v2';
  return material;
}

function createLaneTextures(maxAnisotropy) {
  const W = 1024;
  const H = 2048;
  const totalLen = APPROACH_LENGTH + LANE_LENGTH; // 5.0m: z=+1.0 (y=H) to z=-4.0 (y=0)

  const zToPy = (z) => ((LANE_LENGTH + z) * -1 + LANE_LENGTH) * 0 + ((z - -LANE_LENGTH) / totalLen) * -H + H;
  // Let's map cleanly:
  // v = 1 (canvas py = 0, top of texture) => z = -LANE_LENGTH (-4.0, pin end)
  // v = 0 (canvas py = H, bottom of texture) => z = +APPROACH_LENGTH (+1.0, player end)
  const zToCanvasY = (z) => ((z - -LANE_LENGTH) / totalLen) * H;
  const xToCanvasX = (x) => ((x + LANE_WIDTH * 0.5) / LANE_WIDTH) * W;

  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = W;
  albedoCanvas.height = H;
  const ctx = albedoCanvas.getContext('2d');

  // 39 thin wood boards with subtle per-board maple/honey variation & organic wood grain
  const numBoards = 39;
  const bw = W / numBoards;
  const foulY = zToCanvasY(0);

  // Deterministic pseudo-random helper so boards never tile or flicker
  const hash = (n) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
  };

  for (let b = 0; b < numBoards; b++) {
    const bx = b * bw;
    const toneShift = (hash(b + 1) - 0.5) * 18;
    const warmShift = (hash(b + 53) - 0.5) * 10;

    // Main playing lane maple (light honey)
    const r = Math.round(231 + toneShift);
    const g = Math.round(196 + toneShift * 0.85 + warmShift * 0.4);
    const bl = Math.round(145 + toneShift * 0.65 - warmShift * 0.3);
    ctx.fillStyle = `rgb(${r},${g},${bl})`;
    ctx.fillRect(bx, 0, Math.ceil(bw), foulY);

    // Approach area (slightly warmer, slightly deeper honey tone)
    const ar = Math.round(r - 12);
    const ag = Math.round(g - 14);
    const ab = Math.round(bl - 14);
    ctx.fillStyle = `rgb(${ar},${ag},${ab})`;
    ctx.fillRect(bx, foulY, Math.ceil(bw), H - foulY);

    // Longitudinal wood grain streaks (subtle, non-repeating)
    for (let s = 0; s < 7; s++) {
      const gx = bx + hash(b * 13 + s) * (bw - 2) + 1;
      const gy0 = hash(b * 31 + s) * (H * 0.55);
      const gyLen = H * (0.2 + hash(b * 47 + s) * 0.45);
      ctx.strokeStyle =
        s % 2 === 0 ? 'rgba(155, 102, 48, 0.08)' : 'rgba(255, 244, 224, 0.11)';
      ctx.lineWidth = 1 + (s % 2);
      ctx.beginPath();
      ctx.moveTo(gx, gy0);
      ctx.lineTo(gx + (hash(b + s) - 0.5) * 2.5, Math.min(H, gy0 + gyLen));
      ctx.stroke();
    }

    // Subtle lacquer streaks along the oiled heads
    if (hash(b * 19 + 3) > 0.45) {
      ctx.fillStyle = 'rgba(255, 250, 240, 0.06)';
      ctx.fillRect(bx + 2, foulY - H * 0.45, bw - 4, H * 0.44);
    }

    // Fine board seam
    ctx.fillStyle = 'rgba(130, 82, 38, 0.18)';
    ctx.fillRect(bx, 0, 1.2, H);
  }

  // Foul line at z = 0 (charcoal #1F1F1F + tiny orange edge accents)
  ctx.fillStyle = '#1F1F1F';
  ctx.fillRect(0, foulY - 6, W, 12);
  ctx.fillStyle = '#F26B1D';
  ctx.fillRect(0, foulY - 6, 26, 12);
  ctx.fillRect(W - 26, foulY - 6, 26, 12);

  // 7 small dots just before the foul line (z = +0.14 m)
  const dotBoards = [4, 9, 14, 19, 24, 29, 34];
  const nearDotsY = zToCanvasY(0.14);
  dotBoards.forEach((bIdx, idx) => {
    const cx = (bIdx + 0.5) * bw;
    ctx.fillStyle = idx === 3 ? '#F26B1D' : '#1F1F1F';
    ctx.beginPath();
    ctx.arc(cx, nearDotsY, idx === 3 ? 6.5 : 5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Row of stance guide dots on approach (z = +0.44 m)
  const backDotsY = zToCanvasY(0.44);
  dotBoards.forEach((bIdx) => {
    const cx = (bIdx + 0.5) * bw;
    ctx.fillStyle = '#1F1F1F';
    ctx.beginPath();
    ctx.arc(cx, backDotsY, 4.2, 0, Math.PI * 2);
    ctx.fill();
  });

  // Row of down-lane guide dots (z = -0.50 m)
  const downDotsY = zToCanvasY(-0.50);
  dotBoards.forEach((bIdx) => {
    const cx = (bIdx + 0.5) * bw;
    ctx.fillStyle = '#1F1F1F';
    ctx.beginPath();
    ctx.arc(cx, downDotsY, 4.0, 0, Math.PI * 2);
    ctx.fill();
  });

  // 7 arrow markers ~1/3 down the lane (z = -1.02 m), center arrow in orange accent
  dotBoards.forEach((bIdx, idx) => {
    const cx = (bIdx + 0.5) * bw;
    const distFromCenter = Math.abs(idx - 3);
    const arrowY = zToCanvasY(-1.02 + distFromCenter * 0.036);
    ctx.fillStyle = idx === 3 ? '#F26B1D' : '#1F1F1F';
    ctx.beginPath();
    ctx.moveTo(cx, arrowY - 22);
    ctx.lineTo(cx + 11, arrowY + 14);
    ctx.lineTo(cx, arrowY + 7);
    ctx.lineTo(cx - 11, arrowY + 14);
    ctx.closePath();
    ctx.fill();
  });

  // 10 pin-spot marks on pin deck (matching 0.8m x 3.0m triangle layout)
  const pinSpots = [
    [0.0, -2.35],
    [-0.09, -2.50],
    [0.09, -2.50],
    [-0.18, -2.65],
    [0.0, -2.65],
    [0.18, -2.65],
    [-0.27, -2.80],
    [-0.09, -2.80],
    [0.09, -2.80],
    [0.27, -2.80],
  ];
  pinSpots.forEach(([px, pz]) => {
    const cx = xToCanvasX(px);
    const cy = zToCanvasY(pz);
    ctx.strokeStyle = '#1F1F1F';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#F26B1D';
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  const albedoTex = new THREE.CanvasTexture(albedoCanvas);
  albedoTex.colorSpace = THREE.SRGBColorSpace;
  albedoTex.anisotropy = maxAnisotropy;

  // Variable gloss roughness map (glossier near oiled front, duller toward backend/pin deck)
  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = 256;
  roughCanvas.height = 512;
  const rctx = roughCanvas.getContext('2d');
  const grad = rctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.0, 'rgb(225, 225, 225)'); // Pin deck backend: ~0.88 * 0.40 -> duller
  grad.addColorStop(0.45, 'rgb(175, 175, 175)');
  grad.addColorStop(0.75, 'rgb(120, 120, 120)'); // Oiled heads: glossier
  grad.addColorStop(0.82, 'rgb(185, 185, 185)'); // Approach: slightly grippier satin
  grad.addColorStop(1.0, 'rgb(195, 195, 195)');
  rctx.fillStyle = grad;
  rctx.fillRect(0, 0, 256, 512);

  for (let b = 0; b < numBoards; b++) {
    const v = 220 + Math.round((hash(b + 99) - 0.5) * 35);
    rctx.fillStyle = `rgba(${v},${v},${v},0.16)`;
    rctx.fillRect((b * 256) / numBoards, 0, 256 / numBoards - 1, 512);
  }

  const roughTex = new THREE.CanvasTexture(roughCanvas);
  roughTex.anisotropy = maxAnisotropy;

  return { albedoTex, roughTex };
}

function createAOShadowTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const ctx = c.getContext('2d');

  // Soft outer ambient shadow + tight darker base edge AO
  ctx.clearRect(0, 0, 256, 512);
  const drawRoundRect = (x, y, w, h, r, fill) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  };

  ctx.filter = 'blur(14px)';
  drawRoundRect(34, 24, 188, 464, 18, 'rgba(0, 0, 0, 0.36)');
  ctx.filter = 'blur(6px)';
  drawRoundRect(46, 34, 164, 444, 12, 'rgba(0, 0, 0, 0.44)');
  ctx.filter = 'none';

  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function createBallContactTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 60);
  g.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
  g.addColorStop(0.5, 'rgba(0, 0, 0, 0.24)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export function createReticleGroup() {
  const g = new THREE.Group();
  const orangeMat = new THREE.MeshBasicMaterial({
    color: 0xf26b1d,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.195, 42), orangeMat);
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);

  const innerDot = new THREE.Mesh(new THREE.CircleGeometry(0.022, 20), orangeMat);
  innerDot.rotation.x = -Math.PI / 2;
  g.add(innerDot);

  const scanDotGeo = new THREE.CircleGeometry(0.012, 14);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const dot = new THREE.Mesh(scanDotGeo, orangeMat);
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(Math.cos(angle) * 0.255, 0, Math.sin(angle) * 0.255);
    g.add(dot);
  }
  return g;
}

export function createBallMesh(depthUniforms) {
  const g = new THREE.Group();
  const orangeMat = attachDepthOcclusion(
    new THREE.MeshPhysicalMaterial({
      color: 0xf26b1d,
      roughness: 0.18,
      metalness: 0.02,
      clearcoat: 0.78,
      clearcoatRoughness: 0.1,
    }),
    depthUniforms
  );
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 26, 20), orangeMat);
  sphere.castShadow = true;
  sphere.receiveShadow = true;
  g.add(sphere);

  const holeMat = attachDepthOcclusion(
    new THREE.MeshStandardMaterial({ color: 0x1f1f1f, roughness: 0.75 }),
    depthUniforms
  );
  const holeGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.008, 12);
  [
    [0, BALL_RADIUS * 0.96, 0.024],
    [-0.019, BALL_RADIUS * 0.95, -0.009],
    [0.019, BALL_RADIUS * 0.95, -0.009],
  ].forEach(([hx, hy, hz]) => {
    const h = new THREE.Mesh(holeGeo, holeMat);
    h.position.set(hx, hy, hz);
    g.add(h);
  });
  return g;
}

export function createBallContactShadow() {
  const mat = new THREE.MeshBasicMaterial({
    map: createBallContactTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.55,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(BALL_RADIUS * 2.8, BALL_RADIUS * 2.8), mat);
  m.rotation.x = -Math.PI / 2;
  return m;
}

function createPinGeometry() {
  // Authentic regulation bowling pin silhouette via LatheGeometry (centered at Y=0)
  const h = PIN_HEIGHT;
  const r = PIN_RADIUS;
  const profile = [
    new THREE.Vector2(0.0, -h * 0.5),
    new THREE.Vector2(r * 0.48, -h * 0.5),
    new THREE.Vector2(r * 0.76, -h * 0.42),
    new THREE.Vector2(r * 0.98, -h * 0.25),
    new THREE.Vector2(r * 1.0, -h * 0.14),
    new THREE.Vector2(r * 0.86, -h * 0.02),
    new THREE.Vector2(r * 0.58, h * 0.11),
    new THREE.Vector2(r * 0.41, h * 0.21),
    new THREE.Vector2(r * 0.41, h * 0.3),
    new THREE.Vector2(r * 0.55, h * 0.4),
    new THREE.Vector2(r * 0.51, h * 0.45),
    new THREE.Vector2(r * 0.32, h * 0.49),
    new THREE.Vector2(0.0, h * 0.5),
  ];
  return new THREE.LatheGeometry(profile, 20);
}

export function buildBowlingAlley(level, physics, maxAnisotropy, depthUniforms) {
  const root = new THREE.Group();
  const w = LANE_WIDTH * (level.laneWidthScale || 1.0);
  const totalWoodLen = APPROACH_LENGTH + LANE_LENGTH; // 5.0m
  const fullStructLen = totalWoodLen + PIT_DEPTH; // 5.55m
  const fullCenterZ = (APPROACH_LENGTH - (LANE_LENGTH + PIT_DEPTH)) * 0.5;
  const totalOuterW = w + GUTTER_WIDTH * 2 + 0.06;

  // 1. Baked radial/edge contact AO shadow right above the floor
  const aoMat = attachDepthOcclusion(
    new THREE.MeshBasicMaterial({
      map: createAOShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.75,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
    depthUniforms
  );
  const aoMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(totalOuterW + 0.55, fullStructLen + 0.45),
    aoMat
  );
  aoMesh.rotation.x = -Math.PI / 2;
  aoMesh.position.set(-0.08, 0.001, fullCenterZ);
  root.add(aoMesh);

  // 2. Slim base plinth (2cm inset, 2.5cm height, light grey)
  const plinthMat = attachDepthOcclusion(
    new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.86, metalness: 0.02 }),
    depthUniforms
  );
  const plinthGroup = new THREE.Group();
  const plinthMesh = new THREE.Mesh(
    new THREE.BoxGeometry(totalOuterW - 0.04, 0.025, fullStructLen - 0.04),
    plinthMat
  );
  plinthMesh.position.set(0, 0.0125, fullCenterZ);
  plinthMesh.castShadow = true;
  plinthMesh.receiveShadow = true;
  plinthGroup.add(plinthMesh);
  root.add(plinthGroup);

  // 3. Solid 6 cm wood slab with rounded/beveled edge + UV-mapped 39-board deck
  const slabGroup = new THREE.Group();
  const { albedoTex, roughTex } = createLaneTextures(maxAnisotropy);

  const slabEdgeMat = attachDepthOcclusion(
    new THREE.MeshStandardMaterial({ color: 0xd4a66f, roughness: 0.55, metalness: 0.0 }),
    depthUniforms
  );

  // Beveled 6 cm structural wood slab
  const slabShape = new THREE.Shape();
  const hw = w * 0.5 - 0.004;
  const hl = totalWoodLen * 0.5 - 0.004;
  slabShape.moveTo(-hw, -hl);
  slabShape.lineTo(hw, -hl);
  slabShape.lineTo(hw, hl);
  slabShape.lineTo(-hw, hl);
  slabShape.closePath();

  const slabGeo = new THREE.ExtrudeGeometry(slabShape, {
    depth: 0.052,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 2,
  });
  slabGeo.rotateX(Math.PI / 2);
  const slabMesh = new THREE.Mesh(slabGeo, slabEdgeMat);
  slabMesh.position.set(0, LANE_SURFACE_Y - 0.004, (APPROACH_LENGTH - LANE_LENGTH) * 0.5);
  slabMesh.castShadow = true;
  slabMesh.receiveShadow = true;
  slabGroup.add(slabMesh);

  // Top 39-board maple playing surface with variable gloss & room reflections
  const deckMat = attachDepthOcclusion(
    new THREE.MeshPhysicalMaterial({
      map: albedoTex,
      roughnessMap: roughTex,
      roughness: 0.36,
      metalness: 0.0,
      clearcoat: 0.42,
      clearcoatRoughness: 0.22,
      reflectivity: 0.6,
    }),
    depthUniforms
  );
  const deckSurface = new THREE.Mesh(new THREE.PlaneGeometry(w, totalWoodLen), deckMat);
  deckSurface.rotation.x = -Math.PI / 2;
  deckSurface.position.set(0, LANE_SURFACE_Y + 0.0004, (APPROACH_LENGTH - LANE_LENGTH) * 0.5);
  deckSurface.receiveShadow = true;
  slabGroup.add(deckSurface);
  root.add(slabGroup);

  // 4. Recessed curved cream gutters on both sides
  const gutterGroup = new THREE.Group();
  const creamMat = attachDepthOcclusion(
    new THREE.MeshPhysicalMaterial({
      color: 0xfaf5ee,
      roughness: 0.58,
      metalness: 0.0,
      clearcoat: 0.16,
      clearcoatRoughness: 0.35,
    }),
    depthUniforms
  );

  // Cross-section profile in XY plane (X = width across gutter, Y = elevation)
  const gShape = new THREE.Shape();
  const gw = GUTTER_WIDTH;
  gShape.moveTo(0, 0.025);
  gShape.lineTo(0, LANE_SURFACE_Y - 0.003);
  gShape.lineTo(0.015, LANE_SURFACE_Y - 0.006);
  gShape.quadraticCurveTo(gw * 0.5, LANE_SURFACE_Y - 0.068, gw - 0.012, LANE_SURFACE_Y - 0.006);
  gShape.lineTo(gw + 0.03, LANE_SURFACE_Y - 0.002);
  gShape.lineTo(gw + 0.03, 0.025);
  gShape.closePath();

  const gutterLen = totalWoodLen + PIT_DEPTH;
  const gGeo = new THREE.ExtrudeGeometry(gShape, {
    depth: gutterLen,
    bevelEnabled: false,
    curveSegments: 10,
  });
  // Extrude runs along +Z from 0 to gutterLen; shift so it aligns from -LANE_LENGTH - PIT_DEPTH to +APPROACH_LENGTH
  gGeo.translate(0, 0, -(LANE_LENGTH + PIT_DEPTH));

  [-1, 1].forEach((side) => {
    const m = new THREE.Mesh(gGeo, creamMat);
    if (side < 0) {
      m.scale.x = -1;
    }
    m.position.x = side * (w * 0.5);
    m.castShadow = true;
    m.receiveShadow = true;
    gutterGroup.add(m);
  });
  root.add(gutterGroup);

  // 5. White side kickbacks (pin end) + thin orange stripe + dark pit & white masking unit
  const structureGroup = new THREE.Group();
  const whiteWallMat = attachDepthOcclusion(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.0,
      clearcoat: 0.25,
      clearcoatRoughness: 0.2,
    }),
    depthUniforms
  );
  const orangeMat = attachDepthOcclusion(
    new THREE.MeshPhysicalMaterial({
      color: 0xf26b1d,
      roughness: 0.32,
      metalness: 0.02,
      clearcoat: 0.35,
      clearcoatRoughness: 0.18,
    }),
    depthUniforms
  );
  const pitMat = attachDepthOcclusion(
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.92 }),
    depthUniforms
  );

  const kickLen = 1.32; // z = -2.10 to -3.42
  const kickCenterZ = -LANE_LENGTH - PIT_DEPTH + kickLen * 0.5;
  [-1, 1].forEach((side) => {
    const wallX = side * (w * 0.5 + GUTTER_WIDTH + 0.02);
    const kickWall = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.30, kickLen), whiteWallMat);
    kickWall.position.set(wallX, 0.025 + 0.15, kickCenterZ);
    kickWall.castShadow = true;
    kickWall.receiveShadow = true;
    structureGroup.add(kickWall);

    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.02, kickLen), orangeMat);
    stripe.position.set(wallX, 0.025 + 0.235, kickCenterZ);
    structureGroup.add(stripe);
  });

  // Dark pit behind pin deck (z = -3.0 to -3.42)
  const pitFloor = new THREE.Mesh(
    new THREE.BoxGeometry(w + GUTTER_WIDTH * 2, 0.02, PIT_DEPTH),
    pitMat
  );
  pitFloor.position.set(0, PIT_FLOOR_Y, -LANE_LENGTH - PIT_DEPTH * 0.5);
  pitFloor.receiveShadow = true;
  structureGroup.add(pitFloor);

  const pitBack = new THREE.Mesh(
    new THREE.BoxGeometry(w + GUTTER_WIDTH * 2 + 0.08, 0.20, 0.04),
    pitMat
  );
  pitBack.position.set(0, 0.025 + 0.10, -LANE_LENGTH - PIT_DEPTH + 0.01);
  structureGroup.add(pitBack);

  // White masking unit panel above the pit with clean orange horizontal stripe
  const maskWidth = w + GUTTER_WIDTH * 2 + 0.08;
  const maskPanel = new THREE.Mesh(new THREE.BoxGeometry(maskWidth, 0.21, 0.045), whiteWallMat);
  maskPanel.position.set(0, 0.025 + 0.285, -LANE_LENGTH - PIT_DEPTH + 0.015);
  maskPanel.castShadow = true;
  maskPanel.receiveShadow = true;
  structureGroup.add(maskPanel);

  const maskStripe = new THREE.Mesh(new THREE.BoxGeometry(maskWidth + 0.004, 0.022, 0.049), orangeMat);
  maskStripe.position.set(0, 0.025 + 0.275, -LANE_LENGTH - PIT_DEPTH + 0.015);
  structureGroup.add(maskStripe);

  root.add(structureGroup);

  // 6. Decorative 3D Ball Return Unit at near-end left side
  const returnGroup = new THREE.Group();
  const rx = -(w * 0.5 + GUTTER_WIDTH + 0.13);
  const rz = 0.40;

  const hood = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.22, 0.24), whiteWallMat);
  hood.position.set(rx, 0.025 + 0.11, rz - 0.10);
  hood.castShadow = true;
  hood.receiveShadow = true;
  returnGroup.add(hood);

  const hoodStripe = new THREE.Mesh(new THREE.BoxGeometry(0.204, 0.018, 0.244), orangeMat);
  hoodStripe.position.set(rx, 0.025 + 0.18, rz - 0.10);
  returnGroup.add(hoodStripe);

  const returnMouth = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.13, 0.02), pitMat);
  returnMouth.position.set(rx, 0.025 + 0.085, rz + 0.014);
  returnGroup.add(returnMouth);

  // Twin steel rack rails holding a decorative orange spare ball
  const railMat = attachDepthOcclusion(
    new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.35, metalness: 0.7 }),
    depthUniforms
  );
  [-0.046, 0.046].forEach((offset) => {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.34, 10), railMat);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(rx + offset, 0.025 + 0.13, rz + 0.18);
    rail.castShadow = true;
    returnGroup.add(rail);
  });

  const rackBall = createBallMesh(depthUniforms);
  rackBall.position.set(rx, 0.025 + 0.13 + BALL_RADIUS * 0.85, rz + 0.18);
  returnGroup.add(rackBall);

  const rackEndPost = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.145, 0.022), whiteWallMat);
  rackEndPost.position.set(rx, 0.025 + 0.072, rz + 0.35);
  rackEndPost.castShadow = true;
  returnGroup.add(rackEndPost);

  root.add(returnGroup);

  // 7. Bowling Pins (glossy white + 2 thin orange neck stripes, cloned material for pit fade)
  const pinGeo = createPinGeometry();
  const basePinMat = attachDepthOcclusion(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.22,
      metalness: 0.0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.12,
    }),
    depthUniforms
  );
  const baseBandMat = attachDepthOcclusion(
    new THREE.MeshPhysicalMaterial({
      color: 0xf26b1d,
      roughness: 0.25,
      metalness: 0.0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.14,
    }),
    depthUniforms
  );
  const bandGeo1 = new THREE.CylinderGeometry(
    PIN_RADIUS * 0.43,
    PIN_RADIUS * 0.43,
    0.013,
    18
  );
  const bandGeo2 = new THREE.CylinderGeometry(
    PIN_RADIUS * 0.43,
    PIN_RADIUS * 0.43,
    0.013,
    18
  );

  const pinMeshes = new Map();
  for (const pin of physics.pins) {
    const g = new THREE.Group();
    const pMat = basePinMat.clone();
    const bMat = baseBandMat.clone();
    attachDepthOcclusion(pMat, depthUniforms);
    attachDepthOcclusion(bMat, depthUniforms);

    const body = new THREE.Mesh(pinGeo, pMat);
    body.castShadow = true;
    body.receiveShadow = true;

    const band1 = new THREE.Mesh(bandGeo1, bMat);
    band1.position.y = PIN_HEIGHT * 0.225;
    const band2 = new THREE.Mesh(bandGeo2, bMat);
    band2.position.y = PIN_HEIGHT * 0.275;

    g.add(body, band1, band2);
    g.position.set(pin.body.position.x, pin.body.position.y, pin.body.position.z);
    g.userData = { pinMat: pMat, bandMat: bMat, pitFade: 0 };
    root.add(g);
    pinMeshes.set(pin.id, g);
  }

  // 8. Obstacles (charcoal blocks with orange top cap)
  const obsMat = attachDepthOcclusion(
    new THREE.MeshStandardMaterial({ color: 0x1f1f1f, roughness: 0.55 }),
    depthUniforms
  );
  const obstacleMeshes = [];
  (level.obstacles || []).forEach((obs, i) => {
    const pObs = physics.obstacles[i];
    if (!pObs) return;
    const bw = obs.width || 0.22;
    const g = new THREE.Group();
    const block = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.18, 0.1), obsMat);
    block.castShadow = true;
    block.receiveShadow = true;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.94, 0.02, 0.08), orangeMat);
    cap.position.y = 0.095;
    g.add(block, cap);
    g.position.set(pObs.body.position.x, pObs.body.position.y, pObs.body.position.z);
    root.add(g);
    obstacleMeshes.push(g);
  });

  // 9. Waiting ball at near-end spawn point + ball contact shadow
  const previewBall = createBallMesh(depthUniforms);
  previewBall.position.set(0, LANE_SURFACE_Y + BALL_RADIUS + 0.001, BALL_SPAWN_Z);
  root.add(previewBall);

  const ballContactShadow = createBallContactShadow();
  ballContactShadow.position.set(0, LANE_SURFACE_Y + 0.002, BALL_SPAWN_Z);
  root.add(ballContactShadow);

  return {
    root,
    parts: {
      plinthGroup,
      slabGroup,
      gutterGroup,
      structureGroup,
      returnGroup,
    },
    pinMeshes,
    obstacleMeshes,
    previewBall,
    ballContactShadow,
  };
}
