import { describe, expect, it } from 'vitest';
import { PetSimulation, PLAYER, type PointerState } from './PetSimulation';

const noPointer: PointerState = { x: 0, z: 0, active: false };

/** Small deterministic PRNG (mulberry32) so scenarios are reproducible. */
function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runUntilIdle(sim: PetSimulation, hz: number, maxSeconds = 25, pointer = noPointer) {
  for (let i = 0; i < hz * maxSeconds && sim.behavior !== 'idle'; i++) sim.update(1 / hz, pointer);
}

describe('PetSimulation (3D)', () => {
  it('chases at the same pace at 60 Hz and 120 Hz', () => {
    const a = new PetSimulation({ random: seeded(1) });
    const b = new PetSimulation({ random: seeded(1) });
    a.throwTo(-300, -400);
    b.throwTo(-300, -400);
    for (let i = 0; i < 60; i++) a.update(1 / 60, noPointer);
    for (let i = 0; i < 120; i++) b.update(1 / 120, noPointer);
    const d = Math.hypot(a.rig.position.x - b.rig.position.x, a.rig.position.y - b.rig.position.y);
    expect(d).toBeLessThan(3);
  });

  it.each(Array.from({ length: 25 }, (_, i) => i + 1))(
    'completes a random fetch, returns to the player and drops the ball (seed %i)',
    (seed) => {
      const sim = new PetSimulation({ random: seeded(seed) });
      const phases: string[] = [];
      sim.onBehaviorChange = () => phases.push(sim.status);
      sim.setBehavior('fetch');
      runUntilIdle(sim, 60);
      expect(phases).toEqual(['fetch:chase', 'fetch:return', 'idle']);
      const { position } = sim.rig;
      expect(Math.hypot(position.x - PLAYER.x, position.y - PLAYER.z)).toBeLessThan(12);
      expect(sim.ball.state).not.toBe('held');
    },
  );

  it.each([
    [-380, -520],
    [380, -520],
    [-380, 180],
    [0, -100],
    [350, 100],
  ])('fetches a ball thrown to (%i, %i), including the corners', (x, z) => {
    const sim = new PetSimulation({ random: seeded(5) });
    expect(sim.throwTo(x, z)).toBe(true);
    runUntilIdle(sim, 120);
    expect(sim.behavior).toBe('idle');
  });

  it('fetches a flicked ball', () => {
    const sim = new PetSimulation({ random: seeded(8) });
    sim.throwWithVelocity(-250, 450, -500);
    runUntilIdle(sim, 60);
    expect(sim.behavior).toBe('idle');
  });

  it('cannot throw while the pet is carrying the ball', () => {
    const sim = new PetSimulation({ random: seeded(2) });
    sim.throwTo(0, -300);
    for (let i = 0; i < 60 * 20 && sim.fetchPhase !== 'return'; i++) sim.update(1 / 60, noPointer);
    expect(sim.ball.state).toBe('held');
    expect(sim.throwTo(100, -100)).toBe(false);
  });

  it('keeps every joint finite and feet on or above the ground', () => {
    const sim = new PetSimulation({ random: seeded(7) });
    const pointer = { x: 0, z: 0, active: true };
    sim.setBehavior('walk');
    for (let i = 0; i < 60 * 10; i++) {
      pointer.x = Math.sin(i * 0.03) * 300;
      pointer.z = Math.cos(i * 0.02) * 300;
      if (i === 300) sim.setBehavior('fetch');
      sim.update(1 / 60, pointer);
      for (const leg of sim.rig.legs) {
        expect(Number.isFinite(leg.knee.x) && Number.isFinite(leg.foot.y)).toBe(true);
        expect(leg.foot.y).toBeLessThanOrEqual(0); // sagittal y points down; 0 is the ground
      }
    }
  });

  it('turns its body towards a pointer held behind it', () => {
    const sim = new PetSimulation({ random: seeded(3) });
    const { position, yaw } = sim.rig;
    const behind = { x: position.x - Math.cos(yaw) * 200, z: position.y - Math.sin(yaw) * 200, active: true };
    for (let i = 0; i < 60 * 2; i++) sim.update(1 / 60, behind);
    const toPointer = Math.atan2(behind.z - sim.rig.position.y, behind.x - sim.rig.position.x);
    const err = Math.atan2(Math.sin(toPointer - sim.rig.yaw), Math.cos(toPointer - sim.rig.yaw));
    expect(Math.abs(err)).toBeLessThan(0.5);
  });

  it('sits down (haunches low, chest up) and stays put', () => {
    const sim = new PetSimulation({ random: seeded(6) });
    const standingHeight = -sim.rig.root.y;
    const start = { x: sim.rig.position.x, z: sim.rig.position.y };
    sim.setBehavior('sit');
    for (let i = 0; i < 60 * 2; i++) sim.update(1 / 60, { x: 300, z: 0, active: true });
    expect(sim.behavior).toBe('sit');
    expect(-sim.rig.root.y).toBeLessThan(standingHeight - 10);
    expect(sim.rig.pitch).toBeGreaterThan(0.45);
    expect(Math.hypot(sim.rig.position.x - start.x, sim.rig.position.y - start.z)).toBeLessThan(1);
    for (const leg of sim.rig.legs) expect(leg.foot.y).toBeLessThanOrEqual(0);
  });

  it('gets up from sitting to fetch a thrown ball', () => {
    const sim = new PetSimulation({ random: seeded(9) });
    sim.setBehavior('sit');
    for (let i = 0; i < 60 * 2; i++) sim.update(1 / 60, noPointer);
    sim.throwTo(250, -350);
    runUntilIdle(sim, 60);
    expect(sim.behavior).toBe('idle');
  });

  it('keeps the gaze within the eye range', () => {
    const sim = new PetSimulation({ random: seeded(4) });
    for (let i = 0; i < 60; i++) sim.update(1 / 60, { x: 400, z: 200, active: true });
    expect(Math.abs(sim.rig.gaze.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(sim.rig.gaze.y)).toBeLessThanOrEqual(1);
  });
});
