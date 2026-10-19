import './style.css';
import { PetAnimationEngine, type PetBehavior } from './engine/PetEngine';

const appDiv = document.getElementById('app') as HTMLDivElement;

// 1. Render the application container UI
appDiv.innerHTML = `
  <div class="pixel-panel flex flex-col items-center gap-5 p-4 sm:p-6">
    <div class="text-center">
      <h1 class="pixel-title text-base sm:text-xl">Pet Interactive Canvas</h1>
      <p class="pixel-text text-[9px] sm:text-[10px] mt-3">
        Click the grass to throw the ball there, or flick / swipe up to throw it.<br />
        Your pup will fetch it back!
      </p>
    </div>

    <!-- The WebGL viewport (backing size is set by the renderer for HiDPI) -->
    <div class="pixel-viewport relative w-full max-w-[720px] overflow-hidden bg-sky-300">
      <canvas id="pet-viewport" class="block w-full aspect-[3/2] cursor-crosshair select-none"></canvas>
    </div>

    <!-- Controller Panel Buttons -->
    <div class="flex flex-wrap justify-center gap-3">
      <button data-behavior="idle" class="behavior-btn pixel-btn">Idle</button>
      <button data-behavior="sit" class="behavior-btn pixel-btn">Sit</button>
      <button data-behavior="walk" class="behavior-btn pixel-btn">Go for Walk</button>
      <button data-behavior="fetch" class="behavior-btn pixel-btn">Play Fetch</button>
    </div>

    <label class="pixel-text flex items-center gap-2 text-[9px] select-none cursor-pointer">
      <input id="toggle-debug" type="checkbox" class="w-4 h-4 accent-emerald-600" />
      Show rig &amp; IK targets <kbd class="pixel-kbd">D</kbd>
    </label>
  </div>
`;

// 2. Initialize the engine (needs WebGL)
const canvas = document.getElementById('pet-viewport') as HTMLCanvasElement;
let engine: PetAnimationEngine;
try {
  engine = new PetAnimationEngine(canvas);
} catch (error) {
  console.error(error);
  canvas.replaceWith(
    Object.assign(document.createElement('p'), {
      className: 'pixel-text p-8 text-center text-xs',
      textContent: 'Sorry, this demo needs WebGL, which is not available in this browser.',
    }),
  );
  throw error;
}

// 3. Wire the controls
const buttons = document.querySelectorAll<HTMLButtonElement>('.behavior-btn');
buttons.forEach((btn) =>
  btn.addEventListener('click', () => engine.setBehavior(btn.dataset.behavior as PetBehavior)),
);

// Highlight the active behaviour (fetch returns to idle on its own, so the UI follows the engine).
const highlight = (behavior: PetBehavior) => {
  buttons.forEach((btn) => {
    const active = btn.dataset.behavior === behavior;
    btn.setAttribute('aria-pressed', String(active));
  });
};
engine.onBehaviorChange = (behavior) => highlight(behavior);
highlight('idle');

const debugToggle = document.getElementById('toggle-debug') as HTMLInputElement;
debugToggle.addEventListener('change', () => engine.setDebug(debugToggle.checked));
const onKey = (event: KeyboardEvent) => {
  if (event.key.toLowerCase() !== 'd' || event.target instanceof HTMLInputElement) return;
  debugToggle.checked = !debugToggle.checked;
  engine.setDebug(debugToggle.checked);
};
window.addEventListener('keydown', onKey);

// Release the loop, listeners and GL context on hot reload, so dev sessions don't stack up engines.
import.meta.hot?.dispose(() => {
  engine.destroy();
  window.removeEventListener('keydown', onKey);
});
