import { solveFabrik } from './ik/fabrik';
import { solveTwoBone } from './ik/twoBone';
import { clamp, damp, dampAngle, easeInOutSine, lerp, Spring, wrapAngle } from './math/motion';
import { copy, vec2, type Vec2 } from './math/vec2';
import { distance3, set3, vec3, type Vec3 } from './math/vec3';
import { Ball, GRAVITY, type Yard } from './physics/Ball';
import { BODY, createRig, type Leg, type PetRig } from './rig/PetRig';

export type PetBehavior = 'idle' | 'sit' | 'walk' | 'fetch';
export type FetchPhase = 'none' | 'chase' | 'return';

/** Where the pointer touches the ground (world x, z), provided by any input layer. */
export interface PointerState {
  x: number;
  z: number;
  active: boolean;
}

export interface SimulationOptions {
  yard?: Yard;
  /** Injectable RNG so tests can run repeatable, seeded scenarios. */
  random?: () => number;
}

export const DEFAULT_YARD: Yard = { minX: -420, maxX: 420, minZ: -560, maxZ: 230 };
/** Where the player stands: the pet brings the ball back here. */
export const PLAYER = { x: 0, z: 140 };
/** Where thrown balls start: the player's hand, just in front of the camera. */
export const HAND = vec3(0, 70, 215);
/** A point near the camera, for the pet to look at "you". */
const VIEWER = vec3(0, 170, 560);

const SPEED = { idle: 120, walk: 85, chase: 340, return: 170 };
const MARGIN = 60; // keep the pet's centre this far inside the yard
/** Horizontal distance from the body centre to the mouth when the pet reaches for the ground. */
const MOUTH_REACH = 72;
const CATCH_RADIUS = 10;
/** Sitting pose: body tilt (chest up) and body-centre height with the haunches on the ground. */
const SIT_PITCH = 0.55;
const SIT_HEIGHT = 40;
/** How far forward the rear paws tuck under the body when sitting. */
const SIT_REAR_TUCK = 16;
const MAX_TURN_RATE = 6; // rad/s

const NECK_REST_TOTAL = BODY.neckSegments * BODY.neckSegmentLength;
const MOUTH_LENGTH = Math.hypot(BODY.mouth.x, BODY.mouth.y);
const MAX_REACH = NECK_REST_TOTAL * BODY.maxNeckStretch + MOUTH_LENGTH;

/**
 * The pet's simulation: behaviours, 3D steering, IK and secondary motion.
 *
 * Pure TypeScript with no DOM, WebGL or timers: the caller passes in time (`dt`) and input
 * (`PointerState`) and reads back plain numbers from `rig` and `ball`. The same core could
 * drive a React Native view or a headless test (see the `*.test.ts` files).
 *
 * The pet moves on the ground plane (position + yaw). Its body is a 2D side-on rig (legs,
 * neck, tail) solved in its own sagittal plane, which the renderer places in the world. Feet
 * are planted in world space, so they stay fixed while the body walks and turns over them.
 *
 * Every per-frame calculation uses frame-rate independent integration (exponential damping,
 * analytic springs, fixed-step ball physics), so the pet behaves the same at 60 Hz and 120 Hz.
 * All working vectors are preallocated, so `update` does not allocate.
 */
export class PetSimulation {
  readonly rig: PetRig;
  readonly ball: Ball;
  readonly yard: Yard;
  /** Where the ball is predicted to land (exposed for the debug overlay). */
  readonly landing = vec3();
  /** Neck IK target in the sagittal plane (exposed for the debug overlay). */
  readonly headTarget = vec2();
  /** Current steering target on the ground, if any (exposed for the debug overlay). */
  readonly moveTarget = vec2();
  hasMoveTarget = false;

  behavior: PetBehavior = 'idle';
  fetchPhase: FetchPhase = 'none';
  onBehaviorChange?: (behavior: PetBehavior, phase: FetchPhase) => void;

