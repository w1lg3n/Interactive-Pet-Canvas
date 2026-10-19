# Architecture & Technical Notes

This document covers how the pet works: how the code is structured, how the joint vectors are calculated, and how the animation stays smooth.

The pet is a blocky, voxel-style dog in a 3D yard. You throw a ball by clicking the grass or flicking, and the dog runs to where the ball will land, catches it (in mid-air if it can reach), carries it back and drops it at your feet.

## 1. Layered structure

```
src/
  core/                        Pure TypeScript: no DOM, WebGL or timers
    math/vec2.ts, vec3.ts      Allocation-free vector ops (write into an `out` param)
    math/motion.ts             Frame-rate independent damping, analytic springs, easing
    ik/fabrik.ts               FABRIK solver (neck chain)
    ik/twoBone.ts              Analytic two-bone IK (legs)
    physics/Ball.ts            Fixed-step 3D ball physics + landing prediction
    rig/PetRig.ts              Skeleton data + body proportions
    PetSimulation.ts           Behaviours, 3D steering, IK, secondary motion, throwing
  render/
    ThreeRenderer.ts           three.js / WebGL voxel renderer + ground picking
    voxelTextures.ts           Procedural pixel-art textures (no image assets)
    types.ts                   `PetRenderer` interface
  input/PointerInput.ts        DOM pointer events -> hover NDC + tap/flick gestures
  engine/PetEngine.ts          rAF loop, picking, gesture -> throw mapping, lifecycle
  main.ts                      UI shell
```

Each frame, data moves in one direction:

```
PointerInput ──► PetEngine ──pickGround──► PetSimulation.update(dt, {x, z}) ──► ThreeRenderer.draw()
  (DOM)          (rAF, gestures)            (pure math, plain numbers)          (WebGL)
```

**Why this split:** `PetSimulation` takes `dt` and a ground-plane pointer `{ x, z, active }` as input and outputs plain numbers (positions, angles, joints). It never touches the DOM or WebGL, so:

- **Porting is easy.** A React Native version would keep `core/` unchanged and only swap the renderer (e.g. expo-gl + three, or react-native-skia) and the gesture adapter.
- **It can be tested headlessly.** The Vitest suite runs dozens of complete fetch games without a browser.

## 2. The rig: a 2D skeleton placed in a 3D world

The pet has a **world transform**: a ground position `(x, z)` and a heading `yaw`. Its body is a **2D side-on rig** solved in its own *sagittal plane* (forward and up). The renderer places that plane in the world at the pet's position and rotates it by `yaw`. This keeps the IK simple and exact, while the pet still moves and turns freely in 3D.

| Part | Joints | Driven by |
|---|---|---|
| Body | root height + `pitch` | pose targets (breathing, leaning, rearing) |
| Legs ×4 | hip → knee → foot | **two-bone analytic IK** + world-space foot planting |
| Neck | 4-joint chain | **FABRIK**, with stretchable segment lengths |
| Head | `headAngle` (pitch) + `headYaw` | damped look-at |
| Eyes | pupil offset | gaze the head can't cover (clamped) + blinks |
| Ears | angle offset | under-damped spring (secondary motion) |
| Tail | 6-joint chain | phase-lagged sine (travelling wave) |

### Coordinate frames

- **World:** y up, ground at y = 0. Pet forward is `(cos yaw, 0, sin yaw)`.
- **Sagittal:** x forward from the pet's origin, y pointing *down* (so heights are negative). All IK runs here.
- **Pet-local (for targets):** a world point maps to `forward = d·f`, `lateral = d·s`, `height = y`, where `f = (cos yaw, sin yaw)` and `s = (−sin yaw, cos yaw)`.
- **Head-local:** pitched by `headAngle` in the sagittal plane, then turned by `headYaw` about the vertical axis. In three.js this is Euler order `YZX`.

## 3. How the joint vectors are calculated

### Legs: analytic two-bone IK + world-planted feet

For a hip `H`, a foot target `T` and bone lengths `l1`, `l2`:

```
d    = clamp(|T − H|, |l1 − l2|, 0.999 · (l1 + l2))
base = atan2(T − H)
a    = acos((l1² + d² − l2²) / (2 · l1 · d))    ← law of cosines
knee = H + l1 · (cos(base ± a), sin(base ± a))
foot = H + d · (cos base, sin base)
```

