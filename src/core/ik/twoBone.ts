import type { Vec2 } from '../math/vec2';

/**
 * Analytic two-bone IK (used for the legs).
 *
 * With the root, the target and the two bone lengths fixed, the joints form a triangle, so the
 * law of cosines gives the angle at the root directly:
 *
 *     cos(a) = (l1^2 + d^2 - l2^2) / (2 * l1 * d)
 *
 * The middle joint (knee or elbow) sits at `root + l1 * (cos(base +/- a), sin(base +/- a))`,
 * where `base` is the root-to-target direction. `bend` (+1 / -1) picks which side of that line
 * the joint goes. This is exact and needs no iterations, which suits a joint with two bones.
 *
 * Writes the joint positions into `outMid` / `outEnd` and returns true if the target was
 * reachable. Out-of-reach targets are clamped so the leg straightens and points at them.
 */
export function solveTwoBone(
  root: Vec2,
  target: Vec2,
  l1: number,
  l2: number,
  bend: number,
  outMid: Vec2,
  outEnd: Vec2,
): boolean {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const rawDist = Math.hypot(dx, dy);
  const base = Math.atan2(dy, dx);

  // Keep just inside the reachable annulus: a fully straight leg is a singular pose and jitters.
  const maxReach = (l1 + l2) * 0.999;
  const minReach = Math.abs(l1 - l2) + 1e-3;
  const d = Math.min(Math.max(rawDist, minReach), maxReach);

  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const a = Math.acos(Math.min(1, Math.max(-1, cosA)));
  const midAngle = base + (bend >= 0 ? a : -a);

  outMid.x = root.x + Math.cos(midAngle) * l1;
  outMid.y = root.y + Math.sin(midAngle) * l1;
  outEnd.x = root.x + Math.cos(base) * d;
  outEnd.y = root.y + Math.sin(base) * d;

  return rawDist <= maxReach && rawDist >= minReach;
}
