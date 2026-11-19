import * as CANNON from 'cannon-es';

export const LANE_WIDTH = 0.8;
export const LANE_LENGTH = 3.0;
export const APPROACH_LENGTH = 0.7;
export const LANE_SURFACE_Y = 0.085; // 2.5cm plinth + 6.0cm solid lane slab
export const PIT_DEPTH = 0.42;
export const PIT_FLOOR_Y = 0.018;
export const BALL_SPAWN_Z = -0.15;
export const BALL_RADIUS = 0.09;
export const PIN_HEIGHT = 0.31;
export const PIN_RADIUS = 0.044;
export const GUTTER_WIDTH = 0.135;
export const GUTTER_FLOOR_Y = LANE_SURFACE_Y - 0.045;

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;
const MAX_BALL_SPEED = 10.5;

export class BowlingPhysics {
  constructor() {
    this.world = new CANNON.World();
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    this.world.solver.iterations = 14;
    this.world.gravity.set(0, -9.81, 0);

    this.laneMat = new CANNON.Material('lane');
    this.ballMat = new CANNON.Material('ball');
    this.pinMat = new CANNON.Material('pin');
    this.wallMat = new CANNON.Material('wall');

    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.laneMat, this.ballMat, {
        friction: 0.036,
        restitution: 0.28,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.laneMat, this.pinMat, {
        friction: 0.65,
        restitution: 0.08,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.ballMat, this.pinMat, {
        friction: 0.18,
        restitution: 0.56,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.pinMat, this.pinMat, {
        friction: 0.36,
        restitution: 0.48,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.ballMat, this.wallMat, {
        friction: 0.1,
        restitution: 0.45,
      })
    );

    this.staticBodies = [];
    this.pins = [];
    this.obstacles = [];
    this.ballBody = null;
    this.accumulator = 0;
    this.elapsed = 0;
    this.curveInput = 0;
    this.onPinHit = null;

    this._up = new CANNON.Vec3(0, 1, 0);
    this._localUp = new CANNON.Vec3();
    this._curveForce = new CANNON.Vec3();
  }

  loadLevel(level, onPinHit) {
    this.clearAll();
    this.onPinHit = onPinHit;
    this.accumulator = 0;
    this.elapsed = 0;

    const w = LANE_WIDTH * (level.laneWidthScale || 1.0);
    const totalWoodLen = APPROACH_LENGTH + LANE_LENGTH;
    const deckCenterZ = (APPROACH_LENGTH - LANE_LENGTH) * 0.5;

    // Solid playing + approach deck (top exactly at LANE_SURFACE_Y)
    const deck = new CANNON.Body({
      mass: 0,
      material: this.laneMat,
      shape: new CANNON.Box(new CANNON.Vec3(w * 0.5, 0.0425, totalWoodLen * 0.5)),
    });
    deck.position.set(0, LANE_SURFACE_Y - 0.0425, deckCenterZ);
    this.world.addBody(deck);
    this.staticBodies.push(deck);

    // Recessed curved-equivalent gutters + outer kickback walls
    const gutterLen = totalWoodLen + PIT_DEPTH;
    const gutterCenterZ = (APPROACH_LENGTH - (LANE_LENGTH + PIT_DEPTH)) * 0.5;
    [-1, 1].forEach((side) => {
      // Gutter bed (4.5 cm recessed below lane surface so ball visibly drops in)
      const gutter = new CANNON.Body({
        mass: 0,
        material: this.laneMat,
        shape: new CANNON.Box(new CANNON.Vec3(GUTTER_WIDTH * 0.5, 0.02, gutterLen * 0.5)),
      });
      gutter.position.set(
        side * (w * 0.5 + GUTTER_WIDTH * 0.5),
        GUTTER_FLOOR_Y - 0.02,
        gutterCenterZ
      );
      this.world.addBody(gutter);
      this.staticBodies.push(gutter);

      // Outer curb / kickback wall
      const wall = new CANNON.Body({
        mass: 0,
        material: this.wallMat,
        shape: new CANNON.Box(new CANNON.Vec3(0.03, 0.16, gutterLen * 0.5)),
      });
      wall.position.set(
        side * (w * 0.5 + GUTTER_WIDTH + 0.03),
        LANE_SURFACE_Y + 0.06,
        gutterCenterZ
      );
      this.world.addBody(wall);
      this.staticBodies.push(wall);
    });

    // Dark pit floor + rear pit wall behind -LANE_LENGTH
    const pitFloor = new CANNON.Body({
      mass: 0,
      material: this.wallMat,
      shape: new CANNON.Box(new CANNON.Vec3(w * 0.5 + GUTTER_WIDTH, 0.02, PIT_DEPTH * 0.5)),
    });
    pitFloor.position.set(0, PIT_FLOOR_Y - 0.02, -LANE_LENGTH - PIT_DEPTH * 0.5);
    this.world.addBody(pitFloor);
    this.staticBodies.push(pitFloor);

    const backWall = new CANNON.Body({
      mass: 0,
      material: this.wallMat,
      shape: new CANNON.Box(new CANNON.Vec3(w * 0.85, 0.38, 0.05)),
    });
    backWall.position.set(0, LANE_SURFACE_Y + 0.25, -LANE_LENGTH - PIT_DEPTH - 0.04);
    this.world.addBody(backWall);
    this.staticBodies.push(backWall);

    // Pins (high damping + sleep thresholds so idle pins never vibrate)
    const pinMass = 1.45 * (level.pinMassScale || 1.0);
    level.layout.forEach((p, idx) => {
      const body = new CANNON.Body({
        mass: pinMass,
        material: this.pinMat,
        linearDamping: 0.24,
        angularDamping: 0.3,
        shape: new CANNON.Cylinder(PIN_RADIUS * 0.7, PIN_RADIUS, PIN_HEIGHT, 10),
      });
      body.position.set(p.x, LANE_SURFACE_Y + PIN_HEIGHT * 0.5, p.z);
      body.allowSleep = true;
      body.sleepSpeedLimit = 0.22;
      body.sleepTimeLimit = 0.25;
      body.sleep();

      const pin = {
        id: idx,
        body,
        initialX: p.x,
        initialZ: p.z,
        knocked: false,
        inPit: false,
        hitCooldown: 0,
      };

      body.addEventListener('collide', (e) => {
        if (pin.hitCooldown > 0) return;
        const relVel = Math.abs(e.contact.getImpactVelocityAlongNormal());
        if (relVel > 0.85) {
          pin.hitCooldown = 0.16;
          if (this.onPinHit) {
            this.onPinHit(Math.min(relVel / 5, 1.3), body.position);
          }
        }
      });

      this.world.addBody(body);
      this.pins.push(pin);
    });

    // Obstacle blocks
    (level.obstacles || []).forEach((obs) => {
      const bw = (obs.width || 0.22) * 0.5;
      const body = new CANNON.Body({
        mass: 0,
        type: obs.moveAmp ? CANNON.Body.KINEMATIC : CANNON.Body.STATIC,
        material: this.wallMat,
        shape: new CANNON.Box(new CANNON.Vec3(bw, 0.09, 0.05)),
      });
      body.position.set(obs.x, LANE_SURFACE_Y + 0.09, obs.z);
      this.world.addBody(body);
      this.obstacles.push({
        body,
        baseX: obs.x,
        z: obs.z,
        moveAmp: obs.moveAmp || 0,
        moveSpeed: obs.moveSpeed || 1.2,
      });
    });
  }

  throwBall(aimAngleRad, speedNorm, sideSwipe) {
    this.removeBall();
    const speed = Math.min(MAX_BALL_SPEED, 4.3 + speedNorm * 4.8);
    const vx = Math.sin(aimAngleRad) * speed;
    const vz = -Math.cos(aimAngleRad) * speed;

    const body = new CANNON.Body({
      mass: 6.2,
      material: this.ballMat,
      shape: new CANNON.Sphere(BALL_RADIUS),
      linearDamping: 0.055,
      angularDamping: 0.08,
    });
    body.allowSleep = true;
    body.sleepSpeedLimit = 0.16;
    body.sleepTimeLimit = 0.3;
    // Slight loft on release so it makes a crisp first contact bounce then rolls smoothly
    body.position.set(0, LANE_SURFACE_Y + BALL_RADIUS + 0.036, BALL_SPAWN_Z);
    body.velocity.set(vx, -0.35, vz);
    body.angularVelocity.set(vz / BALL_RADIUS, sideSwipe * 8, -sideSwipe * 4);

    this.world.addBody(body);
    this.ballBody = body;
    this.curveInput = sideSwipe;
  }

  setTiltCurve(tilt) {
    this.curveInput = Math.max(-1, Math.min(1, tilt));
  }

  step(dt) {
    const safeDt = Math.min(dt, 0.05);
    this.accumulator += safeDt;

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.elapsed += FIXED_DT;

      for (const obs of this.obstacles) {
        if (obs.moveAmp > 0) {
          obs.body.position.x =
            obs.baseX + Math.sin(this.elapsed * obs.moveSpeed) * obs.moveAmp;
        }
      }

      // Only apply lane curve while ball is on the lane surface (not dropped in gutter)
      if (
        this.ballBody &&
        this.ballBody.position.y >= LANE_SURFACE_Y + BALL_RADIUS * 0.72 &&
        this.ballBody.velocity.z < -0.4
      ) {
        this._curveForce.set(this.curveInput * 3.2, 0, 0);
        this.ballBody.applyForce(this._curveForce, this.ballBody.position);
        const speedSq = this.ballBody.velocity.lengthSquared();
        if (speedSq > MAX_BALL_SPEED * MAX_BALL_SPEED) {
          this.ballBody.velocity.scale(
            MAX_BALL_SPEED / Math.sqrt(speedSq),
            this.ballBody.velocity
          );
        }
      }

      this.world.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }

    const newlyKnocked = [];
    for (const pin of this.pins) {
      if (pin.hitCooldown > 0) pin.hitCooldown = Math.max(0, pin.hitCooldown - safeDt);

      if (!pin.inPit && (pin.body.position.z < -LANE_LENGTH - 0.02 || pin.body.position.y < LANE_SURFACE_Y - 0.05)) {
        pin.inPit = true;
      }

      if (pin.knocked) continue;

      pin.body.quaternion.vmult(this._up, this._localUp);
      if (this._localUp.y < 0.78 || pin.inPit) {
        pin.knocked = true;
        newlyKnocked.push(pin);
      } else if (
        pin.body.sleepState === 0 &&
        this.elapsed > 0.25 &&
        pin.body.velocity.lengthSquared() < 0.015 &&
        pin.body.angularVelocity.lengthSquared() < 0.03
      ) {
        pin.body.velocity.set(0, 0, 0);
        pin.body.angularVelocity.set(0, 0, 0);
        pin.body.sleep();
      }
    }
    return newlyKnocked;
  }

  clearKnockedAndResetStanding() {
    this.accumulator = 0;
    const remaining = [];
    for (const pin of this.pins) {
      if (pin.knocked) {
        this.world.removeBody(pin.body);
      } else {
        pin.body.position.set(pin.initialX, LANE_SURFACE_Y + PIN_HEIGHT * 0.5, pin.initialZ);
        pin.body.quaternion.set(0, 0, 0, 1);
        pin.body.velocity.set(0, 0, 0);
        pin.body.angularVelocity.set(0, 0, 0);
        pin.body.sleep();
        remaining.push(pin);
      }
    }
    this.pins = remaining;
    this.removeBall();
  }

  removeBall() {
    if (this.ballBody) {
      this.world.removeBody(this.ballBody);
      this.ballBody = null;
    }
  }

  isSettled(rollTime) {
    if (!this.ballBody) return true;
    if (rollTime > 4.2) return true;
    const p = this.ballBody.position;
    const v = this.ballBody.velocity;
    if (p.z < -LANE_LENGTH - 0.05 && rollTime > 1.45) {
      const movingPin = this.pins.some(
        (pin) => !pin.knocked && pin.body.velocity.lengthSquared() > 0.18
      );
      if (!movingPin) return true;
    }
    if (rollTime > 1.35 && v.lengthSquared() < 0.04) {
      const movingPin = this.pins.some((pin) => pin.body.velocity.lengthSquared() > 0.16);
      if (!movingPin) return true;
    }
    return false;
  }

  clearAll() {
    this.removeBall();
    for (const b of this.staticBodies) this.world.removeBody(b);
    this.staticBodies = [];
    for (const p of this.pins) this.world.removeBody(p.body);
    this.pins = [];
    for (const o of this.obstacles) this.world.removeBody(o.body);
    this.obstacles = [];
  }
}
