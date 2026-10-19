/** Pointer position in normalised device coordinates (-1..1, y up), as WebGL picking expects. */
export interface ScreenPointer {
  ndcX: number;
  ndcY: number;
  /** The pointer is over the canvas (or a touch is down). */
  active: boolean;
  /** A button / finger is currently pressed. */
  pressed: boolean;
}

/**
 * A finished throw gesture.
 *  - `tap`: a click, or a slow drag-and-release. Throw to the ground point under (ndcX, ndcY).
 *  - `flick`: a fast swipe. `vx`/`vy` are the release velocity in canvas-heights per second
 *    (screen axes, y down), so throw power doesn't depend on the canvas size.
 */
export interface ThrowGesture {
  kind: 'tap' | 'flick';
  ndcX: number;
  ndcY: number;
  vx: number;
  vy: number;
}

const SAMPLE_COUNT = 8;
const VELOCITY_WINDOW_MS = 90;
const TAP_SLOP_PX = 12;
const FLICK_MIN_SPEED = 1.2; // canvas-heights per second

/**
 * Turns DOM pointer events (mouse, pen and touch) into plain data: a hover position and
 * throw gestures. This is the only place that knows about DOM events; a React Native port would
 * replace it with a gesture-handler adapter that produces the same shapes.
 */
export class PointerInput {
  readonly state: ScreenPointer = { ndcX: 0, ndcY: 0, active: false, pressed: false };
  onGesture?: (gesture: ThrowGesture) => void;

  // Ring buffer of recent positions for release-velocity estimation (allocated once).
  private readonly samples = Array.from({ length: SAMPLE_COUNT }, () => ({ x: 0, y: 0, t: 0 }));
  private sampleIndex = 0;
  private sampleCount = 0;
  private startX = 0;
  private startY = 0;
  private maxTravel = 0;

  constructor(private readonly element: HTMLElement) {
    element.style.touchAction = 'none'; // keep touch drags from scrolling the page
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerdown', this.onDown);
    element.addEventListener('pointerup', this.onUp);
    element.addEventListener('pointerleave', this.onLeave);
    element.addEventListener('pointercancel', this.onCancel);
  }

  dispose(): void {
    this.element.removeEventListener('pointermove', this.onMove);
    this.element.removeEventListener('pointerdown', this.onDown);
    this.element.removeEventListener('pointerup', this.onUp);
    this.element.removeEventListener('pointerleave', this.onLeave);
    this.element.removeEventListener('pointercancel', this.onCancel);
  }

  private updatePosition(event: PointerEvent): void {
    const rect = this.element.getBoundingClientRect();
    this.state.ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.state.ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    this.state.active = true;
  }

  private pushSample(event: PointerEvent): void {
    const s = this.samples[this.sampleIndex];
    s.x = event.clientX;
    s.y = event.clientY;
    s.t = event.timeStamp;
    this.sampleIndex = (this.sampleIndex + 1) % SAMPLE_COUNT;
    this.sampleCount = Math.min(this.sampleCount + 1, SAMPLE_COUNT);
  }

  // Arrow-function fields keep stable references, so removeEventListener works.
  private readonly onDown = (event: PointerEvent): void => {
    try {
      this.element.setPointerCapture(event.pointerId); // keep receiving moves if the drag leaves the canvas
    } catch {
      // Synthetic or already-released pointers cannot be captured; the gesture still works.
    }
    this.updatePosition(event);
    this.state.pressed = true;
    this.sampleCount = 0;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.maxTravel = 0;
    this.pushSample(event);
  };

  private readonly onMove = (event: PointerEvent): void => {
    this.updatePosition(event);
    if (!this.state.pressed) return;
    this.pushSample(event);
    this.maxTravel = Math.max(this.maxTravel, Math.hypot(event.clientX - this.startX, event.clientY - this.startY));
  };

  private readonly onUp = (event: PointerEvent): void => {
    if (!this.state.pressed) return;
    this.updatePosition(event);
    this.pushSample(event);
    this.state.pressed = false;
    if (event.pointerType !== 'mouse') this.state.active = false;

    // Release velocity: newest sample vs the oldest one inside the time window.
    const newest = this.samples[(this.sampleIndex - 1 + SAMPLE_COUNT) % SAMPLE_COUNT];
    let oldest = newest;
    for (let i = 1; i < this.sampleCount; i++) {
      const s = this.samples[(this.sampleIndex - 1 - i + SAMPLE_COUNT * 2) % SAMPLE_COUNT];
      if (newest.t - s.t > VELOCITY_WINDOW_MS) break;
      oldest = s;
    }
    const dt = Math.max((newest.t - oldest.t) / 1000, 1 / 240);
    const height = this.element.getBoundingClientRect().height || 1;
    const vx = (newest.x - oldest.x) / height / dt;
    const vy = (newest.y - oldest.y) / height / dt;

    const isFlick = this.maxTravel > TAP_SLOP_PX && Math.hypot(vx, vy) > FLICK_MIN_SPEED;
    this.onGesture?.({ kind: isFlick ? 'flick' : 'tap', ndcX: this.state.ndcX, ndcY: this.state.ndcY, vx, vy });
  };

  private readonly onLeave = (): void => {
    if (!this.state.pressed) this.state.active = false;
  };

  private readonly onCancel = (): void => {
    this.state.pressed = false;
    this.state.active = false;
  };
}
