import { describe, expect, it } from 'vitest';
import { damp, dampAngle, Spring, wrapAngle } from './motion';

function run(stepHz: number, seconds: number, fn: (dt: number) => void) {
  const steps = Math.round(seconds * stepHz);
  for (let i = 0; i < steps; i++) fn(1 / stepHz);
}

describe('damp', () => {
  it('is frame-rate independent', () => {
    let a = 0;
    let b = 0;
    run(60, 0.5, (dt) => (a = damp(a, 100, 6, dt)));
    run(120, 0.5, (dt) => (b = damp(b, 100, 6, dt)));
    expect(a).toBeCloseTo(b, 9);
  });

  it('dampAngle takes the shortest path across the wrap', () => {
    const next = dampAngle(Math.PI - 0.1, -Math.PI + 0.1, 1000, 1);
    expect(Math.abs(wrapAngle(next - (-Math.PI + 0.1)))).toBeLessThan(1e-6);
  });
});

describe('Spring', () => {
  it.each([1, 0.3])('gives identical results at 60 Hz and 120 Hz (zeta=%s)', (zeta) => {
    const a = new Spring(0, 12, zeta);
    const b = new Spring(0, 12, zeta);
    a.target = b.target = 50;
    run(60, 0.4, (dt) => a.step(dt));
    run(120, 0.4, (dt) => b.step(dt));
    expect(a.value).toBeCloseTo(b.value, 9);
    expect(a.velocity).toBeCloseTo(b.velocity, 9);
  });

  it('critically damped spring settles without overshoot', () => {
    const s = new Spring(0, 15, 1);
    s.target = 10;
    let max = 0;
    run(120, 3, (dt) => (max = Math.max(max, s.step(dt))));
    expect(max).toBeLessThanOrEqual(10 + 1e-9);
    expect(s.value).toBeCloseTo(10, 4);
  });

  it('stays stable even with a huge time step', () => {
    const s = new Spring(0, 40, 0.2);
    s.target = 1;
    s.step(10);
    expect(Number.isFinite(s.value)).toBe(true);
    expect(s.value).toBeCloseTo(1, 3);
  });
});
