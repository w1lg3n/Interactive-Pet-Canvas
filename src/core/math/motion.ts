/**
 * Frame-rate independent motion primitives.
 *
 * The classic `x += (target - x) * 0.1` lerp is tied to the frame rate: at 120 Hz it converges
 * twice as fast as at 60 Hz. Everything here is the closed-form solution of a differential
 * equation evaluated over `dt`, so one 1/60 s step gives the same result as two 1/120 s steps.
 */

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Exponential decay towards `target` (solution of dx/dt = -lambda * (x - target)).
 * `lambda` is the response rate in 1/s; about 4.6 / lambda seconds to cover 99% of the distance.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** `damp` for angles: always takes the short way round. */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const delta = wrapAngle(target - current);
  return current + delta * (1 - Math.exp(-lambda * dt));
}

/** Moves `current` towards `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  return Math.abs(d) <= maxDelta ? target : current + Math.sign(d) * maxDelta;
}

/**
 * A damped spring, x'' = -omega^2 (x - target) - 2 * zeta * omega * x', integrated
 * analytically so it is exact (and stable) for any dt.
 *  - `omega`: angular frequency in rad/s (stiffness); higher means snappier.
 *  - `zeta`: damping ratio. 1 means critically damped (fastest settle with no overshoot);
 *    values below 1 overshoot and wobble, which suits secondary motion like floppy ears.
 */
export class Spring {
  value: number;
  velocity = 0;
  target: number;

  constructor(
    initial: number,
    public omega: number,
    public zeta = 1,
  ) {
    this.value = initial;
    this.target = initial;
  }

  step(dt: number): number {
    const { omega } = this;
    const zeta = Math.min(this.zeta, 1);
    const x0 = this.value - this.target;
    const v0 = this.velocity;

    if (zeta >= 1 - 1e-6) {
      // Critically damped: x(t) = (c1 + c2 t) e^(-w t)
      const c2 = v0 + omega * x0;
      const e = Math.exp(-omega * dt);
      this.value = this.target + (x0 + c2 * dt) * e;
      this.velocity = (c2 - omega * (x0 + c2 * dt)) * e;
    } else {
      // Under-damped: x(t) = e^(-z w t) (c1 cos(wd t) + c2 sin(wd t))
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const c2 = (v0 + zeta * omega * x0) / wd;
      const e = Math.exp(-zeta * omega * dt);
      const cos = Math.cos(wd * dt);
      const sin = Math.sin(wd * dt);
      this.value = this.target + e * (x0 * cos + c2 * sin);
      this.velocity =
        e * (-zeta * omega * (x0 * cos + c2 * sin) + wd * (-x0 * sin + c2 * cos));
    }
    return this.value;
  }

  /** Jumps to a value with no motion (e.g. on reset). */
  snap(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }
}

// Easing curves for time-based tweens (t in [0, 1]).
export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
