import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NoToneMapping,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Raycaster,
  RepeatWrapping,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type CanvasTexture,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import type { Vec2 } from '../core/math/vec2';
import { PLAYER, type PetSimulation } from '../core/PetSimulation';
import type { Ball, Yard } from '../core/physics/Ball';
import type { PetRig } from '../core/rig/PetRig';
import type { DrawOptions, PetRenderer } from './types';
import * as tex from './voxelTextures';

/**
 * three.js (WebGL) renderer in a blocky voxel art style.
 *
 * World space is y up with the ground at y = 0, the same as the simulation. The pet's rig is a
 * 2D sagittal plane (x forward, y down). The pet group is placed at the pet's ground position
 * and rotated by its yaw, and each sagittal joint (x, y) becomes (x, -y, lateral) inside it.
 *
 * The dog is built from boxes with procedural pixel-art textures: a body with a thick shoulder
 * ruff, rigid block legs that swing from the hips (hip -> planted foot from the IK), a cube head
 * with a snout, block ears and eyes whose pupils follow the gaze. The scene (grass, trees,
 * fence, clouds, ball) uses the same style.
 *
 * Performance: every mesh, geometry, material and texture is created once. Each frame only
 * updates transforms (no allocation). Repeated scenery (fence posts, tree blocks, clouds) uses
 * InstancedMesh. Shaders are compiled up front, and `dispose()` frees every GPU resource.
 */

const UP = new Vector3(0, 1, 0);
const tmpDir = new Vector3();
const tmpNdc = new Vector2();
const tmpMatrix = new Matrix4();

const SKY = 0x8fc3f7;
const BLOCK = 24; // scenery block size in world units

/** A unit box spanning two points (its local +y runs from `a` to `b`). */
class BoxBone {
  readonly mesh: Mesh;
  constructor(geometry: BoxGeometry, material: Material | Material[], parent: Object3D) {
    this.mesh = new Mesh(geometry, material);
    this.mesh.castShadow = true;
    parent.add(this.mesh);
  }
  span(ax: number, ay: number, bx: number, by: number, z: number, width: number, depth = width): void {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-4;
    this.mesh.position.set((ax + bx) / 2, (ay + by) / 2, z);
    tmpDir.set(dx / len, dy / len, 0);
    this.mesh.quaternion.setFromUnitVectors(UP, tmpDir);
    this.mesh.scale.set(width, len, depth);
  }
}

