import { describe, expect, it } from 'vitest';
import { vec3 } from '../math/vec3';
import { Ball } from './Ball';

const yard = { minX: -400, maxX: 400, minZ: -500, maxZ: 200 };

describe('Ball', () => {
  it('predicts its first landing, including wall bounces', () => {
    const ball = new Ball(yard);
    ball.throwFrom(300, 100, 0, 700, 400, -300);
    const predicted = vec3();
    ball.predictLanding(predicted);
    while (ball.bounces === 0) ball.update(1 / 60);
    // The real ball may have moved slightly past the contact point within the last frame.
    expect(Math.hypot(ball.pos.x - predicted.x, ball.pos.z - predicted.z)).toBeLessThan(15);
    expect(predicted.y).toBeCloseTo(ball.radius, 6);
  });

  it('produces the same trajectory at 60 Hz and 120 Hz', () => {
    const a = new Ball(yard);
    const b = new Ball(yard);
    a.throwFrom(0, 100, 0, 300, 500, -200);
    b.throwFrom(0, 100, 0, 300, 500, -200);
    for (let i = 0; i < 60; i++) a.update(1 / 60);
    for (let i = 0; i < 120; i++) b.update(1 / 120);
    expect(a.pos.x).toBeCloseTo(b.pos.x, 6);
    expect(a.pos.y).toBeCloseTo(b.pos.y, 6);
    expect(a.pos.z).toBeCloseTo(b.pos.z, 6);
  });

  it('eventually comes to rest on the ground', () => {
    const ball = new Ball(yard);
    ball.throwFrom(0, 100, 0, 250, 300, 150);
    for (let i = 0; i < 60 * 12 && ball.state !== 'resting'; i++) ball.update(1 / 60);
    expect(ball.state).toBe('resting');
    expect(ball.pos.y).toBeCloseTo(ball.radius, 6);
  });

  it('stays inside the yard', () => {
    const ball = new Ball(yard);
    ball.throwFrom(0, 50, 0, -2000, 300, -2000);
    for (let i = 0; i < 60 * 5; i++) {
      ball.update(1 / 60);
      expect(ball.pos.x).toBeGreaterThanOrEqual(yard.minX);
      expect(ball.pos.z).toBeGreaterThanOrEqual(yard.minZ);
    }
  });
});
