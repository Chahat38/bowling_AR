import * as THREE from 'three';
import { OneEuroFilterQuat, OneEuroFilterScalar, OneEuroFilterVec3 } from './filters.js';

const FOV_STORAGE_KEY = 'pindrop_ar_fov_v1';
const GYRO_DEADZONE_RAD = THREE.MathUtils.degToRad(0.5);

export class FallbackController {
  constructor(videoEl) {
    this.videoEl = videoEl;
    this.mode = 'none'; // 'camera' | 'preview'
    this.stream = null;

    // Calibrated portrait back-camera vertical FOV (50..75 deg, default 60)
    this.calibratedFOV = this._loadFOV();

    // Assumed camera height 1.4m above floor y = 0
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.raycaster = new THREE.Raycaster();
    this.aimNDC = new THREE.Vector2(0, 0); // exact screen center ray

    // DeviceOrientation One Euro Filter + 0.5 deg dead zone
    this.hasGyro = false;
    this.gyroDenied = false;
    this.rawEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.targetQuat = new THREE.Quaternion();
    this.smoothedQuat = new THREE.Quaternion();
    this.gyroFilter = new OneEuroFilterQuat(1.2, 0.85, 1.0, GYRO_DEADZONE_RAD);
    this.qWorld = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    this.qOrient = new THREE.Quaternion();
    this.zAxis = new THREE.Vector3(0, 0, 1);
    this.screenOrient = 0;

    // Preview mouse orbit state
    this.previewYaw = 0;
    this.previewPitch = -0.46;

    // Sideways tilt for ball curve (-1..1), smoothed + dead-zoned
    this.rawTiltCurve = 0;
    this.tiltCurve = 0;
    this.tiltFilter = new OneEuroFilterScalar(1.4, 0.5, 1.0);

    // Smoothed placement ring (1 cm position / 0.5 deg yaw dead zone)
    this.hasHit = false;
    this.smoothedPos = new THREE.Vector3(0, 0, -2.5);
    this.smoothedRingQuat = new THREE.Quaternion();
    this.rawPos = new THREE.Vector3();
    this.ringPosFilter = new OneEuroFilterVec3(1.3, 0.45, 1.0, 0.01);
    this.ringQuatFilter = new OneEuroFilterQuat(1.3, 0.5, 1.0, GYRO_DEADZONE_RAD);

    // Reusable scratch objects (zero per-frame allocation)
    this._fwd = new THREE.Vector3();
    this._upAxis = new THREE.Vector3(0, 1, 0);
    this._yawQuat = new THREE.Quaternion();
    this._tmpQuat = new THREE.Quaternion();
    this._previewEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._rayNDC = new THREE.Vector2();
    this._rayOut = new THREE.Vector3();
    this._rayNormal = new THREE.Vector3(0, 1, 0);
    this._rayPlane = new THREE.Plane(this._rayNormal, 0);

    // Downscaled video canvas for 0.5s room light & color sampling
    this.lightCanvas = document.createElement('canvas');
    this.lightCanvas.width = 16;
    this.lightCanvas.height = 16;
    this.lightCtx = this.lightCanvas.getContext('2d', { willReadFrequently: true });
    this.lightSampleTimer = 0;
    this.roomColor = new THREE.Color(0xfff8f0);
    this.roomBrightness = 0.65;
    this.rawLuminance = 0.65;
  }

  _loadFOV() {
    try {
      const v = Number(localStorage.getItem(FOV_STORAGE_KEY));
      if (Number.isFinite(v) && v >= 50 && v <= 75) return v;
    } catch {
      // ignore
    }
    return 60;
  }

  getCalibratedFOV() {
    return this.calibratedFOV;
  }

  setCalibratedFOV(deg) {
    this.calibratedFOV = THREE.MathUtils.clamp(Math.round(deg), 50, 75);
    try {
      localStorage.setItem(FOV_STORAGE_KEY, String(this.calibratedFOV));
    } catch {
      // ignore
    }
  }

