import * as THREE from 'three';
import { OneEuroFilterQuat, OneEuroFilterVec3 } from './filters.js';

export class WebXRController {
  constructor() {
    this.session = null;
    this.refSpace = null;
    this.viewerSpace = null;
    this.hitTestSource = null;
    this.lightProbe = null;
    this.anchor = null;
    this.anchorsSupported = false;

    // Depth sensing state
    this.depthEnabled = false;
    this.depthTexture = null;
    this.depthWidth = 0;
    this.depthHeight = 0;
    this.depthIsFloat = false;
    this.depthNormMatrix = new THREE.Matrix4();
    this.rawValueToMeters = 0.001;

    // Smoothed placement ring pose (One Euro Filter + 1 cm / 0.5 deg dead zone)
    this.hasRawHit = false;
    this.smoothedPos = new THREE.Vector3();
    this.smoothedQuat = new THREE.Quaternion();
    this.rawPos = new THREE.Vector3();
    this.rawQuat = new THREE.Quaternion();
    this.ringPosFilter = new OneEuroFilterVec3(1.3, 0.45, 1.0, 0.01);
    this.ringQuatFilter = new OneEuroFilterQuat(
      1.3,
      0.5,
      1.0,
      THREE.MathUtils.degToRad(0.5)
    );

    // Fixed world pose once placed (locked, never overwritten per-frame)
    this.placed = false;
    this.placedPos = new THREE.Vector3();
    this.placedQuat = new THREE.Quaternion();
    this.trackingLost = false;

    // Light estimation reusable outputs
    this.lightData = {
      valid: false,
      dir: new THREE.Vector3(0.4, 0.85, 0.35),
      color: new THREE.Color(0xffffff),
      intensity: 1.0,
      rawIntensity: 1.0,
      shCoefficients: null,
    };

    this._mat = new THREE.Matrix4();
    this._scale = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._upAxis = new THREE.Vector3(0, 1, 0);
    this._yawQuat = new THREE.Quaternion();
  }

  async isSupported() {
    if (!navigator.xr || typeof navigator.xr.isSessionSupported !== 'function') {
      return false;
    }
    try {
      return await navigator.xr.isSessionSupported('immersive-ar');
    } catch {
      return false;
    }
  }

  async start(renderer, domOverlayEl, onEnd) {
    const baseOptional = ['anchors', 'light-estimation', ...(domOverlayEl ? ['dom-overlay'] : [])];

    const sessionInitWithDepth = {
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: [...baseOptional, 'depth-sensing'],
      depthSensing: {
        usagePreference: ['cpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32'],
      },
    };
    if (domOverlayEl) {
      sessionInitWithDepth.domOverlay = { root: domOverlayEl };
    }

    let session;
    try {
      session = await navigator.xr.requestSession('immersive-ar', sessionInitWithDepth);
    } catch {
      // Retry gracefully without depthSensing option if browser rejects depth config
      const fallbackInit = {
        requiredFeatures: ['hit-test', 'local-floor'],
        optionalFeatures: baseOptional,
      };
      if (domOverlayEl) {
        fallbackInit.domOverlay = { root: domOverlayEl };
      }
      session = await navigator.xr.requestSession('immersive-ar', fallbackInit);
    }

    this.session = session;
    this.placed = false;
    this.anchor = null;
    this.hasRawHit = false;
    this.ringPosFilter.clear();
    this.ringQuatFilter.clear();
    this.trackingLost = false;
    this.depthEnabled = session.depthUsage === 'cpu-optimized';
    this.lightProbe = null;

    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);

    this.refSpace = await session.requestReferenceSpace('local-floor');
    this.viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitTestSource = await session.requestHitTestSource({ space: this.viewerSpace });
    this.anchorsSupported =
      typeof XRFrame !== 'undefined' && typeof XRFrame.prototype.createAnchor === 'function';

    if (typeof session.requestLightProbe === 'function') {
      session
        .requestLightProbe({ reflectionFormat: 'srgba8' })
        .then((probe) => {
          this.lightProbe = probe;
        })
        .catch(() => {
          this.lightProbe = null;
        });
    }

