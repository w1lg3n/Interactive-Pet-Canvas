import { vec3, type Vec3 } from '../math/vec3';

export type BallState = 'hidden' | 'flying' | 'rolling' | 'resting' | 'held';

/** The play area on the ground plane (y = 0 is the ground, y points up). */
export interface Yard {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const FIXED_DT = 1 / 240;
export const GRAVITY = 1400; // units/s^2 (1 unit ~ 1 px of the pet's scale)
const RESTITUTION = 0.55; // vertical bounce energy kept
const WALL_RESTITUTION = 0.6;
const BOUNCE_FRICTION = 0.85; // horizontal speed kept on each bounce
const ROLL_FRICTION = 1.8; // 1/s exponential decay of rolling speed
const SETTLE_SPEED = 70; // below this vertical speed a bounce turns into rolling

/**
 * Tennis-ball physics in 3D.
 *
 * Physics runs in fixed 1/240 s substeps with an accumulator, so a 60 Hz and a 120 Hz display
 * produce exactly the same trajectory. `predictLanding` runs the same `integrate` step on a
 * copy of the state, so the prediction always matches what the ball will actually do,
 * including bounces off the yard's edges.
 */
export class Ball {
  readonly pos: Vec3 = vec3();
  readonly vel: Vec3 = vec3();
  readonly radius = 9;
  state: BallState = 'hidden';
  /** Accumulated roll angles about the x and z axes (for drawing the ball rolling). */
  rollX = 0;
  rollZ = 0;
  /** Number of ground contacts since the last throw. */
  bounces = 0;

  private accumulator = 0;

  constructor(private readonly yard: Yard) {}

  throwFrom(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    this.vel.x = vx;
    this.vel.y = vy;
    this.vel.z = vz;
    this.state = 'flying';
    this.bounces = 0;
    this.accumulator = 0;
  }

  /** Attaches the ball to a point (the pet's mouth); call every frame while held. */
  hold(p: Vec3): void {
    this.state = 'held';
    this.pos.x = p.x;
    this.pos.y = p.y;
    this.pos.z = p.z;
    this.vel.x = this.vel.y = this.vel.z = 0;
  }

  update(dt: number): void {
    if (this.state !== 'flying' && this.state !== 'rolling') return;
    this.accumulator += dt;
    while (this.accumulator >= FIXED_DT) {
      this.state = integrate(this.pos, this.vel, this.state, this.radius, this.yard, FIXED_DT, this);
      this.accumulator -= FIXED_DT;
      if (this.state === 'resting') {
        this.accumulator = 0;
        break;
      }
    }
  }

  /**
   * Predicts where the ball next touches the ground (or where it stops, if it is already
   * rolling). Writes the result into `out` and returns the time in seconds until then.
   */
  predictLanding(out: Vec3, maxTime = 3): number {
    if (this.state !== 'flying' && this.state !== 'rolling') {
      out.x = this.pos.x;
      out.y = this.pos.y;
      out.z = this.pos.z;
      return 0;
    }
    const p = scratchPos;
    const v = scratchVel;
    p.x = this.pos.x;
    p.y = this.pos.y;
    p.z = this.pos.z;
    v.x = this.vel.x;
    v.y = this.vel.y;
    v.z = this.vel.z;
    let state: BallState = this.state;
    probe.bounces = this.bounces;
    let t = 0;
    while (t < maxTime) {
      state = integrate(p, v, state, this.radius, this.yard, FIXED_DT, probe);
      t += FIXED_DT;
      if (state === 'resting' || (this.state === 'flying' && probe.bounces > this.bounces)) break;
    }
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    return t;
  }
}

// Scratch state for prediction, so it doesn't allocate.
const scratchPos = vec3();
const scratchVel = vec3();
const probe = { bounces: 0, rollX: 0, rollZ: 0 };

function integrate(
  p: Vec3,
  v: Vec3,
  state: BallState,
  r: number,
  yard: Yard,
  dt: number,
  counters: { bounces: number; rollX: number; rollZ: number },
): BallState {
  if (state === 'flying') {
    // Exact for constant acceleration: p += v*dt + g*dt^2/2.
    p.x += v.x * dt;
    p.z += v.z * dt;
    p.y += v.y * dt - 0.5 * GRAVITY * dt * dt;
    v.y -= GRAVITY * dt;

    if (p.y <= r) {
      p.y = r;
      counters.bounces++;
      v.x *= BOUNCE_FRICTION;
      v.z *= BOUNCE_FRICTION;
      if (Math.abs(v.y) * RESTITUTION < SETTLE_SPEED) {
        v.y = 0;
        state = 'rolling';
      } else {
        v.y = -v.y * RESTITUTION;
      }
    }
  } else if (state === 'rolling') {
    p.x += v.x * dt;
    p.z += v.z * dt;
    const decay = Math.exp(-ROLL_FRICTION * dt);
    v.x *= decay;
    v.z *= decay;
    if (Math.hypot(v.x, v.z) < 6) {
      v.x = v.z = 0;
      state = 'resting';
    }
  }

  // Yard edges.
  if (p.x < yard.minX + r) {
    p.x = yard.minX + r;
    v.x = Math.abs(v.x) * WALL_RESTITUTION;
  } else if (p.x > yard.maxX - r) {
    p.x = yard.maxX - r;
    v.x = -Math.abs(v.x) * WALL_RESTITUTION;
  }
  if (p.z < yard.minZ + r) {
    p.z = yard.minZ + r;
    v.z = Math.abs(v.z) * WALL_RESTITUTION;
  } else if (p.z > yard.maxZ - r) {
    p.z = yard.maxZ - r;
    v.z = -Math.abs(v.z) * WALL_RESTITUTION;
  }

  // Rolling without slipping: angle = distance / radius.
  counters.rollZ -= (v.x * dt) / r;
  counters.rollX += (v.z * dt) / r;
  return state;
}
