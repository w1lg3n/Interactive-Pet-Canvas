import type { Vec2 } from '../math/vec2';

/**
 * FABRIK (Forward And Backward Reaching Inverse Kinematics), Aristidou & Lasenby 2011.
 * Used for the neck, which is a chain of several segments.
 *
 * Each iteration does two passes over the chain:
 *  1. Backward: put the end joint on the target, then walk towards the root, putting each joint
 *     on the line to its child, exactly one segment length away.
 *  2. Forward: put the root back on its anchor and walk outwards the same way.
 * It converges in a few iterations, can't blow up numerically, and works with any number of
 * segments. Starting from last frame's pose keeps the motion continuous from frame to frame.
 *
 * `joints` (length n + 1) is updated in place; `lengths` (length n) gives each segment length.
 * Returns the remaining end-to-target distance.
 */
export function solveFabrik(
  joints: Vec2[],
  lengths: number[],
  target: Vec2,
  iterations = 8,
  tolerance = 0.25,
): number {
  const n = lengths.length;
  const root = joints[0];
  const rootX = root.x;
  const rootY = root.y;

  let total = 0;
  for (let i = 0; i < n; i++) total += lengths[i];

  const toTarget = Math.hypot(target.x - rootX, target.y - rootY);
  if (toTarget >= total) {
    // Unreachable: lay the chain out straight towards the target.
    const ux = (target.x - rootX) / (toTarget || 1);
    const uy = (target.y - rootY) / (toTarget || 1);
    for (let i = 0; i < n; i++) {
      joints[i + 1].x = joints[i].x + ux * lengths[i];
      joints[i + 1].y = joints[i].y + uy * lengths[i];
    }
    return toTarget - total;
  }

  const end = joints[n];
  let error = Math.hypot(target.x - end.x, target.y - end.y);

  for (let iter = 0; iter < iterations && error > tolerance; iter++) {
    // Backward pass: end -> root.
    end.x = target.x;
    end.y = target.y;
    for (let i = n - 1; i >= 0; i--) placeAlong(joints[i], joints[i + 1], lengths[i]);

    // Forward pass: root -> end.
    root.x = rootX;
    root.y = rootY;
    for (let i = 0; i < n; i++) placeAlong(joints[i + 1], joints[i], lengths[i]);

    error = Math.hypot(target.x - end.x, target.y - end.y);
  }
  return error;
}

/** Moves `joint` along the line to `anchor` so it ends up exactly `len` away from `anchor`. */
function placeAlong(joint: Vec2, anchor: Vec2, len: number): void {
  const dx = joint.x - anchor.x;
  const dy = joint.y - anchor.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const k = len / d;
  joint.x = anchor.x + dx * k;
  joint.y = anchor.y + dy * k;
}
