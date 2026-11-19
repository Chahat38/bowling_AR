import * as THREE from 'three';

function smoothingAlpha(cutoff, dt) {
  const safeDt = Math.max(dt, 1 / 240);
  const tau = 1 / (2 * Math.PI * Math.max(cutoff, 0.01));
  return THREE.MathUtils.clamp(safeDt / (safeDt + tau), 0.02, 0.9);
}

/**
 * 1D One Euro Filter for low-jitter responsiveness.
 */
export class OneEuroFilterScalar {
  constructor(minCutoff = 1.2, beta = 0.6, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.initialized = false;
    this.prevRaw = 0;
    this.prevFiltered = 0;
    this.prevDeriv = 0;
  }

  reset(value = 0) {
    this.initialized = true;
    this.prevRaw = value;
    this.prevFiltered = value;
    this.prevDeriv = 0;
  }

  filter(raw, dt) {
    if (!this.initialized) {
      this.reset(raw);
      return raw;
    }
    const safeDt = Math.max(dt, 1 / 240);
    const deriv = (raw - this.prevRaw) / safeDt;
    const dAlpha = smoothingAlpha(this.dCutoff, safeDt);
    this.prevDeriv = THREE.MathUtils.lerp(this.prevDeriv, deriv, dAlpha);

    const cutoff = this.minCutoff + this.beta * Math.abs(this.prevDeriv);
    const alpha = smoothingAlpha(cutoff, safeDt);
    this.prevFiltered = THREE.MathUtils.lerp(this.prevFiltered, raw, alpha);
    this.prevRaw = raw;
    return this.prevFiltered;
  }
}

/**
 * 3D Vector One Euro Filter with resting position dead zone (default 1 cm).
 */
export class OneEuroFilterVec3 {
  constructor(minCutoff = 1.4, beta = 0.5, dCutoff = 1.0, deadZoneMeters = 0.01) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.deadZoneSq = deadZoneMeters * deadZoneMeters;
    this.initialized = false;
    this.acceptedTarget = new THREE.Vector3();
    this.prevTarget = new THREE.Vector3();
    this.filtered = new THREE.Vector3();
    this.prevSpeed = 0;
  }

  reset(vec) {
    this.initialized = true;
    this.acceptedTarget.copy(vec);
    this.prevTarget.copy(vec);
    this.filtered.copy(vec);
    this.prevSpeed = 0;
  }

  clear() {
    this.initialized = false;
  }

  filter(raw, dt, out = null) {
    const dest = out || this.filtered;
    if (!this.initialized) {
      this.reset(raw);
      dest.copy(this.filtered);
      return dest;
    }

    if (raw.distanceToSquared(this.acceptedTarget) >= this.deadZoneSq) {
      this.acceptedTarget.copy(raw);
    }

    const safeDt = Math.max(dt, 1 / 240);
    const speed = this.acceptedTarget.distanceTo(this.prevTarget) / safeDt;
    const dAlpha = smoothingAlpha(this.dCutoff, safeDt);
    this.prevSpeed = THREE.MathUtils.lerp(this.prevSpeed, speed, dAlpha);

    const cutoff = this.minCutoff + this.beta * this.prevSpeed;
    const alpha = THREE.MathUtils.clamp(smoothingAlpha(cutoff, safeDt), 0.08, 0.32);

    this.filtered.lerp(this.acceptedTarget, alpha);
    if (this.filtered.distanceToSquared(this.acceptedTarget) < 1e-8) {
      this.filtered.copy(this.acceptedTarget);
    }
    this.prevTarget.copy(this.acceptedTarget);
    if (dest !== this.filtered) dest.copy(this.filtered);
    return dest;
  }
}

/**
 * Quaternion One Euro Filter using shortest-path slerp and angular dead zone (default 0.5 deg).
 */
export class OneEuroFilterQuat {
  constructor(
    minCutoff = 1.2,
    beta = 0.8,
    dCutoff = 1.0,
    deadZoneRad = THREE.MathUtils.degToRad(0.5)
  ) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.deadZoneRad = deadZoneRad;
    this.initialized = false;
    this.acceptedTarget = new THREE.Quaternion();
    this.prevTarget = new THREE.Quaternion();
    this.filtered = new THREE.Quaternion();
    this.prevSpeed = 0;
  }

  reset(quat) {
    this.initialized = true;
    this.acceptedTarget.copy(quat).normalize();
    this.prevTarget.copy(this.acceptedTarget);
    this.filtered.copy(this.acceptedTarget);
    this.prevSpeed = 0;
  }

  clear() {
    this.initialized = false;
  }

  filter(raw, dt, out = null) {
    const dest = out || this.filtered;
    if (!this.initialized) {
      this.reset(raw);
      dest.copy(this.filtered);
      return dest;
    }

    if (raw.angleTo(this.acceptedTarget) >= this.deadZoneRad) {
      this.acceptedTarget.copy(raw).normalize();
    }

    const safeDt = Math.max(dt, 1 / 240);
    const angSpeed = this.acceptedTarget.angleTo(this.prevTarget) / safeDt;
    const dAlpha = smoothingAlpha(this.dCutoff, safeDt);
    this.prevSpeed = THREE.MathUtils.lerp(this.prevSpeed, angSpeed, dAlpha);

    const cutoff = this.minCutoff + this.beta * this.prevSpeed;
    const alpha = THREE.MathUtils.clamp(smoothingAlpha(cutoff, safeDt), 0.08, 0.45);

    this.filtered.slerp(this.acceptedTarget, alpha);
    if (this.filtered.angleTo(this.acceptedTarget) < 1e-4) {
      this.filtered.copy(this.acceptedTarget);
    }
    this.prevTarget.copy(this.acceptedTarget);
    if (dest !== this.filtered) dest.copy(this.filtered);
    return dest;
  }
}