  private readonly random: () => number;
  private readonly pointer: PointerState = { x: 0, z: 0, active: false };
  private readonly lookTarget = vec3();

  private time = 0;
  private stateTime = 0;
  private speed = 0;
  private prevSpeed = 0;
  private yawRate = 0;
  private maxSpeed = SPEED.idle;
  private faceYaw = NaN;
  private turnTo = NaN;
  private behindTimer = 0;
  private readonly waypoint = vec2();
  private waypointPause = 0;
  private excitementTarget = 0;
  private reaching = false;
  /** 0 = standing, 1 = fully seated; eased so sitting down and getting up are animated. */
  private sit = 0;

  private breathPhase = 0;
  private wagPhase = 0;
  private blinkTimer = 2;
  private blinkElapsed = -1;
  private readonly blinkDuration = 0.14;
  private readonly earSpring = new Spring(0, 15, 0.28);
  private prevHeadAngle = 0;
  private prevHeadYaw = 0;
  private readonly neckLengths: number[];

  // Scratch vectors (avoid per-frame allocation).
  private readonly local = vec3();
  private readonly footTmp = vec2();
  private readonly neckBase = vec2();

  constructor(options: SimulationOptions = {}) {
    this.yard = options.yard ?? DEFAULT_YARD;
    this.random = options.random ?? Math.random;
    this.ball = new Ball(this.yard);
    // Start with the ball at the player's feet, ready to throw.
    this.ball.state = 'resting';
    set3(this.ball.pos, PLAYER.x + 40, this.ball.radius, PLAYER.z + 30);

    this.rig = createRig(0, -90, Math.PI / 2 - 0.9);
    this.neckLengths = this.rig.neckRestLengths.slice();
    this.resetPose();
  }

  get status(): string {
    return this.behavior === 'fetch' ? `fetch:${this.fetchPhase}` : this.behavior;
  }

  /** True while the pet is reaching for the ball with IK (for the debug overlay). */
  get isReaching(): boolean {
    return this.reaching;
  }

  /** The player can throw unless the pet is carrying the ball. */
  get canThrow(): boolean {
    return this.ball.state !== 'held';
  }

  // Public API

  setBehavior(behavior: PetBehavior): void {
    if (behavior === 'fetch') {
      this.throwRandom();
      return;
    }
    if (behavior === this.behavior) return;
    this.enter(behavior);
  }

  /** Throws the ball from the player's hand so it lands at (x, z). */
  throwTo(x: number, z: number): boolean {
    if (!this.canThrow) return false;
    const r = this.ball.radius;
    const tx = clamp(x, this.yard.minX + 20, this.yard.maxX - 20);
    const tz = clamp(z, this.yard.minZ + 20, this.yard.maxZ - 20);
    const dist = Math.hypot(tx - HAND.x, tz - HAND.z);
    // Longer throws get a longer, higher arc. Solve y(T) = r for vy given flight time T.
    const T = clamp(0.55 + dist / 1100, 0.55, 1.3);
    const vx = (tx - HAND.x) / T;
    const vz = (tz - HAND.z) / T;
    const vy = (r - HAND.y + 0.5 * GRAVITY * T * T) / T;
    return this.launch(vx, vy, vz);
  }

  /** Throws the ball from the player's hand with an explicit velocity (e.g. from a flick). */
  throwWithVelocity(vx: number, vy: number, vz: number): boolean {
    if (!this.canThrow) return false;
    return this.launch(vx, vy, vz);
  }

  update(rawDt: number, pointer: PointerState): void {
    // A long frame (tab switch, debugger pause) must not teleport the pet.
    const dt = clamp(rawDt, 0, 0.05);
    this.pointer.x = pointer.x;
    this.pointer.z = pointer.z;
    this.pointer.active = pointer.active;

    this.time += dt;
    this.stateTime += dt;

    this.ball.update(dt);
    this.updateBehavior(dt);
    this.updateLocomotion(dt);
    this.updateBody(dt);
    this.updateLegs(dt);
    this.updateNeckAndHead(dt);
    this.updateFace(dt);
    this.updateTail(dt);
    this.updateFetchContact();
  }

