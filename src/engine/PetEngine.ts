import { clamp, damp } from '../core/math/motion';
import { vec2 } from '../core/math/vec2';
import { PetSimulation, type FetchPhase, type PetBehavior, type PointerState } from '../core/PetSimulation';
import { PointerInput, type ThrowGesture } from '../input/PointerInput';
import { ThreeRenderer } from '../render/ThreeRenderer';
import type { PetRenderer } from '../render/types';

export type { PetBehavior } from '../core/PetSimulation';

/**
 * Connects the simulation, renderer and input layers to the browser.
 *
 *   PointerInput (DOM) --> PetEngine (picking, gestures) --> PetSimulation (pure TS)
 *                                                       --> ThreeRenderer (WebGL)
 *
 * Owns the requestAnimationFrame loop and every browser resource (listeners, rAF handle,
 * WebGL context), and releases all of them in `destroy()`.
 */
export class PetAnimationEngine {
  readonly simulation: PetSimulation;
  private readonly renderer: PetRenderer;
  private readonly input: PointerInput;

  private animationFrameId: number | null = null;
  private lastTime: number | null = null;
  private fps = 60;
  private debug = false;

  // Reused every frame (no allocation in the loop).
  private readonly groundPointer: PointerState = { x: 0, z: 0, active: false };
  private readonly aim = vec2();
  private readonly drawOptions = { debug: false, fps: 60, aim: this.aim, aimVisible: false };

  /** Called whenever the behaviour or fetch phase changes (e.g. to highlight UI buttons). */
  onBehaviorChange?: (behavior: PetBehavior, phase: FetchPhase) => void;

  /** Throws if WebGL is unavailable; the caller should show a fallback message. */
  constructor(canvas: HTMLCanvasElement) {
    this.simulation = new PetSimulation();
    this.simulation.onBehaviorChange = (b, p) => this.onBehaviorChange?.(b, p);
    this.renderer = new ThreeRenderer(canvas, this.simulation.yard);
    this.input = new PointerInput(canvas);
    this.input.onGesture = this.onGesture;

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.start();
  }

  setBehavior(behavior: PetBehavior): void {
    this.simulation.setBehavior(behavior);
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  destroy(): void {
    this.stop();
    this.input.dispose();
    this.renderer.dispose();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.simulation.onBehaviorChange = undefined;
  }

  private start(): void {
    if (this.animationFrameId !== null) return;
    this.lastTime = null; // the first frame after (re)starting gets dt = 0, not the pause length
    this.animationFrameId = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = null;
  }

  // Bound once; passing the same function to rAF each frame avoids allocating a closure per frame.
  private readonly frame = (timestamp: number): void => {
    const dt = this.lastTime === null ? 0 : (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;
    if (dt > 0) this.fps = damp(this.fps, 1 / dt, 4, dt);

    // Project the screen pointer onto the ground for the pet's gaze and the aim marker.
    const screen = this.input.state;
    const hit = screen.active && this.renderer.pickGround(screen.ndcX, screen.ndcY, this.aim);
    this.groundPointer.active = hit;
    this.groundPointer.x = this.aim.x;
    this.groundPointer.z = this.aim.y;

    this.simulation.update(dt, this.groundPointer);

    this.drawOptions.debug = this.debug;
    this.drawOptions.fps = this.fps;
    this.drawOptions.aimVisible = hit;
    this.renderer.draw(this.simulation, this.drawOptions);

    this.animationFrameId = requestAnimationFrame(this.frame);
  };

  /**
   * Tap (or slow drag): throw to the ground point under the pointer.
   * Flick: throw with the swipe's velocity. Swiping up throws away from the camera, sideways
   * swipes add sideways speed, and a faster swipe throws further and higher.
   */
  private readonly onGesture = (gesture: ThrowGesture): void => {
    if (gesture.kind === 'tap') {
      if (this.renderer.pickGround(gesture.ndcX, gesture.ndcY, this.aim)) {
        this.simulation.throwTo(this.aim.x, this.aim.y);
      }
      return;
    }
    const forward = clamp(-gesture.vy, 0.4, 4.5); // canvas-heights/s, up is "away"
    const sideways = clamp(gesture.vx, -4, 4);
    this.simulation.throwWithVelocity(sideways * 220, 330 + forward * 90, -forward * 260);
  };

  private readonly onResize = (): void => {
    this.renderer.resize(); // devicePixelRatio changes with browser zoom or moving between monitors
  };

  // Don't burn battery in a background tab; resume cleanly when visible again.
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };
}
