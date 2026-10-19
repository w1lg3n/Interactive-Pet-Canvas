import { describe, expect, it } from 'vitest';
import { distance, vec2 } from '../math/vec2';
import { solveFabrik } from './fabrik';
import { solveTwoBone } from './twoBone';

describe('solveTwoBone', () => {
  const root = vec2(0, 0);
  const mid = vec2();
  const end = vec2();

  it('reaches a reachable target and preserves bone lengths', () => {
    const target = vec2(20, 30);
    expect(solveTwoBone(root, target, 22, 24, 1, mid, end)).toBe(true);
    expect(distance(end, target)).toBeLessThan(1e-6);
    expect(distance(root, mid)).toBeCloseTo(22, 6);
    expect(distance(mid, end)).toBeCloseTo(24, 6);
  });

  it('bend direction chooses which side the middle joint goes', () => {
    const target = vec2(0, 40);
    solveTwoBone(root, target, 22, 24, 1, mid, end);
    const firstX = mid.x;
    solveTwoBone(root, target, 22, 24, -1, mid, end);
    expect(Math.sign(firstX)).toBe(-Math.sign(mid.x));
  });

  it('clamps an unreachable target and points straight at it', () => {
    const target = vec2(0, 500);
    expect(solveTwoBone(root, target, 22, 24, 1, mid, end)).toBe(false);
    expect(Math.abs(end.x)).toBeLessThan(1e-6);
    expect(end.y).toBeCloseTo(46 * 0.999, 6);
  });
});

describe('solveFabrik', () => {
  const makeChain = () => [vec2(0, 0), vec2(0, -10), vec2(0, -20), vec2(0, -30)];
  const lengths = [10, 10, 10];

  it('reaches a reachable target, keeps the root fixed and preserves lengths', () => {
    const joints = makeChain();
    const target = vec2(15, -15);
    const err = solveFabrik(joints, lengths, target, 20, 0.01);
    expect(err).toBeLessThan(0.01);
    expect(joints[0]).toEqual({ x: 0, y: 0 });
    for (let i = 0; i < lengths.length; i++) {
      expect(distance(joints[i], joints[i + 1])).toBeCloseTo(lengths[i], 6);
    }
  });

  it('straightens towards an unreachable target', () => {
    const joints = makeChain();
    const err = solveFabrik(joints, lengths, vec2(100, 0));
    expect(err).toBeCloseTo(70, 6);
    expect(joints[3].x).toBeCloseTo(30, 6);
    expect(joints[3].y).toBeCloseTo(0, 6);
  });
});