  // Behaviour state machine

  private enter(behavior: PetBehavior, phase: FetchPhase = 'none'): void {
    if (this.behavior === 'fetch' && behavior !== 'fetch' && this.ball.state === 'held') {
      this.dropBall();
    }
    this.behavior = behavior;
    this.fetchPhase = phase;
    this.stateTime = 0;
    this.turnTo = NaN;
    if (behavior === 'walk') this.pickWaypoint();
    this.onBehaviorChange?.(behavior, phase);
  }

  private launch(vx: number, vy: number, vz: number): boolean {
    this.ball.throwFrom(HAND.x, HAND.y, HAND.z, vx, vy, vz);
    this.enter('fetch', 'chase');
    return true;
  }

  private throwRandom(): void {
    const { yard, rig } = this;
    let x = 0;
    let z = 0;
    for (let i = 0; i < 10; i++) {
      x = lerp(yard.minX + 70, yard.maxX - 70, this.random());
      z = lerp(yard.minZ + 70, yard.maxZ - 140, this.random());
      if (Math.hypot(x - rig.position.x, z - rig.position.y) > 180) break;
    }
    this.throwTo(x, z);
  }

  private dropBall(): void {
    const { mouth, yaw } = this.rig;
    this.ball.throwFrom(mouth.x, mouth.y, mouth.z, Math.cos(yaw) * 70, 60, Math.sin(yaw) * 70);
  }

  private pickWaypoint(): void {
    const { yard } = this;
    this.waypoint.x = lerp(yard.minX + 120, yard.maxX - 120, this.random());
    this.waypoint.y = lerp(yard.minZ + 120, yard.maxZ - 120, this.random());
  }

  private updateBehavior(dt: number): void {
    const { rig, pointer } = this;
    const pos = rig.position;
    this.reaching = false;
    this.hasMoveTarget = false;
    this.faceYaw = NaN;

    // Default gaze: where the pointer touches the ground, or the viewer if there is no pointer.
    if (pointer.active) set3(this.lookTarget, pointer.x, 10, pointer.z);
    else set3(this.lookTarget, VIEWER.x, VIEWER.y, VIEWER.z);

    switch (this.behavior) {
      case 'idle': {
        this.maxSpeed = SPEED.idle;
        this.excitementTarget = 0;
        // Turn the whole body if the gaze target stays far off to the side.
        const l = this.toPetLocal(this.local, this.lookTarget);
        const angle = Math.atan2(l.z, l.x);
        this.behindTimer = Math.abs(angle) > 1.0 ? this.behindTimer + dt : 0;
        if (this.behindTimer > 0.45) {
          this.turnTo = rig.yaw + angle;
          this.behindTimer = 0;
        }
        if (!Number.isNaN(this.turnTo)) {
          this.faceYaw = this.turnTo;
          if (Math.abs(wrapAngle(rig.yaw - this.turnTo)) < 0.05) this.turnTo = NaN;
        }
        break;
      }

      case 'sit': {
        // Stay put; the head and eyes still follow the pointer (or the viewer).
        this.maxSpeed = 0;
        this.excitementTarget = 0.1;
        break;
      }

      case 'walk': {
        this.maxSpeed = SPEED.walk;
        this.excitementTarget = 0.3;
        if (this.waypointPause > 0) {
          this.waypointPause -= dt;
        } else {
          copy(this.moveTarget, this.waypoint);
          this.hasMoveTarget = true;
          if (Math.hypot(this.waypoint.x - pos.x, this.waypoint.y - pos.y) < 25) {
            this.pickWaypoint();
            this.waypointPause = 0.6 + this.random() * 1.2;
          }
        }
        break;
      }

      case 'fetch': {
        if (this.fetchPhase === 'chase') this.updateChase();
        else if (this.fetchPhase === 'return') this.updateReturn();
        break;
      }
    }

    const rising = this.excitementTarget > rig.excitement;
    rig.excitement = damp(rig.excitement, this.excitementTarget, rising ? 3 : 0.4, dt);
  }

