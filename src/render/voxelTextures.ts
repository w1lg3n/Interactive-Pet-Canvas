import { CanvasTexture, NearestFilter, RepeatWrapping, SRGBColorSpace } from 'three';

/**
 * Procedural pixel-art textures for the blocky (voxel) art style.
 *
 * Each texture is painted pixel by pixel into a tiny canvas with a seeded RNG, so the look is
 * deterministic and needs no image assets. Nearest-neighbour filtering keeps the pixels crisp
 * when they are magnified onto large faces.
 */

type Rand = () => number;
type Painter = (x: number, y: number, rand: Rand) => string;

export function pixelTexture(width: number, height: number, seed: number, paint: Painter): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  let s = seed;
  const rand: Rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      ctx.fillStyle = paint(x, y, rand);
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export const pick = (rand: Rand, palette: readonly string[]): string =>
  palette[Math.floor(rand() * palette.length)];

// Fur palettes (grey-brown wolf-dog).
export const FUR = {
  dark: ['#4a3526', '#543d2b', '#5f4632'],
  brown: ['#6e5038', '#7a5a3f', '#84624a'],
  tan: ['#a07c58', '#ab8763', '#b8946d'],
  cream: ['#d6c3a5', '#ddcbb0', '#e5d6bf'],
} as const;

/** Vertical banding: picks a palette by row (top to bottom). */
export function banded(width: number, height: number, seed: number, bands: [number, readonly string[]][]) {
  return pixelTexture(width, height, seed, (_x, y, r) => {
    for (const [untilRow, palette] of bands) if (y < untilRow) return pick(r, palette);
    return pick(r, bands[bands.length - 1][1]);
  });
}

export const solid = (seed: number, palette: readonly string[], size = 8) =>
  pixelTexture(size, size, seed, (_x, _y, r) => pick(r, palette));

/** Grass block top, with darker edge pixels so the ground reads as a grid of blocks. */
export function grassTop(): CanvasTexture {
  const t = pixelTexture(16, 16, 11, (x, y, r) => {
    if (x === 0 || y === 0) return pick(r, ['#5a9a3c', '#5e9f3f']);
    return pick(r, ['#6fb048', '#78b94f', '#6aa944', '#82c257', '#73b34b']);
  });
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

export const oakLog = () =>
  pixelTexture(8, 8, 21, (x, _y, r) => pick(r, x % 3 === 0 ? ['#5a4128', '#52391f'] : ['#6b4e2e', '#735434', '#664a2b']));

export const leaves = (seed: number) =>
  pixelTexture(8, 8, seed, (_x, _y, r) => (r() < 0.12 ? '#2f5e22' : pick(r, ['#3f7d2c', '#4a8a34', '#468530', '#559a3b'])));

export const planks = () =>
  pixelTexture(16, 8, 31, (x, y, r) =>
    y === 3 || y === 7 ? '#7a5730' : x === 5 && y < 3 ? '#7a5730' : pick(r, ['#a87d4a', '#b38652', '#a07546']),
  );

/** Red-and-cream carpet with a border. */
export const carpet = () =>
  pixelTexture(16, 16, 41, (x, y, r) => {
    const edge = x === 0 || y === 0 || x === 15 || y === 15;
    const inner = x === 2 || y === 2 || x === 13 || y === 13;
    if (edge) return pick(r, ['#8c2a2a', '#7e2424']);
    if (inner) return pick(r, ['#e9dcc0', '#f1e6cc']);
    return pick(r, ['#b83a3a', '#c24141', '#ad3434']);
  });

/** Yellow-green tennis-ball block with a white seam. */
export const tennisBall = () =>
  pixelTexture(8, 8, 51, (x, y, r) =>
    (y === 2 && x < 5) || (y === 5 && x > 2) || (x === 4 && (y === 3 || y === 4))
      ? '#f4f7e6'
      : pick(r, ['#c9de3a', '#bfd535', '#d2e544']),
  );

export const collar = () =>
  pixelTexture(8, 4, 61, (_x, y, r) => (y === 0 || y === 3 ? '#8f1f1f' : pick(r, ['#d33a3a', '#c93434'])));

export const cloud = () => pixelTexture(4, 4, 71, (_x, _y, r) => pick(r, ['#ffffff', '#f6f9fc']));
