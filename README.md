# Creative Frontend Engineering Challenge: Interactive Pet Canvas

> ## 🐶 Submission: blocky 3D pet with throw-and-fetch
>
> **Play:** click the grass to throw the ball there, or flick / swipe up to throw it. The pup runs to where the ball will land, catches it (in mid-air if it can reach), brings it back to your carpet and drops it at your feet. Its head and eyes follow your cursor.
>
> - **Live demo:** _add your GitHub Pages URL here after the first deploy_
> - **How it works:** see [ARCHITECTURE.md](ARCHITECTURE.md) (structure, joint-vector maths, smooth-animation strategy)
> - **Stack:** TypeScript + Vite + three.js (WebGL). Procedural pixel-art textures, no image assets.
> - **Scripts:** `npm run dev` · `npm test` (53 tests) · `npm run build`
> - **Controls:** Idle / Sit / Go for Walk / Play Fetch (random throw). Press **D** to show the IK rig, targets and predicted landing spot.
> - **Deploy:** pushing to `main` runs `.github/workflows/deploy.yml` (tests, build, GitHub Pages). In the repo settings, set Pages → Source to "GitHub Actions".

---

Welcome! The goal of this take-home challenge is to evaluate your skills in real-time browser graphics, asset rigging, and vector transformations using an HTML5 Canvas workspace.

## The Task
Inside this repository, you will find a boilerplate setup containing a canvas element, a high-performance `requestAnimationFrame` loop, and a primitive skeletal layout. 

Your objective is to replace the boilerplate primitive shapes with an optimized, real-time client-side layer where:
1. **Idle State:** The pet's body breathes or shifts subtly using basic 2D mesh deformation or sprite transformations inside the continuous render loop.
2. **Interactive Tracking:** The pet's head/eyes smoothly track a moving coordinate target (the user's cursor position).
3. **Action State (Fetch):** When the user clicks the "Play Fetch" button, animate a visual ball asset flying across the screen, and have the pet's structure stretch or move dynamically to intercept it.

## Technical Constraints & Expectations
- **Client-Side Only:** All rendering must happen in real-time on the client side. No server-side rendering or heavy AI video generation dependencies.
- **Performance:** Maintain a smooth, jank-free frame rate (60fps/120Hz compatible). Efficiently manage memory allocations and clear WebGL/Canvas states to prevent resource leaks.
- **Math/Physics:** Use programmatic easing and proper vector transformations (like Inverse Kinematics) rather than pre-baked CSS transitions.
- **Cross-Platform Readiness:** Keep your animation state calculations decoupled from specific DOM nodes so the core mathematical logic could theoretically be ported to a mobile context (e.g., React Native).

---

## Local Development Setup

To run this project locally, ensure you have **Node.js** installed, then execute the following commands in your terminal:

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Start Development Server:**
   ```bash
   npm run dev
   ```

3. **Open the App:**
   Click the local link generated in your terminal (typically `http://localhost:5173`) to view the interactive canvas live.

---

## Submission Guidelines

Please follow these exact steps to submit your completed assignment:

1. **Fork this repository** to your personal GitHub account.
2. Complete your code implementations within the `src/engine/` structure.
3. **Add detailed inline comments** or a brief markdown summary explaining your architecture choices, how you calculated the joint vectors, and your strategy for rendering smooth animations.
4. **Submit a link to your forked repository** directly to us on onlinejobs.

We look forward to seeing your creative approach!