  private updateChase(): void {
    const { rig, ball } = this;
    const pos = rig.position;
    this.maxSpeed = SPEED.chase;
    this.excitementTarget = 1;

    // Run to where the ball is going to be, not where it is now.
    ball.predictLanding(this.landing);
    const target = ball.state === 'flying' ? this.landing : ball.pos;
    const dx = target.x - pos.x;
    const dz = target.z - pos.y;
    const d = Math.hypot(dx, dz);
    if (d > MOUTH_REACH + 4) {
      // Stop short so the mouth, not the body centre, ends up at the ball.
      this.moveTarget.x = this.clampX(target.x - (dx / d) * MOUTH_REACH);
      this.moveTarget.y = this.clampZ(target.z - (dz / d) * MOUTH_REACH);
      this.hasMoveTarget = true;
    }
    this.faceYaw = Math.atan2(dz, dx);
    set3(this.lookTarget, ball.pos.x, ball.pos.y, ball.pos.z);

    // Reach with the neck when the ball is in front and within the stretched neck's range.
    const l = this.toPetLocal(this.local, ball.pos);
    const nb = this.toSagittal(this.neckBase, BODY.neckBase);
    const forward = l.x - nb.x;
    const dist = Math.hypot(forward, l.z, -l.y - nb.y);
    this.reaching = forward > -4 && Math.abs(l.z) < 26 && dist < MAX_REACH * 1.05;
  }

  private updateReturn(): void {
    const { rig } = this;
    this.maxSpeed = SPEED.return;
    this.excitementTarget = 0.75;
    this.moveTarget.x = PLAYER.x;
    this.moveTarget.y = PLAYER.z;
    this.hasMoveTarget = true;
    this.faceYaw = Math.PI / 2; // face the player (towards the camera, +z)
    set3(this.lookTarget, VIEWER.x, VIEWER.y, VIEWER.z);

    const home = Math.hypot(rig.position.x - PLAYER.x, rig.position.y - PLAYER.z) < 10;
    const facing = Math.abs(wrapAngle(rig.yaw - this.faceYaw)) < 0.3;
    if (home && facing && Math.abs(this.speed) < 15 && this.stateTime > 0.6) {
      this.dropBall();
      this.enter('idle');
    }
  }

  /** Catches the ball when the mouth touches it, and carries it while it is held. */
  private updateFetchContact(): void {
    const { ball, rig } = this;
    if (this.behavior === 'fetch' && this.fetchPhase === 'chase' && ball.state !== 'hidden') {
      if (distance3(rig.mouth, ball.pos) < ball.radius + CATCH_RADIUS) {
        ball.hold(rig.mouth);
        this.earSpring.velocity -= 6; // ears perk up on the catch
        this.enter('fetch', 'return');
      }
    }
    if (ball.state === 'held') ball.hold(rig.mouth);
  }

  // Locomotion and body