Front legs bend backwards (elbows) and back legs bend forwards (knees). Reach is capped at 99.9% of the leg's full length, because a fully straight leg is a singular pose that jitters. The voxel renderer draws each leg as one rigid block from the hip to the solved foot, so legs swing from the hip in the blocky style while the feet still plant properly.

**Foot planting in 3D.** Each foot's planted spot is stored in *world* `(x, z)`, so it stays fixed while the body moves and turns over it. Every frame:

1. Compute the foot's home spot: under the hip, shifted ahead by `speed × 0.11 s`, at the leg's side offset.
2. If the planted spot has drifted past a threshold, take a step: ease from the old spot to the home spot along a `sin(πt)` lift arc. The threshold counts turning speed as movement, so turning on the spot also triggers steps.
3. Convert the foot's world target into the sagittal plane (its forward distance) and solve the IK.

The legs move in diagonal pairs, and a foot can only lift while the other pair is planted.

### Neck: FABRIK (`ik/fabrik.ts`)

1. **Backward pass:** put the end joint on the target, then walk towards the root, putting each joint exactly one segment length from its child.
2. **Forward pass:** put the root back on the neck base and walk outwards the same way.

Starting from last frame's pose keeps the motion continuous. Two additions on top:

- **Pole bias:** the middle joints get nudged forward slightly before each solve, so the neck always curves forwards and never folds backwards.
- **Cartoon stretch:** segment lengths are scaled by `neckStretch` (1 to 1.9), which follows `distance to target / rest length`. The neck gets thinner by `1/√stretch` to suggest it keeps its volume.

### Catching: placing the mouth, not the head

When reaching, the head pitch and yaw aim at the ball. The neck's IK target is then set to `ball − mouthOffset(headAngle, headYaw)`, which puts the mouth on the ball rather than the head joint. The world mouth position, used for the catch test and for carrying the ball, is computed the same way:

```
mx = mouth.x·cos(a) − mouth.y·sin(a)
my = mouth.x·sin(a) + mouth.y·cos(a)
mouth = sagittalToWorld(head.x + mx·cos(yawH), head.y + my, lateral = mx·sin(yawH))
```

Body pitch follows how high the ball is. The pitch pivots around the hips, so the dog rears up for a high ball and bows for a ball on the ground.

## 4. Behaviour state machine and throwing

```
idle ◄──► sit (haunches down, chest up; stands up before moving)
  │
  ├─Walk──► walk (random waypoints) ──Idle──► idle
  │
  └─throw──► fetch:chase ──mouth touches ball──► fetch:return ──at player──► (drop ball) idle
```

- **Tap or slow drag-and-release:** the engine raycasts the pointer onto the ground plane (`t = −origin.y / dir.y`). The simulation then solves a launch from the player's hand that lands exactly on that spot. Flight time grows with distance, `T = clamp(0.55 + dist/1100, 0.55, 1.3)`, giving `v = (Δx/T, (r − y0 + ½gT²)/T, Δz/T)`.
- **Flick:** the release velocity is measured over the last 90 ms of the swipe, in canvas-heights per second so it doesn't depend on screen size. Swiping up throws away from the camera, sideways speed adds sideways throw, and a faster swipe throws further and higher.
- **Intercept:** the dog steers to where the ball *will* land, stopping short by the mouth's reach so its mouth ends up at the ball. `Ball.predictLanding` runs the same fixed-step integration as the real ball on a copy of its state, including bounces off the fence, so the prediction matches what actually happens.
- **Steering:** the heading turns towards the target with exponential damping, capped at 6 rad/s. Speed is scaled by `cos²(heading error)`, so the dog slows and turns on the spot instead of running sideways.
- **Return:** the dog brings the ball to the player's carpet, turns to face the camera and drops it. The player can throw again whenever the dog isn't carrying the ball.
- **Sit:** a blend factor eases from 0 to 1. It raises the pitch to 0.55 rad (chest up), lowers the body centre so the rump rests on the ground, and moves the rear paw homes forward so the hind legs fold under the body. Movement is scaled by (1 − sit)², so the dog always stands up before it runs.
- **Idle:** the head and eyes follow the cursor's ground point, or look at the viewer when there's no cursor. If the cursor stays behind the dog, it turns its whole body around.

## 5. Smooth animation strategy

### Frame-rate independence (60 Hz / 120 Hz / 144 Hz)

- **No `x += (target − x) * k` lerps.** That pattern converges twice as fast at 120 Hz as at 60 Hz. Everything uses exponential damping, the exact solution of `dx/dt = −λ(x − target)`:
  `x = target + (x − target) · e^(−λ·dt)`
