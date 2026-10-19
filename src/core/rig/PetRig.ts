import { vec2, type Vec2 } from '../math/vec2';
import { vec3, type Vec3 } from '../math/vec3';

/**
 * The pet's skeleton: plain data, written by `PetSimulation` and read by the renderer.
 *
 * Coordinate frames:
 *  - World: 3D, y up, ground at y = 0. The pet stands at `position` (x, z on the ground) and
 *    faces `yaw` (forward = (cos yaw, 0, sin yaw)).
 *  - Sagittal: the pet's own side-on plane, where all the IK runs. x is forward from the pet's
 *    origin, y points DOWN from the ground (so heights are negative). This is a 2D rig: legs,
 *    neck and tail bend in this plane, and the renderer places the plane in the world at
 *    `position`, rotated by `yaw`.
 *  - Head-local: origin at the head joint, +x along the snout, pitched by `headAngle` (in the
 *    sagittal plane) and then turned by `headYaw` about the vertical axis.
 */

export interface Leg {
  /** Where the leg attaches to the body (body-local, sagittal). */
  readonly anchor: Vec2;
  readonly front: boolean;
  /** Lateral offset from the spine: + is the near side (+z in pet space), - is the far side. */
  readonly side: number;
  /** Diagonal pairs step together: group 0 = near-front + far-back, group 1 = the others. */
  readonly group: 0 | 1;
  readonly upper: number;
  readonly lower: number;

  // Sagittal solve results.
  readonly hip: Vec2;
  readonly knee: Vec2;
  readonly foot: Vec2;

  // Procedural stepping, in WORLD ground coordinates (x, z stored as x, y).
  readonly planted: Vec2;
  readonly stepFrom: Vec2;
  readonly stepTo: Vec2;
  /** 0..1 progress of the current step, or -1 when the foot is planted. */
  stepT: number;
  stepDuration: number;
}

export interface PetRig {
  /** Ground position in the world (x, z stored as x, y). */
  readonly position: Vec2;
  /** Heading in radians on the ground plane. */
  yaw: number;

  /** Body centre in the sagittal plane (x is always 0; y is minus the height). */
  readonly root: Vec2;
  /** Body rotation in radians; positive lifts the front (rearing up). */
  pitch: number;
  /** Breathing cycle, -1..1. */
  breath: number;

  readonly legs: Leg[];

  /** Neck chain joints (sagittal), base first; the last joint is the head. */
  readonly neck: Vec2[];
  readonly neckRestLengths: number[];
  /** Current neck stretch factor (1 = rest); the renderer also thins the neck by it. */
  neckStretch: number;
  /** Head pitch in the sagittal plane: 0 looks straight ahead, positive looks down. */
  headAngle: number;
  /** Head turn about the vertical axis: positive turns towards the near side (+z). */
  headYaw: number;
  /** Floppy ear rotation offset (secondary motion). */
  earAngle: number;

  /** Where the eyes look relative to the head, -1..1 (x: towards near side, y: up). */
  readonly gaze: Vec2;
  /** 0 = open, 1 = closed. */
  blink: number;
  /** Mouth position in the world (where the ball is caught and carried). */
  readonly mouth: Vec3;
  /** 0..1, how far the tongue is out (panting). */
  tongue: number;

  /** Tail joints (sagittal). */
  readonly tail: Vec2[];

  /** 0..1 overall excitement; drives tail wag, panting and ear perk. */
  excitement: number;
}

/** Body proportions (sagittal units). Renderer and simulation share these. */
export const BODY = {
  length: 96,
  height: 44,
  standHeight: 58, // body centre above the ground
  neckBase: vec2(30, -12),
  neckSegments: 3,
  neckSegmentLength: 16,
  maxNeckStretch: 1.9,
  headRest: vec2(26, -26), // relative to the neck base (wolf-like, head forward)
  mouth: vec2(24, 9), // head-local, y down
  tailBase: vec2(-48, -8),
  tailSegments: 5,
  tailSegmentLength: 8,
  hipToRearPivot: 40,
  legSide: 11,
} as const;

function makeLeg(ax: number, ay: number, front: boolean, side: number, group: 0 | 1): Leg {
  return {
    anchor: vec2(ax, ay),
    front,
    side,
    group,
    upper: 24,
    lower: 26,
    hip: vec2(),
    knee: vec2(),
    foot: vec2(),
    planted: vec2(),
    stepFrom: vec2(),
    stepTo: vec2(),
    stepT: -1,
    stepDuration: 0.2,
  };
}

export function createRig(x: number, z: number, yaw: number): PetRig {
  const neck: Vec2[] = [];
  const neckRestLengths: number[] = [];
  for (let i = 0; i <= BODY.neckSegments; i++) neck.push(vec2(0, -i * BODY.neckSegmentLength));
  for (let i = 0; i < BODY.neckSegments; i++) neckRestLengths.push(BODY.neckSegmentLength);

  const tail: Vec2[] = [];
  for (let i = 0; i <= BODY.tailSegments; i++) tail.push(vec2());

  return {
    position: vec2(x, z),
    yaw,
    root: vec2(0, -BODY.standHeight),
    pitch: 0,
    breath: 0,
    legs: [
      makeLeg(-36, 8, false, -BODY.legSide, 0),
      makeLeg(34, 8, true, -BODY.legSide, 1),
      makeLeg(-38, 10, false, BODY.legSide, 1),
      makeLeg(32, 10, true, BODY.legSide, 0),
    ],
    neck,
    neckRestLengths,
    neckStretch: 1,
    headAngle: 0,
    headYaw: 0,
    earAngle: 0,
    gaze: vec2(),
    blink: 0,
    mouth: vec3(),
    tongue: 0,
    tail,
    excitement: 0,
  };
}