  private updateLocomotion(dt: number): void {
    const { rig } = this;
    const pos = rig.position;
    this.prevSpeed = this.speed;
    const prevYaw = rig.yaw;

    let desired = 0;
    const dx = this.moveTarget.x - pos.x;
    const dz = this.moveTarget.y - pos.y;
    const d = Math.hypot(dx, dz);
    if (this.hasMoveTarget && d > 3) {
      // Steer towards the target; slow down (and turn on the spot) when facing away from it.
      const heading = Math.atan2(dz, dx);
      this.turnTowards(heading, this.behavior === 'fetch' ? 9 : 5, dt);
      const alignment = Math.max(0, Math.cos(wrapAngle(heading - rig.yaw)));
      desired = Math.min(this.maxSpeed, d * 3) * alignment * alignment;
    } else if (!Number.isNaN(this.faceYaw)) {
      this.turnTowards(this.faceYaw, 7, dt);
    }

    // Ease in and out of sitting; the pet can't move until it has (mostly) stood up.
    this.sit = damp(this.sit, this.behavior === 'sit' ? 1 : 0, this.behavior === 'sit' ? 4 : 6, dt);
    desired *= (1 - this.sit) * (1 - this.sit);

    this.speed = damp(this.speed, desired, this.behavior === 'fetch' ? 6 : 4, dt);
    pos.x = this.clampX(pos.x + Math.cos(rig.yaw) * this.speed * dt);
    pos.y = this.clampZ(pos.y + Math.sin(rig.yaw) * this.speed * dt);
    this.yawRate = dt > 0 ? wrapAngle(rig.yaw - prevYaw) / dt : 0;
  }

  /** Exponential turn towards `target`, capped at MAX_TURN_RATE so big turns look physical. */
  private turnTowards(target: number, lambda: number, dt: number): void {
    const delta = wrapAngle(target - this.rig.yaw);
    const step = clamp(delta * (1 - Math.exp(-lambda * dt)), -MAX_TURN_RATE * dt, MAX_TURN_RATE * dt);
    this.rig.yaw = wrapAngle(this.rig.yaw + step);
  }

  private updateBody(dt: number): void {
    const { rig, ball } = this;

    // Breathing: slow and deep when calm, quick panting when excited.
    const breathHz = lerp(0.32, 2.4, Math.pow(rig.excitement, 1.5));
    this.breathPhase += dt * breathHz * Math.PI * 2;
    rig.breath = Math.sin(this.breathPhase);

    // Pitch: a slow weight shift when idle, lean into a run, rear up to reach a high ball.
    const speedRatio = Math.min(1, Math.abs(this.speed) / SPEED.chase);
    let pitchTarget = 0.025 * Math.sin(this.time * 0.9) - 0.06 * speedRatio;
    if (this.reaching) {
      const above = this.neckBase.y + ball.pos.y; // sagittal y is minus the height
      pitchTarget = clamp(above / 110, -0.14, 0.45);
    }
    // Sitting: chest up, haunches down.
    pitchTarget = lerp(pitchTarget, SIT_PITCH, this.sit);
    rig.pitch = damp(rig.pitch, pitchTarget, 7, dt);

    // Standing: pivot the pitch around the hips (keeps the back feet down), plus breath and gait
    // bob. Sitting: lower the body centre so the rump rests on the ground.
    const gaitBob = Math.abs(Math.sin(this.time * 14)) * 2.5 * Math.min(1, Math.abs(this.speed) / 150);
    const standY = -BODY.standHeight - Math.sin(rig.pitch) * BODY.hipToRearPivot + rig.breath * 1.2 - gaitBob;
    const sitY = -SIT_HEIGHT + rig.breath * 0.8;
    rig.root.y = lerp(standY, sitY, this.sit);
  }