    session.addEventListener('end', () => {
      this.cleanup(renderer);
      if (onEnd) onEnd();
    });
  }

  computeLevelYawQuat(camera, outQuat = null) {
    const dest = outQuat || this._yawQuat;
    camera.getWorldDirection(this._fwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-5) {
      return dest.identity();
    }
    this._fwd.normalize();
    const yaw = Math.atan2(-this._fwd.x, -this._fwd.z);
    return dest.setFromAxisAngle(this._upAxis, yaw);
  }

  placeLane(camera) {
    if (!this.hasRawHit) return null;
    this.placed = true;
    this.placedPos.copy(this.smoothedPos);
    this.computeLevelYawQuat(camera, this.placedQuat);
    return { position: this.placedPos.clone(), quaternion: this.placedQuat.clone() };
  }

  resetPlacement() {
    this.placed = false;
    this.hasRawHit = false;
    this.ringPosFilter.clear();
    this.ringQuatFilter.clear();
    if (this.anchor && typeof this.anchor.delete === 'function') {
      try {
        this.anchor.delete();
      } catch {
        // ignore
      }
    }
    this.anchor = null;
  }

  reanchorAt(pos, quat) {
    this.placed = true;
    this.placedPos.copy(pos);
    this.placedQuat.copy(quat);
  }

  _updateLightEstimate(frame) {
    if (!this.lightProbe || typeof frame.getLightEstimate !== 'function') {
      this.lightData.valid = false;
      return;
    }
    try {
      const est = frame.getLightEstimate(this.lightProbe);
      if (!est) {
        this.lightData.valid = false;
        return;
      }
      if (est.primaryLightDirection) {
        this.lightData.dir
          .set(
            est.primaryLightDirection.x,
            est.primaryLightDirection.y,
            est.primaryLightDirection.z
          )
          .normalize();
      }
      if (est.primaryLightIntensity) {
        const r = est.primaryLightIntensity.x;
        const g = est.primaryLightIntensity.y;
        const b = est.primaryLightIntensity.z;
        const maxVal = Math.max(r, g, b, 0.001);
        this.lightData.rawIntensity = maxVal;
        this.lightData.intensity = THREE.MathUtils.clamp(maxVal, 0.25, 2.2);
        this.lightData.color.setRGB(r / maxVal, g / maxVal, b / maxVal);
      }
      if (est.sphericalHarmonicsCoefficients) {
        this.lightData.shCoefficients = est.sphericalHarmonicsCoefficients;
      }
      this.lightData.valid = true;
    } catch {
      this.lightData.valid = false;
    }
  }

  _updateDepth(frame, viewerPose) {
    if (!this.depthEnabled || !viewerPose || typeof frame.getDepthInformation !== 'function') {
      return false;
    }
    const view = viewerPose.views[0];
    if (!view) return false;
    try {
      const depthInfo = frame.getDepthInformation(view);
      if (!depthInfo || !depthInfo.data) return false;

      const w = depthInfo.width;
      const h = depthInfo.height;
      const isFloat = this.session && this.session.depthDataFormat === 'float32';

      if (
        !this.depthTexture ||
        this.depthWidth !== w ||
        this.depthHeight !== h ||
        this.depthIsFloat !== isFloat
      ) {
        if (this.depthTexture) this.depthTexture.dispose();
        this.depthWidth = w;
        this.depthHeight = h;
        this.depthIsFloat = isFloat;
        const data = isFloat ? new Float32Array(w * h) : new Uint8Array(w * h * 2);
        this.depthTexture = new THREE.DataTexture(
          data,
          w,
          h,
          isFloat ? THREE.RedFormat : THREE.RGFormat,
          isFloat ? THREE.FloatType : THREE.UnsignedByteType
        );
        this.depthTexture.minFilter = THREE.LinearFilter;
        this.depthTexture.magFilter = THREE.LinearFilter;
        this.depthTexture.wrapS = THREE.ClampToEdgeWrapping;
        this.depthTexture.wrapT = THREE.ClampToEdgeWrapping;
        this.depthTexture.generateMipmaps = false;
      }

      if (isFloat) {
        this.depthTexture.image.data.set(new Float32Array(depthInfo.data));
      } else {
        this.depthTexture.image.data.set(new Uint8Array(depthInfo.data));
      }
      this.depthTexture.needsUpdate = true;

      if (depthInfo.normDepthBufferFromNormView) {
        this.depthNormMatrix.fromArray(depthInfo.normDepthBufferFromNormView.matrix);
      }
      this.rawValueToMeters = depthInfo.rawValueToMeters || 0.001;
      return true;
    } catch {
      return false;
    }
  }

  updateFrame(frame, camera, dt = 1 / 60) {
    if (!frame || !this.refSpace) return null;

    const viewerPose = frame.getViewerPose(this.refSpace);
    this.trackingLost = !viewerPose;
    if (this.trackingLost) {
      return { trackingLost: true };
    }

    this._updateLightEstimate(frame);
    const hasDepth = this._updateDepth(frame, viewerPose);

    // Before placement: hit-test + One Euro Filter smoothing with 1 cm / 0.5 deg dead zones
    if (!this.placed && this.hitTestSource) {
      const results = frame.getHitTestResults(this.hitTestSource);
      if (results.length > 0) {
        const hitPose = results[0].getPose(this.refSpace);
        if (hitPose) {
          this._mat.fromArray(hitPose.transform.matrix);
          this._mat.decompose(this.rawPos, this.rawQuat, this._scale);

          const yawQuat = this.computeLevelYawQuat(camera, this._yawQuat);
          if (!this.hasRawHit) {
            this.ringPosFilter.reset(this.rawPos);
            this.ringQuatFilter.reset(yawQuat);
            this.smoothedPos.copy(this.rawPos);
            this.smoothedQuat.copy(yawQuat);
            this.hasRawHit = true;
          } else {
            this.ringPosFilter.filter(this.rawPos, dt, this.smoothedPos);
            this.ringQuatFilter.filter(yawQuat, dt, this.smoothedQuat);
          }
          return {
            trackingLost: false,
            ringReady: true,
            ringPos: this.smoothedPos,
            ringQuat: this.smoothedQuat,
            lightData: this.lightData,
            hasDepth,
          };
        }
      }
      return {
        trackingLost: false,
        ringReady: this.hasRawHit,
        ringPos: this.smoothedPos,
        ringQuat: this.smoothedQuat,
        lightData: this.lightData,
        hasDepth,
      };
    }

    // After placement: lane world transform is strictly locked in local-floor space
    return { trackingLost: false, lightData: this.lightData, hasDepth };
  }

  cleanup(renderer) {
    if (this.anchor && typeof this.anchor.delete === 'function') {
      try {
        this.anchor.delete();
      } catch {
        // ignore
      }
    }
    if (this.depthTexture) {
      this.depthTexture.dispose();
      this.depthTexture = null;
    }
    this.anchor = null;
    this.lightProbe = null;
    this.hitTestSource = null;
    this.session = null;
    this.depthEnabled = false;
    if (renderer) renderer.xr.enabled = false;
  }

  stop(renderer) {
    if (this.session) {
      this.session.end().catch(() => {});
    }
    this.cleanup(renderer);
  }
}
