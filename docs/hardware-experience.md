# hardware scroll experience

The official interface uses one original procedural Three.js hardware model and a normal document scroll, not a pre-recorded simulation or a copied third-party computer model.

## camera journey

`HardwareModel.ts` builds the enclosure, split lid, monitor, keyboard, motherboard, memory modules, traces, ports and processor maze. Repeated components are merged or instanced. `HardwareStage.tsx` maps the measured chapter positions to a reversible camera path through `cameraRoute.ts`. The casing opens during the motherboard chapter; the camera then moves close to the processor maze and across the other systems before returning to an overview beside the workshop.

The desktop sidebar remains separate from the visual world. Actual browser, agent and financial status comes from the existing read-only API. Scroll position never selects rat actions, advances a checkpoint, changes a launch flag or invokes a wallet.

## reference and recorded state

Without a recorded maze, the model displays the same fixed seed-125 reference apparatus as the original site. It is labeled as reference. When supplied, real maze coordinates, walls, reward and trail are mapped to the processor surface. Camera motion and case movement are presentation-only; the rat does not follow a scripted decorative route.

## motion and resource boundaries

Normal scroll controls the scene through GSAP ScrollTrigger without intercepting wheel input. Motion values do not use React state. Rendering is requested while the camera is changing or a relevant state update arrives, not as an unbounded idle animation loop. Geometry construction yields between bounded groups so input can be serviced during startup.

Mobile uses a wider, pulled-back composition, limited pixel density, no generated environment map and no shadow map. Reduced motion and the pause control retain a static scene; hidden tabs stop rendering. Effects, textures, buffers and event listeners are disposed on unmount and theme changes.

The fallback JPEGs are rendered from this original model, not generated screenshots of a fictional running experiment. They support unavailable/lost WebGL and early loading. Model materials and geometry are original project artwork; the reference site supplied motion inspiration, not assets.

## verification

`server/hardware-presentation.test.mjs` tests camera bounds, chapter mapping, reduced-motion poses, geometry construction, data immutability and disposal. `scripts/hardware-qa.mjs` checks desktop/mobile motion, reversal, pause/resume, reduced motion, unavailable WebGL, accessible controls, asset loading and unchanged experiment identity/state. No live scenario is reset to satisfy presentation tests.
