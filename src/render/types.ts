import type { Vec2 } from '../core/math/vec2';
import type { PetSimulation } from '../core/PetSimulation';

export interface DrawOptions {
  debug: boolean;
  fps: number;
  /** Ground point under the pointer, shown as a throw-target marker when `aimVisible`. */
  aim: Vec2;
  aimVisible: boolean;
}

/** Anything that can draw a `PetSimulation`. The engine depends on this, not on a concrete renderer. */
export interface PetRenderer {
  resize(): void;
  draw(sim: PetSimulation, options: DrawOptions): void;
  /** Projects a screen point (NDC) onto the ground plane; writes (x, z) into `out`. */
  pickGround(ndcX: number, ndcY: number, out: Vec2): boolean;
  dispose(): void;
}