  private updateLegs(dt: number): void {
    const { rig } = this;
    const pos = rig.position;
    const c = Math.cos(rig.yaw);
    const s = Math.sin(rig.yaw);
    // Turning on the spot also needs steps, so count yaw rate as movement.
    const activity = Math.abs(this.speed) + Math.abs(this.yawRate) * 40;
    const groupStepping = [false, false];
    for (const leg of rig.legs) if (leg.stepT >= 0) groupStepping[leg.group] = true;

    for (const leg of rig.legs) {
      this.toSagittal(leg.hip, leg.anchor);

      // Where the foot "wants" to be, in the world: under its hip, a little ahead when moving.
      const tuck = leg.front ? 0 : SIT_REAR_TUCK * this.sit; // rear paws tuck forward when sitting
      const homeFwd = leg.hip.x + (leg.front ? 3 : -3) + this.speed * 0.11 + tuck;
      const homeX = pos.x + c * homeFwd - s * leg.side;
      const homeZ = pos.y + s * homeFwd + c * leg.side;

      if (leg.stepT >= 0) {
        leg.stepTo.x = homeX; // keep re-targeting as the body moves
        leg.stepTo.y = homeZ;
        leg.stepT += dt / leg.stepDuration;
        if (leg.stepT >= 1) {
          copy(leg.planted, leg.stepTo);
          leg.stepT = -1;
        }
      } else if (!groupStepping[1 - leg.group]) {
        // Diagonal gait: a foot may only lift while the opposite pair is planted.
        const threshold = activity > 12 ? 14 : 5;
        if (Math.hypot(leg.planted.x - homeX, leg.planted.y - homeZ) > threshold) {
          copy(leg.stepFrom, leg.planted);
          leg.stepTo.x = homeX;
          leg.stepTo.y = homeZ;
          leg.stepT = 0;
          leg.stepDuration = clamp(0.24 - activity * 0.0004, 0.11, 0.24);
          groupStepping[leg.group] = true;
        }
      }

      // World foot target -> sagittal plane (forward distance; the lateral offset is fixed).
      const target = this.footTarget(leg, activity);
      const bend = leg.front ? 1 : -1; // elbows point back, knees forward
      solveTwoBone(leg.hip, target, leg.upper, leg.lower, bend, leg.knee, leg.foot);
    }
  }

  private footTarget(leg: Leg, activity: number): Vec2 {
    const { position: pos, yaw } = this.rig;
    let wx = leg.planted.x;
    let wz = leg.planted.y;
    let lift = 0;
    if (leg.stepT >= 0) {
      const t = easeInOutSine(Math.min(leg.stepT, 1));
      wx = lerp(leg.stepFrom.x, leg.stepTo.x, t);
      wz = lerp(leg.stepFrom.y, leg.stepTo.y, t);
      lift = Math.sin(Math.PI * Math.min(leg.stepT, 1)) * (7 + Math.min(activity, 300) * 0.02);
    }
    const out = this.footTmp;
    out.x = (wx - pos.x) * Math.cos(yaw) + (wz - pos.y) * Math.sin(yaw);
    out.y = -2 - lift;
    return out;
  }

  // Neck, head and face