- **Springs are solved analytically** (closed form for critically damped and under-damped springs), so they're exact and stable for any `dt`.
- **Ball physics uses a fixed 1/240 s step** with an accumulator, so its path is identical at every refresh rate.
- **Cyclic motion accumulates phase** (breathing, tail wag), so changing their speed never makes the motion jump.
- **`dt` is clamped to 50 ms,** and the first frame after a pause gets `dt = 0`.

Tests check that a spring stepped at 60 Hz matches one stepped at 120 Hz to 9 decimal places, that the ball follows an identical path at both rates, and that the dog's chase covers the same ground at 60 Hz and 120 Hz.

### Secondary motion

- **Breathing and panting:** about 0.3 Hz when calm, rising to about 2.4 Hz with excitement. The jaw opens and the tongue hangs out.
- **Tail wag:** a travelling wave whose speed and amplitude follow excitement.
- **Ears:** an under-damped spring (ζ = 0.28) kicked by head motion, acceleration and turning.
- **Weight shifts and leaning:** a slow pitch drift while idle, plus leaning into a run.
- **Eyes:** blinks at random intervals, and the pupils make up whatever angle the head is clamped from reaching.

## 6. Rendering (voxel style)

- The dog is built from boxes: a body with a thicker shoulder ruff, rigid block legs, square neck segments, a cube head with snout, nose and hinged jaw, block ears, brows and eyes, and a three-block tail with a dark tip.
- **Procedural pixel art:** every texture is painted pixel by pixel into a tiny canvas with a seeded RNG (`voxelTextures.ts`). There are no image assets. Nearest-neighbour filtering keeps the pixels crisp, and tone mapping is off so the colours stay exactly as painted.
- **Per-face materials** give each box a darker back, banded sides and a cream belly, and put the face texture on the front.
- **Scenery:** grass-block ground, block trees (log column plus a layered leaf canopy), a plank fence, a carpet and drifting block clouds. The fence posts, tree blocks and clouds are each a single InstancedMesh.

## 7. Performance & resource management

- **No allocation in the hot path:** vectors and matrices are preallocated, and the rAF callback is bound once.
- **Created once:** all meshes, geometries, materials and textures are built at startup, and each frame only updates transforms. Shaders are compiled up front (`renderer.compile`) so the first throw doesn't hitch.
- **Lifecycle:** `destroy()` cancels rAF, removes every listener (pointer, resize, visibility), and frees geometries, materials, textures and the GL context (`forceContextLoss`). The loop pauses on `visibilitychange`, and Vite HMR calls `destroy()`, so dev reloads don't pile up GL contexts.
- **Measured in Chromium:** steady 60 fps during fetch and walk (p95 frame ≈ 16.8 ms, no frames over 25 ms). The app code is about 14 KB gzipped; three.js is about 119 KB gzipped in a separate, cacheable chunk.

## 8. Testing

`npm test` runs 53 Vitest tests:

- **Math:** damping and spring frame-rate independence, no-overshoot, large-`dt` stability.
- **IK:** reaches targets, keeps bone lengths, clamps unreachable targets, bend direction.
- **Ball:** landing prediction vs. the real 3D path, identical paths at 60 Hz and 120 Hz, coming to rest, staying inside the yard.
- **Simulation:**
  - 25 seeded random fetches all finish chase → return → idle at the player.
  - Throws into all four corners of the yard all get fetched.
  - A flicked throw gets fetched.
  - The player can't throw while the dog is carrying the ball.
  - Sitting lowers the haunches and raises the chest without moving the dog, and a seated dog gets up to fetch.
  - Chase speed is the same across refresh rates.
  - Joints stay finite and feet never go below the ground.
  - The dog turns to face a cursor held behind it, and the gaze stays within range.

## 9. Trade-offs and possible next steps

- **2D rig in a 3D world:** legs, neck and tail bend only in the dog's own side-on plane. That's correct for a quadruped's gait and keeps the IK exact. Feet don't shift sideways while the dog turns, but the turn-triggered steps re-plant them quickly.
- **Variable `dt` with exact integrators:** a fully fixed-step simulation with render interpolation would be the next step if the motion ever needed to be bit-for-bit deterministic.
- **Possible extras:** a trajectory preview while dragging, jumping catches, more than one ball, or a camera that orbits on drag.