  async requestMotionPermission() {
    if (
      typeof window !== 'undefined' &&
      window.DeviceOrientationEvent &&
      typeof window.DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        const res = await window.DeviceOrientationEvent.requestPermission();
        if (res === 'denied') {
          this.gyroDenied = true;
          return false;
        }
      } catch {
        this.gyroDenied = true;
        return false;
      }
    }
    return true;
  }

  async startCamera(camera) {
    this.stop();
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return { ok: false, reason: 'unsupported' };
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      if (this.videoEl) {
        this.videoEl.srcObject = this.stream;
        await this.videoEl.play();
      }
      this.mode = 'camera';
      camera.position.set(0, 1.4, 0);
      this.rawEuler.set(-0.46, 0, 0, 'YXZ');
      this.smoothedQuat.setFromEuler(this.rawEuler);
      this.targetQuat.copy(this.smoothedQuat);
      this.gyroFilter.reset(this.smoothedQuat);
      this.tiltFilter.reset(0);
      this.rawLuminance = 0.65;
      camera.quaternion.copy(this.smoothedQuat);
      this.bindOrientation();

      const w = Math.round(window.visualViewport?.width ?? window.innerWidth);
      const h = Math.round(window.visualViewport?.height ?? window.innerHeight);
      this.syncCameraFOV(camera, w, h);

      return { ok: true, gyroDenied: this.gyroDenied };
    } catch (err) {
      const denied = err && err.name === 'NotAllowedError';
      return { ok: false, reason: denied ? 'denied' : 'no-camera' };
    }
  }

  /**
   * Matches Three.js vertical FOV to the live video stream accounting for
   * portrait orientation and CSS object-fit: cover cropping.
   */
  syncCameraFOV(camera, viewW, viewH) {
    if (!viewW || !viewH) return;
    const screenAspect = viewW / viewH;
    camera.aspect = screenAspect;

    if (
      this.mode === 'camera' &&
      this.videoEl &&
      this.videoEl.videoWidth > 0 &&
      this.videoEl.videoHeight > 0
    ) {
      const rawW = this.videoEl.videoWidth;
      const rawH = this.videoEl.videoHeight;
      const isPortrait = viewH >= viewW;
      // Portrait-corrected aspect: short side = width when in portrait
      const vw = isPortrait ? Math.min(rawW, rawH) : Math.max(rawW, rawH);
      const vh = isPortrait ? Math.max(rawW, rawH) : Math.min(rawW, rawH);
      const videoAspect = vw / vh;

      const baseVFovRad = THREE.MathUtils.degToRad(this.calibratedFOV);
      if (videoAspect > screenAspect) {
        // Sides cropped by object-fit: cover -> keep full vertical FOV
        camera.fov = this.calibratedFOV;
      } else {
        // Top/bottom cropped by object-fit: cover -> compute cropped vertical FOV
        const visibleVFovRad =
          2 * Math.atan(Math.tan(baseVFovRad * 0.5) * (videoAspect / screenAspect));
        camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(visibleVFovRad), 30, 85);
      }
    } else {
      camera.fov = this.calibratedFOV;
    }
    camera.updateProjectionMatrix();
  }

  sampleRoomLight(dt) {
    if (
      this.mode !== 'camera' ||
      !this.videoEl ||
      this.videoEl.readyState < 2 ||
      !this.lightCtx
    ) {
      return null;
    }
    this.lightSampleTimer += dt;
    if (this.lightSampleTimer < 0.5) return null;
    this.lightSampleTimer = 0;

    try {
      this.lightCtx.drawImage(this.videoEl, 0, 0, 16, 16);
      const data = this.lightCtx.getImageData(0, 0, 16, 16).data;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      const count = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        rSum += data[i];
        gSum += data[i + 1];
        bSum += data[i + 2];
      }
      const rAvg = rSum / (count * 255);
      const gAvg = gSum / (count * 255);
      const bAvg = bSum / (count * 255);

      const lum = 0.2126 * rAvg + 0.7152 * gAvg + 0.0722 * bAvg;
      this.rawLuminance = lum;
      this.roomBrightness = THREE.MathUtils.clamp(lum, 0.08, 1.0);

      const maxC = Math.max(rAvg, gAvg, bAvg, 0.05);
      this.roomColor.setRGB(
        THREE.MathUtils.lerp(1.0, rAvg / maxC, 0.45),
        THREE.MathUtils.lerp(1.0, gAvg / maxC, 0.45),
        THREE.MathUtils.lerp(1.0, bAvg / maxC, 0.45)
      );

      return {
        rawLuminance: this.rawLuminance,
        brightness: this.roomBrightness,
        color: this.roomColor,
      };
    } catch {
      return null;
    }
  }

  startPreview(camera) {
    this.stop();
    this.mode = 'preview';
    this.previewYaw = 0;
    this.previewPitch = -0.46;
    camera.position.set(0, 1.4, 0);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(this.previewPitch, this.previewYaw, 0);
    this.smoothedQuat.copy(camera.quaternion);
    this.targetQuat.copy(camera.quaternion);
    this.gyroFilter.reset(this.smoothedQuat);
    this.tiltFilter.reset(0);
    const w = Math.round(window.visualViewport?.width ?? window.innerWidth);
    const h = Math.round(window.visualViewport?.height ?? window.innerHeight);
    this.syncCameraFOV(camera, w, h);
  }

  orbitPreview(dx, dy) {
    if (this.mode !== 'preview') return;
    this.previewYaw = THREE.MathUtils.clamp(this.previewYaw - dx * 0.004, -0.75, 0.75);
    this.previewPitch = THREE.MathUtils.clamp(this.previewPitch - dy * 0.004, -0.85, -0.1);
    this._previewEuler.set(this.previewPitch, this.previewYaw, 0, 'YXZ');
    this.targetQuat.setFromEuler(this._previewEuler);
  }

  bindOrientation() {
    window.addEventListener('deviceorientation', this._onOrientation, true);
    window.addEventListener('orientationchange', this._onScreenOrient);
    this._onScreenOrient();
  }

  _onScreenOrient = () => {
    this.screenOrient = THREE.MathUtils.degToRad(window.orientation || 0);
  };

  _onOrientation = (ev) => {
    if (ev.alpha === null || ev.beta === null || ev.gamma === null) return;
    this.hasGyro = true;

    const gammaDeg = THREE.MathUtils.clamp(ev.gamma, -30, 30);
    const nextTilt = Math.abs(gammaDeg) < 2.5 ? 0 : gammaDeg / 30;
    if (Math.abs(nextTilt - this.rawTiltCurve) >= 0.017) {
      this.rawTiltCurve = nextTilt;
    }

    if (this.mode === 'camera') {
      const alpha = THREE.MathUtils.degToRad(ev.alpha);
      const beta = THREE.MathUtils.degToRad(ev.beta);
      const gamma = THREE.MathUtils.degToRad(ev.gamma);

      this.rawEuler.set(beta, alpha, -gamma, 'YXZ');
      this._tmpQuat.setFromEuler(this.rawEuler);
      this._tmpQuat.multiply(this.qWorld);
      this.qOrient.setFromAxisAngle(this.zAxis, -this.screenOrient);
      this._tmpQuat.multiply(this.qOrient);

      // 0.5 degree dead zone so resting gyro noise never updates target pose
      if (this.targetQuat.angleTo(this._tmpQuat) >= GYRO_DEADZONE_RAD) {
        this.targetQuat.copy(this._tmpQuat);
      }
    }
  };

  updateCameraAndRing(camera, placed, dt = 1 / 60) {
    camera.position.set(0, 1.4, 0);
    if (this.mode === 'camera' && this.hasGyro) {
      this.gyroFilter.filter(this.targetQuat, dt, this.smoothedQuat);
      camera.quaternion.copy(this.smoothedQuat);
      this.tiltCurve = this.tiltFilter.filter(this.rawTiltCurve, dt);
    } else if (this.mode === 'preview') {
      this.smoothedQuat.slerp(this.targetQuat, 0.2);
      camera.quaternion.copy(this.smoothedQuat);
    }

    if (placed) return null;

    // Intersect screen center ray (0, 0) with floor y = 0 + One Euro Filter & 1 cm dead zone
    this.raycaster.setFromCamera(this.aimNDC, camera);
    const hit = this.raycaster.ray.intersectPlane(this.floorPlane, this.rawPos);
    if (hit && this.rawPos.length() <= 7.0) {
      this.rawPos.y = 0;
      const yawQuat = this.computeLevelYawQuat(camera, this._yawQuat);
      if (!this.hasHit) {
        this.ringPosFilter.reset(this.rawPos);
        this.ringQuatFilter.reset(yawQuat);
        this.smoothedPos.copy(this.rawPos);
        this.smoothedRingQuat.copy(yawQuat);
        this.hasHit = true;
      } else {
        this.ringPosFilter.filter(this.rawPos, dt, this.smoothedPos);
        this.ringQuatFilter.filter(yawQuat, dt, this.smoothedRingQuat);
      }
    }

    return {
      ringReady: this.hasHit,
      ringPos: this.smoothedPos,
      ringQuat: this.smoothedRingQuat,
    };
  }

  computeLevelYawQuat(camera, outQuat = null) {
    const dest = outQuat || this._yawQuat;
    camera.getWorldDirection(this._fwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-5) return dest.identity();
    this._fwd.normalize();
    const yaw = Math.atan2(-this._fwd.x, -this._fwd.z);
    return dest.setFromAxisAngle(this._upAxis, yaw);
  }

  resetRing() {
    this.hasHit = false;
    this.ringPosFilter.clear();
    this.ringQuatFilter.clear();
  }

  raycastFloor(ndcX, ndcY, camera, y = 0, outVec = null) {
    this._rayNDC.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this._rayNDC, camera);
    const dest = outVec || this._rayOut;
    if (y === 0) {
      return this.raycaster.ray.intersectPlane(this.floorPlane, dest) ? dest : null;
    }
    this._rayPlane.constant = -y;
    return this.raycaster.ray.intersectPlane(this._rayPlane, dest) ? dest : null;
  }

  getTiltCurve() {
    return this.tiltCurve;
  }

  stop() {
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    window.removeEventListener('orientationchange', this._onScreenOrient);
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
    this.mode = 'none';
  }
}