  private updateNeckAndHead(dt: number): void {
    const { rig, ball } = this;
    const neck = rig.neck;
    const head = neck[neck.length - 1];
    const nb = this.toSagittal(this.neckBase, BODY.neckBase);
    let wantYaw: number;
    let wantPitch: number;

    if (this.reaching) {
      // Aim the head at the ball, then place the head joint so that the *mouth* is on the ball.
      const l = this.toPetLocal(this.local, ball.pos);
      const by = -l.y; // ball in sagittal y
      const forward = Math.max(l.x - nb.x, 1);
      wantPitch = Math.atan2(by - nb.y, Math.hypot(forward, l.z));
      wantYaw = Math.atan2(l.z, forward);
      rig.headAngle = dampAngle(rig.headAngle, clamp(wantPitch, -1.3, 1.25), 14, dt);
      rig.headYaw = dampAngle(rig.headYaw, clamp(wantYaw, -0.8, 0.8), 14, dt);
      const a = rig.headAngle;
      const mx = BODY.mouth.x * Math.cos(a) - BODY.mouth.y * Math.sin(a);
      const my = BODY.mouth.x * Math.sin(a) + BODY.mouth.y * Math.cos(a);
      this.headTarget.x = l.x - mx * Math.cos(rig.headYaw);
      this.headTarget.y = by - my;
    } else {
      // Track the look target with head pitch and yaw, and lean the head slightly towards it.
      const l = this.toPetLocal(this.local, this.lookTarget);
      const ax = l.x - head.x;
      const ay = -l.y - head.y;
      wantPitch = Math.atan2(ay, Math.hypot(ax, l.z));
      wantYaw = Math.atan2(l.z, ax);
      rig.headAngle = dampAngle(rig.headAngle, clamp(wantPitch, -0.9, 0.8), 8, dt);
      rig.headYaw = dampAngle(rig.headYaw, clamp(wantYaw, -0.95, 0.95), 7, dt);
      const lean = this.behavior === 'fetch' ? 12 : 7;
      this.headTarget.x = nb.x + BODY.headRest.x + Math.cos(rig.headAngle) * lean;
      this.headTarget.y = nb.y + BODY.headRest.y + Math.sin(rig.headAngle) * lean + rig.breath;
    }

    // Eyes make up whatever the head can't turn (clamped), so the gaze still lands on target.
    rig.gaze.x = damp(rig.gaze.x, clamp((wantYaw - rig.headYaw) * 1.5, -1, 1), 18, dt);
    rig.gaze.y = damp(rig.gaze.y, clamp(-(wantPitch - rig.headAngle) * 1.5, -1, 1), 18, dt);

    // Cartoon stretch: segments lengthen (up to maxNeckStretch) when the target is far away.
    const want = Math.hypot(this.headTarget.x - nb.x, this.headTarget.y - nb.y) / (NECK_REST_TOTAL * 0.92);
    rig.neckStretch = damp(rig.neckStretch, clamp(want, 1, BODY.maxNeckStretch), 12, dt);
    for (let i = 0; i < this.neckLengths.length; i++) {
      this.neckLengths[i] = rig.neckRestLengths[i] * rig.neckStretch;
    }

    // Pole bias: nudge the middle joints forward so the neck curves forwards, not backwards.
    copy(neck[0], nb);
    const pull = (1 - Math.exp(-10 * dt)) * 0.3;
    for (let i = 1; i < neck.length - 1; i++) {
      neck[i].x += (nb.x + 30 - neck[i].x) * pull;
      neck[i].y += (nb.y - 10 - neck[i].y) * pull;
    }
    solveFabrik(neck, this.neckLengths, this.headTarget);

    // Ears: an under-damped spring kicked by head motion, acceleration and turning.
    this.earSpring.velocity -= (rig.headAngle - this.prevHeadAngle) * 7;
    this.earSpring.velocity -= Math.abs(rig.headYaw - this.prevHeadYaw) * 3;
    this.earSpring.velocity += (this.speed - this.prevSpeed) * 0.012;
    this.earSpring.target = -0.35 * rig.excitement + Math.abs(this.yawRate) * 0.04;
    rig.earAngle = this.earSpring.step(dt);
    this.prevHeadAngle = rig.headAngle;
    this.prevHeadYaw = rig.headYaw;

    this.updateMouth();
  }

  /** Mouth in world space: head-local offset, pitched by headAngle, turned by headYaw. */
  private updateMouth(): void {
    const { rig } = this;
    const head = rig.neck[rig.neck.length - 1];
    const a = rig.headAngle;
    const mx = BODY.mouth.x * Math.cos(a) - BODY.mouth.y * Math.sin(a);
    const my = BODY.mouth.x * Math.sin(a) + BODY.mouth.y * Math.cos(a);
    const forward = head.x + mx * Math.cos(rig.headYaw);
    const lateral = mx * Math.sin(rig.headYaw);
    this.sagittalToWorld(rig.mouth, forward, head.y + my, lateral);
  }