export class ThreeRenderer implements PetRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly raycaster = new Raycaster();
  private readonly hud: HTMLDivElement;
  private hudText = '';
  private hudTimer = 0;
  private hudFps = 60;
  private time = 0;

  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private readonly textures: Texture[] = [];
  private readonly unitBox: BoxGeometry;

  // Pet hierarchy
  private readonly pet = new Group(); // at the pet's ground position, rotated by yaw
  private readonly body = new Group();
  private readonly torso = new Group(); // breathing scale
  private readonly legs: BoxBone[] = [];
  private neck!: BoxBone; // assigned in buildDog()
  private readonly collar: BoxBone;
  private readonly tail: BoxBone[] = [];
  private readonly head = new Group();
  private readonly jaw = new Group();
  private readonly tongue: Mesh;
  private readonly ears: Group[] = [];
  private readonly eyes: { group: Group; pupil: Mesh }[] = [];

  private readonly ball: Mesh;
  private readonly aimMarker: Mesh;
  private readonly clouds: InstancedMesh;
  private readonly cloudBase: { x: number; y: number; z: number; w: number; d: number }[] = [];

  private readonly debugLines: LineSegments;
  private readonly debugPoints: Points;
  private readonly debugPositions: Float32Array;
  private readonly debugPointPositions: Float32Array;
  private readonly landingMarker: Mesh;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    yard: Yard,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping; // keep pixel-art colours exactly as painted
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.camera = new PerspectiveCamera(42, 3 / 2, 10, 5000);
    this.camera.position.set(0, 200, 470);
    this.camera.lookAt(0, 10, -150);

    this.scene.background = new Color(SKY);
    this.scene.fog = new Fog(SKY, 1000, 2400);

    this.unitBox = this.track(new BoxGeometry(1, 1, 1));

    this.buildLights();
    this.buildWorld(yard);
    this.clouds = this.buildClouds();

    this.scene.add(this.pet);
    this.pet.add(this.body);
    this.body.add(this.torso);
    this.buildDog();
    this.collar = new BoxBone(this.unitBox, this.lambert(tex.collar()), this.pet);
    this.tongue = this.buildHead();

    // Ball: a pixel-textured cube, the same size as the physics ball.
    this.ball = new Mesh(this.unitBox, this.lambert(tex.tennisBall()));
    this.ball.castShadow = true;
    this.scene.add(this.ball);

    // Throw-target marker: a square outline (a 4-segment ring turned 45 degrees).
    const aimMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
    this.materials.push(aimMat);
    this.aimMarker = new Mesh(this.track(new RingGeometry(11, 15, 4)), aimMat);
    this.aimMarker.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
    this.scene.add(this.aimMarker);

    // Debug overlay (fixed-size buffers, drawn on top)
    this.debugPositions = new Float32Array(64 * 2 * 3);
    const lineGeo = this.track(new BufferGeometry());
    lineGeo.setAttribute('position', new BufferAttribute(this.debugPositions, 3));
    const lineMat = new LineBasicMaterial({ color: 0x0ea5e9, depthTest: false, transparent: true });
    this.materials.push(lineMat);
    this.debugLines = new LineSegments(lineGeo, lineMat);
    this.debugLines.renderOrder = 999;
    this.debugLines.frustumCulled = false;
    this.scene.add(this.debugLines);

    this.debugPointPositions = new Float32Array(64 * 3);
    const pointGeo = this.track(new BufferGeometry());
    pointGeo.setAttribute('position', new BufferAttribute(this.debugPointPositions, 3));
    const pointMat = new PointsMaterial({ color: 0x0ea5e9, size: 6, sizeAttenuation: false, depthTest: false, transparent: true });
    this.materials.push(pointMat);
    this.debugPoints = new Points(pointGeo, pointMat);
    this.debugPoints.renderOrder = 999;
    this.debugPoints.frustumCulled = false;
    this.scene.add(this.debugPoints);

    const landingMat = new MeshBasicMaterial({ color: 0xf59e0b, depthTest: false, transparent: true, side: DoubleSide });
    this.materials.push(landingMat);
    this.landingMarker = new Mesh(this.track(new RingGeometry(14, 19, 4)), landingMat);
    this.landingMarker.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
    this.landingMarker.renderOrder = 999;
    this.scene.add(this.landingMarker);

    // DOM HUD overlay: text is crisper and cheaper in the DOM than in WebGL.
    this.hud = document.createElement('div');
    this.hud.className = 'pixel-hud pointer-events-none absolute left-3 top-3 whitespace-pre';
    canvas.parentElement?.appendChild(this.hud);

    this.resize();
    // Compile every shader up front (all objects start visible), so the first throw doesn't hitch.
    this.renderer.compile(this.scene, this.camera);
  }

  resize(): void {
    const cssWidth = this.canvas.clientWidth || 600;
    const cssHeight = this.canvas.clientHeight || cssWidth / 1.5;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.camera.aspect = cssWidth / cssHeight;
    this.camera.updateProjectionMatrix();
  }

  draw(sim: PetSimulation, options: DrawOptions): void {
    this.time += 1 / Math.max(options.fps, 1);
    this.updatePet(sim.rig);
    this.updateBall(sim.ball);
    this.updateClouds();

    this.aimMarker.visible = sim.canThrow && options.aimVisible;
    if (this.aimMarker.visible) {
      this.aimMarker.position.set(options.aim.x, 0.6, options.aim.y);
      this.aimMarker.scale.setScalar(1 + Math.sin(this.time * 6) * 0.08);
    }

    this.updateDebug(sim, options.debug);
    this.updateHud(sim, options);
    this.renderer.render(this.scene, this.camera);
  }

  pickGround(ndcX: number, ndcY: number, out: Vec2): boolean {
    tmpNdc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(tmpNdc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    if (direction.y > -1e-4) return false; // looking at the sky
    const t = -origin.y / direction.y;
    out.x = origin.x + direction.x * t;
    out.y = origin.z + direction.z * t;
    return true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // release the GL context immediately (matters for HMR)
    this.hud.remove();
  }

  // World

  private buildLights(): void {
    this.scene.add(new HemisphereLight(0xffffff, 0x6b8a4a, 1.25));
    const sun = new DirectionalLight(0xfff6e6, 1.9);
    sun.position.set(-320, 620, 360);
    sun.target.position.set(0, 0, -150);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -700;
    s.right = 700;
    s.top = 700;
    s.bottom = -700;
    s.near = 100;
    s.far = 1800;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.8;
    sun.shadow.radius = 3;
    this.scene.add(sun, sun.target);
  }

  private buildWorld(yard: Yard): void {
    // Grass-block ground: one texture tile per block.
    const grass = this.keep(tex.grassTop());
    const size = 5000;
    grass.repeat.set(size / (BLOCK * 1.5), size / (BLOCK * 1.5));
    const ground = new Mesh(this.track(new PlaneGeometry(size, size)), this.lambert(grass));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Plank fence round the back and sides (open at the front, towards the player).
    const plankMat = this.lambert(tex.planks());
    const postPositions: [number, number][] = [];
    for (let x = yard.minX; x <= yard.maxX; x += 60) postPositions.push([x, yard.minZ]);
    for (let z = yard.minZ + 60; z <= yard.maxZ; z += 60) {
      postPositions.push([yard.minX, z]);
      postPositions.push([yard.maxX, z]);
    }
    const posts = new InstancedMesh(this.track(new BoxGeometry(10, 44, 10)), plankMat, postPositions.length);
    postPositions.forEach(([x, z], i) => posts.setMatrixAt(i, tmpMatrix.makeTranslation(x, 22, z)));
    posts.castShadow = true;
    posts.receiveShadow = true;
    this.scene.add(posts);

    const width = yard.maxX - yard.minX;
    const depth = yard.maxZ - yard.minZ;
    const railTexX = tex.planks();
    railTexX.wrapS = RepeatWrapping;
    railTexX.repeat.set(width / 32, 1);
    const railTexZ = tex.planks();
    railTexZ.wrapS = RepeatWrapping;
    railTexZ.repeat.set(depth / 32, 1);
    const railX = this.track(new BoxGeometry(width, 6, 4));
    const railZ = this.track(new BoxGeometry(4, 6, depth));
    const railMatX = this.lambert(railTexX);
    const railMatZ = this.lambert(railTexZ);
    for (const y of [16, 34]) {
      const back = new Mesh(railX, railMatX);
      back.position.set((yard.minX + yard.maxX) / 2, y, yard.minZ);
      const left = new Mesh(railZ, railMatZ);
      left.position.set(yard.minX, y, (yard.minZ + yard.maxZ) / 2);
      const right = new Mesh(railZ, railMatZ);
      right.position.set(yard.maxX, y, (yard.minZ + yard.maxZ) / 2);
      for (const rail of [back, left, right]) {
        rail.castShadow = true;
        this.scene.add(rail);
      }
    }

    this.buildTrees();

    // Carpet where the player stands; the pet drops the ball here.
    const rug = new Mesh(this.unitBox, this.lambert(tex.carpet()));
    rug.position.set(PLAYER.x, 1, PLAYER.z + 10);
    rug.scale.set(96, 2, 96);
    rug.receiveShadow = true;
    this.scene.add(rug);
  }

  /** Block trees: a log column with a layered leaf canopy, all in two InstancedMeshes. */
  private buildTrees(): void {
    const sites: [number, number, number][] = [
      [-520, -700, 5], [-300, -760, 4], [-80, -720, 6], [160, -780, 5], [380, -700, 5],
      [560, -560, 4], [-600, -420, 5], [620, -250, 6], [-640, -80, 4], [600, 60, 5],
    ];
    const logs: [number, number, number][] = [];
    const leafBlocks: [number, number, number][] = [];
    for (const [tx, tz, height] of sites) {
      const bx = Math.round(tx / BLOCK) * BLOCK;
      const bz = Math.round(tz / BLOCK) * BLOCK;
      for (let i = 0; i < height; i++) logs.push([bx, BLOCK * (i + 0.5), bz]);
      // Two wide layers (5x5 without corners), then a 3x3 layer and a plus-shaped top.
      const layers: [number, number, boolean][] = [
        [height - 2, 2, false],
        [height - 1, 2, false],
        [height, 1, false],
        [height + 1, 1, true],
      ];
      for (const [level, radius, plus] of layers) {
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dz = -radius; dz <= radius; dz++) {
            const corner = Math.abs(dx) === radius && Math.abs(dz) === radius;
            if (corner && (plus || radius === 2)) continue;
            if (dx === 0 && dz === 0 && level < height) continue; // the trunk is there
            leafBlocks.push([bx + dx * BLOCK, BLOCK * (level + 0.5), bz + dz * BLOCK]);
          }
        }
      }
    }
    const blockGeo = this.track(new BoxGeometry(BLOCK, BLOCK, BLOCK));
    const logMesh = new InstancedMesh(blockGeo, this.lambert(tex.oakLog()), logs.length);
    logs.forEach(([x, y, z], i) => logMesh.setMatrixAt(i, tmpMatrix.makeTranslation(x, y, z)));
    const leafMesh = new InstancedMesh(blockGeo, this.lambert(tex.leaves(81)), leafBlocks.length);
    leafBlocks.forEach(([x, y, z], i) => leafMesh.setMatrixAt(i, tmpMatrix.makeTranslation(x, y, z)));
    for (const m of [logMesh, leafMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }

  /** Flat blocky clouds drifting slowly across the sky. */
  private buildClouds(): InstancedMesh {
    const count = 9;
    let seed = 5;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      this.cloudBase.push({
        x: -1400 + i * 330 + rand() * 120,
        y: 560 + rand() * 120,
        z: -1300 + rand() * 700,
        w: 140 + rand() * 160,
        d: 80 + rand() * 120,
      });
    }
    const mat = new MeshLambertMaterial({ map: this.keep(tex.cloud()), transparent: true, opacity: 0.92 });
    this.materials.push(mat);
    const clouds = new InstancedMesh(this.unitBox, mat, count);
    this.scene.add(clouds);
    return clouds;
  }

  private updateClouds(): void {
    const span = 3000;
    for (let i = 0; i < this.cloudBase.length; i++) {
      const c = this.cloudBase[i];
      const x = ((((c.x + this.time * 12 + span / 2) % span) + span) % span) - span / 2;
      tmpMatrix.makeScale(c.w, 22, c.d).setPosition(x, c.y, c.z);
      this.clouds.setMatrixAt(i, tmpMatrix);
    }
    this.clouds.instanceMatrix.needsUpdate = true;
  }

  // Dog

  /** Body block, shoulder ruff, legs, neck and tail. */
  private buildDog(): void {
    const { dark, brown, tan, cream } = tex.FUR;

    const bodySide = tex.banded(16, 8, 101, [[2, dark], [4, brown], [6, tan], [8, cream]]);
    const bodyMats = this.boxMats(bodySide, tex.solid(102, [...dark, ...brown]), tex.solid(103, cream));
    const body = new Mesh(this.unitBox, bodyMats);
    body.position.set(-8, -1, 0);
    body.scale.set(76, 27, 25);
    body.castShadow = true;
    this.torso.add(body);

    // Shoulder ruff: the thick, shaggy front half.
    const ruffSide = tex.banded(8, 8, 104, [[3, brown], [6, tan], [8, cream]]);
    const ruffFront = tex.banded(8, 8, 105, [[2, brown], [5, tan], [8, cream]]);
    const ruff = new Mesh(
      this.unitBox,
      this.boxMats(ruffSide, tex.solid(106, [...dark, ...brown]), tex.solid(107, cream), ruffFront),
    );
    ruff.position.set(26, 2, 0);
    ruff.scale.set(34, 36, 33);
    ruff.castShadow = true;
    this.torso.add(ruff);

    // Legs: brown tops with cream "socks".
    const legSide = tex.banded(4, 12, 108, [[5, brown], [6, tan], [12, cream]]);
    const legMats = this.boxMats(legSide, tex.solid(109, tan), tex.solid(110, cream));
    for (let i = 0; i < 4; i++) this.legs.push(new BoxBone(this.unitBox, legMats, this.pet));

    const neckMat = this.lambert(tex.banded(8, 8, 111, [[3, brown], [8, tan]]));
    this.neck = new BoxBone(this.unitBox, neckMat, this.pet);

    const tailMat = this.lambert(tex.solid(112, [...brown, ...dark]));
    const tailTipMat = this.lambert(tex.solid(113, dark));
    this.tail.push(new BoxBone(this.unitBox, tailMat, this.pet));
    this.tail.push(new BoxBone(this.unitBox, tailMat, this.pet));
    this.tail.push(new BoxBone(this.unitBox, tailTipMat, this.pet));
  }

  /** Cube head in head-local space (y up, +x towards the snout). Returns the tongue. */
  private buildHead(): Mesh {
    const { dark, brown, tan, cream } = tex.FUR;
    const head = this.head;
    head.rotation.order = 'YZX'; // pitch in the sagittal plane first, then turn (yaw)
    this.pet.add(head);

    const skullSide = tex.banded(8, 8, 201, [[3, brown], [5, tan], [8, cream]]);
    const skullFront = tex.banded(8, 8, 202, [[2, brown], [8, tan]]);
    const skull = new Mesh(
      this.unitBox,
      this.boxMats(skullSide, tex.solid(203, [...brown, ...dark]), tex.solid(204, cream), skullFront, tex.solid(205, brown)),
    );
    skull.position.set(0, 2, 0);
    skull.scale.set(26, 26, 28);
    skull.castShadow = true;
    head.add(skull);

    const snoutSide = tex.banded(6, 4, 206, [[1, tan], [4, cream]]);
    const snout = new Mesh(
      this.unitBox,
      this.boxMats(snoutSide, tex.solid(207, tan), tex.solid(208, cream), tex.solid(209, cream)),
    );
    snout.position.set(21, -6.5, 0);
    snout.scale.set(16, 11, 15);
    snout.castShadow = true;
    head.add(snout);

    const nose = new Mesh(this.unitBox, this.lambert(tex.solid(210, ['#1f1a17', '#2a231f'], 4)));
    nose.position.set(29.5, -2.5, 0);
    nose.scale.set(3, 5, 9);
    head.add(nose);

    // Jaw: hinged at the back of the snout; opens while panting.
    this.jaw.position.set(13, -12, 0);
    head.add(this.jaw);
    const mouth = new Mesh(this.unitBox, this.lambert(tex.solid(211, ['#5a2323', '#4d1e1e'], 4)));
    mouth.position.set(8, 0.8, 0);
    mouth.scale.set(14, 1.6, 12);
    this.jaw.add(mouth);
    const jaw = new Mesh(this.unitBox, this.lambert(tex.solid(212, cream)));
    jaw.position.set(8, -1.5, 0);
    jaw.scale.set(15, 3.5, 13);
    this.jaw.add(jaw);
    const tongue = new Mesh(this.unitBox, this.lambert(tex.solid(213, ['#e0607a', '#d85672'], 4)));
    this.jaw.add(tongue);

    // Eyes on the front face: white block with a dark pupil block that follows the gaze.
    const white = this.lambert(tex.solid(214, ['#f2f2f2'], 2));
    const black = this.lambert(tex.solid(215, ['#141414'], 2));
    const brow = this.lambert(tex.solid(216, dark, 4));
    for (const side of [1, -1]) {
      const group = new Group();
      group.position.set(13.2, 6, side * 6.5);
      head.add(group);
      const eye = new Mesh(this.unitBox, white);
      eye.scale.set(0.8, 4, 5);
      group.add(eye);
      const pupil = new Mesh(this.unitBox, black);
      pupil.scale.set(1, 4, 2.4);
      group.add(pupil);
      const browBlock = new Mesh(this.unitBox, brow);
      browBlock.position.set(13.1, 9.5, side * 6.5);
      browBlock.scale.set(0.8, 1.6, 6);
      head.add(browBlock);
      this.eyes.push({ group, pupil });
    }

    // Upright block ears, hinged at the base so the ear spring can flick them.
    const earMats = this.boxMats(
      tex.solid(217, [...brown, ...dark], 4),
      tex.solid(219, dark, 4),
      tex.solid(220, brown, 4),
      tex.banded(4, 4, 218, [[1, brown], [4, cream]]),
    );
    for (const side of [1, -1]) {
      const pivot = new Group();
      pivot.position.set(-5, 15, side * 9);
      head.add(pivot);
      const ear = new Mesh(this.unitBox, earMats);
      ear.position.set(0, 5, 0);
      ear.scale.set(6, 10, 8);
      ear.castShadow = true;
      pivot.add(ear);
      this.ears.push(pivot);
    }
    return tongue;
  }

  // Per-frame updates

  private updatePet(rig: PetRig): void {
    this.pet.position.set(rig.position.x, 0, rig.position.y);
    this.pet.rotation.y = -rig.yaw; // local +x -> (cos yaw, 0, sin yaw)

    this.body.position.set(rig.root.x, -rig.root.y, 0);
    this.body.rotation.z = rig.pitch;
    this.torso.scale.set(1, 1 + rig.breath * 0.025, 1 + rig.breath * 0.02);

    // Legs: one rigid block from the planted foot up to the hip (swings like a blocky leg).
    for (let i = 0; i < rig.legs.length; i++) {
      const leg = rig.legs[i];
      this.legs[i].span(leg.foot.x, -leg.foot.y - 2, leg.hip.x, -leg.hip.y + 4, leg.side * 0.95, 10);
    }

    // Neck: ONE solid block from the shoulders into the head. Separate blocks per IK segment
    // leave gaps and kinks at every bend; a single block always reads as one clean neck. The
    // FABRIK chain still decides where the head goes (and how far the neck stretches).
    const neck = rig.neck;
    const base = neck[0];
    const top = neck[neck.length - 1];
    const w = 16 / Math.sqrt(rig.neckStretch);
    const dx = top.x - base.x;
    const dy = top.y - base.y;
    const len = Math.hypot(dx, dy) || 1;
    // Start a little inside the ruff so the joint into the body is hidden.
    const sx = base.x - (dx / len) * 6;
    const sy = base.y - (dy / len) * 6;
    this.neck.span(sx, -sy, top.x, -top.y, 0, w, w * 0.95);

    // Collar: a short, wider block around the lower part of the neck.
    this.collar.span(
      base.x + dx * 0.18, -(base.y + dy * 0.18),
      base.x + dx * 0.36, -(base.y + dy * 0.36),
      0, w + 3,
    );

    // Tail: three blocks following the joint chain, darker tip.
    const t = rig.tail;
    this.tail[0].span(t[0].x, -t[0].y, t[2].x, -t[2].y, 0, 8);
    this.tail[1].span(t[2].x, -t[2].y, t[4].x, -t[4].y, 0, 7);
    this.tail[2].span(t[4].x, -t[4].y, t[5].x, -t[5].y, 0, 6.5);

    // Head: pitch (headAngle is "down positive" in sagittal y-down space), then yaw.
    const headJoint = neck[neck.length - 1];
    this.head.position.set(headJoint.x, -headJoint.y, 0);
    this.head.rotation.z = -rig.headAngle;
    this.head.rotation.y = -rig.headYaw;

    // Ears flick back on the spring and tilt forward when excited.
    for (let i = 0; i < this.ears.length; i++) {
      this.ears[i].rotation.z = -rig.earAngle * 0.7;
      this.ears[i].rotation.x = (i === 0 ? 1 : -1) * 0.12;
    }

    // Panting: jaw drops and the tongue hangs out.
    const pant = rig.tongue;
    this.jaw.rotation.z = -0.3 * pant - 0.06 * pant * Math.max(0, rig.breath);
    this.tongue.visible = pant > 0.02;
    if (this.tongue.visible) {
      const len = 10 * pant;
      this.tongue.position.set(9, -3.2 - len / 2, 0);
      this.tongue.scale.set(7, len + 1, 6);
    }

    // Eyes: blink by squashing; pupils slide towards the gaze within the white.
    const open = Math.max(0.1, 1 - rig.blink);
    for (const eye of this.eyes) {
      eye.group.scale.set(1, open, 1);
      eye.pupil.position.set(0.15, rig.gaze.y * 0.6, 0.2 + rig.gaze.x * 1.3);
    }
  }

  private updateBall(ball: Ball): void {
    this.ball.visible = ball.state !== 'hidden';
    if (!this.ball.visible) return;
    // A carried ball sits a little lower, in the jaw, so it doesn't cover the eyes.
    const carried = ball.state === 'held';
    this.ball.position.set(ball.pos.x, ball.pos.y - (carried ? 4 : 0), ball.pos.z);
    this.ball.scale.setScalar(ball.radius * (carried ? 1.7 : 2));
    this.ball.rotation.set(ball.rollX, 0, ball.rollZ);
  }

  private updateDebug(sim: PetSimulation, enabled: boolean): void {
    this.debugLines.visible = enabled;
    this.debugPoints.visible = enabled;
    const showLanding = enabled && sim.fetchPhase === 'chase' && sim.ball.state === 'flying';
    this.landingMarker.visible = showLanding;
    if (!enabled) return;

    const { rig } = sim;
    const c = Math.cos(rig.yaw);
    const s = Math.sin(rig.yaw);
    const px = rig.position.x;
    const pz = rig.position.y;
    const lines = this.debugPositions;
    const points = this.debugPointPositions;
    let li = 0;
    let pi = 0;
    // Sagittal (x, y-down) + lateral -> world, written straight into the buffers.
    const write = (buf: Float32Array, i: number, p: Vec2, lateral: number) => {
      buf[i] = px + c * p.x - s * lateral;
      buf[i + 1] = -p.y;
      buf[i + 2] = pz + s * p.x + c * lateral;
    };
    const seg = (a: Vec2, b: Vec2, lateral: number) => {
      write(lines, li, a, lateral);
      write(lines, li + 3, b, lateral);
      li += 6;
    };
    const point = (p: Vec2, lateral: number) => {
      write(points, pi, p, lateral);
      pi += 3;
    };
    for (const leg of rig.legs) {
      seg(leg.hip, leg.knee, leg.side);
      seg(leg.knee, leg.foot, leg.side);
      point(leg.hip, leg.side);
      point(leg.knee, leg.side);
      point(leg.foot, leg.side);
    }
    for (const chain of [rig.neck, rig.tail]) {
      for (let i = 0; i < chain.length - 1; i++) seg(chain[i], chain[i + 1], 0);
      for (const j of chain) point(j, 0);
    }
    point(sim.headTarget, 0);
    if (showLanding) {
      const { pos } = sim.ball;
      lines[li++] = pos.x; lines[li++] = pos.y; lines[li++] = pos.z;
      lines[li++] = sim.landing.x; lines[li++] = 1; lines[li++] = sim.landing.z;
      this.landingMarker.position.set(sim.landing.x, 1, sim.landing.z);
    }

    const lineGeo = this.debugLines.geometry;
    lineGeo.setDrawRange(0, li / 3);
    (lineGeo.attributes.position as BufferAttribute).needsUpdate = true;
    const pointGeo = this.debugPoints.geometry;
    pointGeo.setDrawRange(0, pi / 3);
    (pointGeo.attributes.position as BufferAttribute).needsUpdate = true;
  }

  /** Writes to the DOM only when the text changes (FPS at most 4x a second) to avoid layout work. */
  private updateHud(sim: PetSimulation, options: DrawOptions): void {
    this.hudTimer += 1 / Math.max(options.fps, 1);
    if (this.hudTimer >= 0.25) {
      this.hudTimer = 0;
      this.hudFps = Math.round(options.fps);
    }
    const state = `STATE: ${sim.status.toUpperCase()}`;
    const text = options.debug ? `${state}\n${this.hudFps} FPS` : state;
    if (text !== this.hudText) {
      this.hudText = text;
      this.hud.textContent = text;
    }
  }

  // Helpers

  private keep<T extends Texture>(t: T): T {
    if (!this.textures.includes(t)) this.textures.push(t);
    return t;
  }

  private lambert(map: CanvasTexture): MeshLambertMaterial {
    this.keep(map);
    const m = new MeshLambertMaterial({ map });
    this.materials.push(m);
    return m;
  }

  /** Per-face materials in BoxGeometry order: +x (front), -x (back), +y (top), -y (bottom), +z, -z. */
  private boxMats(
    side: CanvasTexture,
    top: CanvasTexture,
    bottom: CanvasTexture,
    front?: CanvasTexture,
    back?: CanvasTexture,
  ): Material[] {
    const s = this.lambert(side);
    return [front ? this.lambert(front) : s, back ? this.lambert(back) : s, this.lambert(top), this.lambert(bottom), s, s];
  }

  private track<T extends BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }
}