  private updateFace(dt: number): void {
    const { rig, ball } = this;

    // Blinking at random intervals, with an occasional double blink.
    if (this.blinkElapsed < 0) {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) this.blinkElapsed = 0;
    } else {
      this.blinkElapsed += dt;
      rig.blink = Math.sin(Math.PI * Math.min(1, this.blinkElapsed / this.blinkDuration));
      if (this.blinkElapsed >= this.blinkDuration) {
        this.blinkElapsed = -1;
        rig.blink = 0;
        this.blinkTimer = this.random() < 0.2 ? 0.12 : 2 + this.random() * 3.5;
      }
    }

    const panting = rig.excitement > 0.45 && ball.state !== 'held';
    rig.tongue = damp(rig.tongue, panting ? 1 : 0, 6, dt);
  }

  private updateTail(dt: number): void {
    const { rig } = this;
    const e = rig.excitement;
    this.wagPhase += dt * lerp(0.7, 4.5, e) * Math.PI * 2;
    const amplitude = lerp(0.22, 0.65, e);
    const baseAngle = -2.25 - e * 0.35; // up and back; higher when happy

    const tail = rig.tail;
    this.toSagittal(tail[0], BODY.tailBase);
    for (let i = 0; i < tail.length - 1; i++) {
      // Phase lag along the chain turns the wag into a travelling wave.
      const a = baseAngle + amplitude * Math.sin(this.wagPhase - i * 0.6) * (0.4 + i * 0.25) + i * 0.12;
      const angle = a - rig.pitch;
      tail[i + 1].x = tail[i].x + Math.cos(angle) * BODY.tailSegmentLength;
      tail[i + 1].y = tail[i].y + Math.sin(angle) * BODY.tailSegmentLength;
    }
  }

  // Coordinate helpers

  private clampX(x: number): number {
    return clamp(x, this.yard.minX + MARGIN, this.yard.maxX - MARGIN);
  }

  private clampZ(z: number): number {
    return clamp(z, this.yard.minZ + MARGIN, this.yard.maxZ - MARGIN);
  }

  /** Body-local -> sagittal: rotate by pitch (front up), translate to the root. */
  toSagittal(out: Vec2, local: Vec2): Vec2 {
    const { root, pitch } = this.rig;
    const c = Math.cos(-pitch);
    const s = Math.sin(-pitch);
    out.x = root.x + local.x * c - local.y * s;
    out.y = root.y + local.x * s + local.y * c;
    return out;
  }

  /** World point -> pet-local: x = forward, z = lateral (near side +), y = height. */
  toPetLocal(out: Vec3, p: Vec3): Vec3 {
    const { position, yaw } = this.rig;
    const dx = p.x - position.x;
    const dz = p.z - position.y;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    out.x = dx * c + dz * s;
    out.z = -dx * s + dz * c;
    out.y = p.y;
    return out;
  }

  /** Sagittal (forward, y-down) + lateral offset -> world. */
  sagittalToWorld(out: Vec3, forward: number, sy: number, lateral: number): Vec3 {
    const { position, yaw } = this.rig;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    out.x = position.x + c * forward - s * lateral;
    out.z = position.y + s * forward + c * lateral;
    out.y = -sy;
    return out;
  }

  /** Puts the feet under the hips and the neck in its rest pose. */
  private resetPose(): void {
    const { rig } = this;
    const c = Math.cos(rig.yaw);
    const s = Math.sin(rig.yaw);
    for (const leg of rig.legs) {
      this.toSagittal(leg.hip, leg.anchor);
      const fwd = leg.hip.x + (leg.front ? 3 : -3);
      leg.planted.x = rig.position.x + c * fwd - s * leg.side;
      leg.planted.y = rig.position.y + s * fwd + c * leg.side;
    }
    const nb = this.toSagittal(this.neckBase, BODY.neckBase);
    for (let i = 0; i < rig.neck.length; i++) {
      const t = i / (rig.neck.length - 1);
      rig.neck[i].x = nb.x + BODY.headRest.x * t;
      rig.neck[i].y = nb.y + BODY.headRest.y * t;
    }
    this.update(0, this.pointer);
  }
}
