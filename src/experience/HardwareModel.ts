import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Maze } from "../types";

export type HardwareModelOptions = {
  theme: "light" | "dark";
  maze: Maze | null;
  statusLabel: string;
  steps: number;
};
export type HardwareModel = {
  root: THREE.Group;
  mazeCenter: THREE.Vector3;
  setExplode(t: number): void;
  setMaze(maze: Maze | null): void;
  setStatus(label: string, steps: number): void;
  dispose(): void;
};

type XYZ = [number, number, number];
const CELL = 0.5;

/** The same fixed seed-125, 7×7 reference apparatus used by Scenes.tsx.
 * This is an illustration, not an episode: no invented trail, clock or policy.
 * Coordinates are continuous maze coordinates, NOT integer cell indices.
 */
function referenceMaze(): Maze {
  const size = 7,
    seen = new Set<string>(),
    open = new Set<string>();
  let seed = 125;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 0x3c6ef35f) >>> 0;
    return seed / 4294967296;
  };
  const edge = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  function visit(x: number, z: number) {
    seen.add(`${x},${z}`);
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]
      .map((d) => ({ d, v: random() }))
      .sort((a, b) => a.v - b.v);
    for (const {
      d: [dx, dz],
    } of dirs) {
      const nx = x + dx,
        nz = z + dz;
      if (
        nx < 0 ||
        nz < 0 ||
        nx >= size ||
        nz >= size ||
        seen.has(`${nx},${nz}`)
      )
        continue;
      open.add(edge(z * size + x, nz * size + nx));
      visit(nx, nz);
    }
  }
  visit(0, 0);
  const walls = [
    [0, 0, 7, 0],
    [7, 0, 7, 7],
    [7, 7, 0, 7],
    [0, 7, 0, 0],
  ];
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      if (x < 6 && !open.has(edge(z * size + x, z * size + x + 1)))
        walls.push([x + 1, z, x + 1, z + 1]);
      if (z < 6 && !open.has(edge(z * size + x, (z + 1) * size + x)))
        walls.push([x, z + 1, x + 1, z + 1]);
    }
  return {
    size,
    walls,
    rat: { x: 0.5, z: 0.5, heading: Math.PI },
    reward: { x: 6.5, z: 6.5 },
    trail: [],
  };
}

/** All geometry is original procedural artwork. No renderer, timers or network work.
 * Axes: board x=[-6,6], z=[-4,4], top y=.30; monitor faces +z.
 * Stable named groups and root.userData.landmarks support camera authoring.
 */
function* buildHardwareChunks({
  theme,
  maze,
  statusLabel,
  steps,
}: HardwareModelOptions): Generator<void, HardwareModel, void> {
  const root = new THREE.Group();
  root.name = "prr-hardware";
  const mazeCenter = new THREE.Vector3(0, 0.6, 0);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  let disposed = false;
  const material = (color: number, metalness = 0, roughness = 0.5) => {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    materials.add(m);
    return m;
  };
  const ivory = material(theme === "dark" ? 0xc9c8bb : 0xe8e6da, 0.35, 0.32);
  const silver = material(0xb9c0bf, 0.82, 0.29);
  const edgeMetal = material(0x656d6c, 0.8, 0.38);
  const graphite = material(0x222a2a, 0.25, 0.64);
  const black = material(0x101515, 0.1, 0.65);
  const rubber = material(0x242827, 0, 0.9);
  const yellow = material(0xe8ce37, 0.35, 0.37);
  const traceMat = material(0x62695c, 0.65, 0.48);
  const ceramic = material(0x9a9988, 0.2, 0.7);
  const wallMaterial = material(0xd9ddcf, 0.45, 0.35);

  const group = (name: string, parent = root) => {
    const g = new THREE.Group();
    g.name = name;
    parent.add(g);
    return g;
  };
  const chassis = group("chassis");
  const board = group("motherboard");
  const lid = group("removable-lid");
  const lidLeft = group("lid-left", lid),
    lidRight = group("lid-right", lid);
  const monitor = group("monitor");
  monitor.position.set(0, 0, -4.65);
  const keyboard = group("keyboard");
  keyboard.position.set(0, -0.25, 5.65);
  const processor = group("maze-processor");
  const rat = group("rat", processor);
  const batches = new Map<
    THREE.Group,
    Map<THREE.Material, THREE.BufferGeometry[]>
  >();
  const scratch = new THREE.Object3D();

  // Bake repetition into one draw per material per independently moving part.
  function bake(
    parent: THREE.Group,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    at: XYZ = [0, 0, 0],
    rotation: XYZ = [0, 0, 0],
    scale: XYZ = [1, 1, 1],
  ) {
    scratch.position.set(...at);
    scratch.rotation.set(...rotation);
    scratch.scale.set(...scale);
    scratch.updateMatrix();
    let g = geo;
    if (g.index) {
      g = geo.toNonIndexed();
      geo.dispose();
    }
    g.applyMatrix4(scratch.matrix);
    if (!batches.has(parent)) batches.set(parent, new Map());
    const bucket = batches.get(parent)!;
    if (!bucket.has(mat)) bucket.set(mat, []);
    bucket.get(mat)!.push(g);
  }
  function box(
    parent: THREE.Group,
    mat: THREE.Material,
    at: XYZ,
    size: XYZ,
    radius = 0,
  ) {
    bake(
      parent,
      radius
        ? new RoundedBoxGeometry(...size, 2, radius)
        : new THREE.BoxGeometry(...size),
      mat,
      at,
    );
  }
  function cylinder(
    parent: THREE.Group,
    mat: THREE.Material,
    at: XYZ,
    radius: number,
    height: number,
    rotation: XYZ = [0, 0, 0],
    sides = 16,
  ) {
    bake(
      parent,
      new THREE.CylinderGeometry(radius, radius, height, sides),
      mat,
      at,
      rotation,
    );
  }
  function cable(
    parent: THREE.Group,
    mat: THREE.Material,
    points: XYZ[],
    radius = 0.065,
  ) {
    const curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(...p)),
    );
    bake(parent, new THREE.TubeGeometry(curve, 32, radius, 8, false), mat);
  }
  function screw(parent: THREE.Group, x: number, y: number, z: number) {
    cylinder(parent, silver, [x, y, z], 0.083, 0.045, [0, 0, 0], 12);
    box(parent, black, [x, y + 0.024, z], [0.094, 0.006, 0.019]);
    box(parent, black, [x, y + 0.025, z], [0.019, 0.006, 0.094]);
  }
  function trace(points: [number, number][], width = 0.019) {
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1],
        [bx, bz] = points[i];
      bake(
        board,
        new THREE.BoxGeometry(Math.hypot(bx - ax, bz - az), 0.006, width),
        traceMat,
        [(ax + bx) / 2, 0.307, (az + bz) / 2],
        [0, -Math.atan2(bz - az, bx - ax), 0],
      );
    }
  }

  // Lower casting, rolled rim, rubber reveal and two protected front corner grips.
  box(chassis, ivory, [0, -0.54, 0], [12.9, 0.62, 8.95], 0.22);
  box(chassis, edgeMetal, [0, -0.19, 0], [12.65, 0.1, 8.72], 0.045);
  box(chassis, black, [0, -0.11, 0], [12.4, 0.08, 8.5], 0.035);
  for (const x of [-6.2, 6.2]) {
    box(chassis, ivory, [x, 0.48, 0], [0.38, 1.22, 8.62], 0.14);
    box(chassis, silver, [x, 1.07, 0], [0.3, 0.08, 8.36], 0.025);
    for (let z = -3.4; z <= 3.4; z += 0.31)
      box(
        chassis,
        black,
        [x + Math.sign(x) * 0.194, 0.3, z],
        [0.012, 0.48, 0.12],
        0.005,
      );
  }
  for (const z of [-4.2, 4.2])
    box(chassis, ivory, [0, 0.42, z], [12.1, 1.08, 0.34], 0.1);
  box(chassis, black, [0, 0.4, 4.378], [9.8, 0.31, 0.016], 0.007);
  for (let x = -3; x < 3.1; x += 0.17)
    box(chassis, edgeMetal, [x, 0.4, 4.394], [0.042, 0.24, 0.025]);
  box(chassis, yellow, [-5.35, 0.43, 4.393], [0.8, 0.11, 0.032], 0.025);
  for (const x of [-5.3, 5.3])
    for (const z of [-3.35, 3.35]) {
      cylinder(chassis, rubber, [x, -0.94, z], 0.43, 0.23);
      cylinder(chassis, silver, [x, -0.8, z], 0.32, 0.08);
      cylinder(board, silver, [x, 0.06, z], 0.105, 0.28, [0, 0, 0], 6);
      screw(board, x, 0.34, z);
    }
  box(board, graphite, [0, 0.21, 0], [12, 0.18, 8], 0.065);
  box(board, edgeMetal, [0, 0.115, 0], [11.91, 0.025, 7.91]);

  yield;
  // A raised split lid, with a real open central seam and recessed metal vents.
  for (const [part, sign] of [
    [lidLeft, -1],
    [lidRight, 1],
  ] as const) {
    box(part, ivory, [sign * 3.19, 1.63, 0], [6.35, 0.28, 8.8], 0.125);
    box(part, edgeMetal, [sign * 6.25, 1.33, 0], [0.18, 0.38, 8.35], 0.055);
    box(part, black, [sign * 3.4, 1.776, -1.65], [3.9, 0.015, 3.6], 0.007);
    for (let z = -3.26; z <= -0.06; z += 0.145)
      box(part, ivory, [sign * 3.4, 1.794, z], [3.91, 0.042, 0.062], 0.021);
    for (const z of [-3.83, 3.83])
      for (const x of [sign * 0.36, sign * 5.9]) screw(part, x, 1.79, z);
    box(part, silver, [sign * 3.4, 1.782, 3.49], [4.6, 0.02, 0.03]);
  }
  box(lidLeft, yellow, [-5.2, 1.79, 2.65], [0.11, 0.025, 0.87], 0.012);

  yield;
  // Socket, plated perimeter pads and a recessed ceramic maze floor.
  box(processor, black, [0, 0.405, 0], [4.48, 0.21, 4.48], 0.09);
  box(processor, silver, [0, 0.54, 0], [4.22, 0.12, 4.22], 0.055);
  box(processor, graphite, [0, 0.62, 0], [3.88, 0.06, 3.88], 0.025);
  for (let i = 0; i < 32; i++) {
    const p = -1.94 + i * 0.125;
    for (const sign of [-1, 1]) {
      box(board, silver, [p, 0.37, sign * 2.3], [0.055, 0.08, 0.3]);
      box(board, silver, [sign * 2.3, 0.37, p], [0.3, 0.08, 0.055]);
    }
  }
  for (const x of [-2, 2])
    for (const z of [-2, 2]) screw(processor, x, 0.625, z);

  yield;
  // Memory: upright PCBs, contact fingers, individual packages and ejector clips.
  for (const x of [-4.72, -3.86]) {
    box(board, black, [x, 0.43, -0.15], [0.37, 0.24, 4.72], 0.04);
    box(board, graphite, [x, 1, -0.15], [0.085, 1.1, 4.3], 0.028);
    box(board, silver, [x, 1.57, -0.15], [0.1, 0.07, 4.22], 0.025);
    for (let j = 0; j < 8; j++)
      for (const sign of [-1, 1]) {
        box(
          board,
          black,
          [x + sign * 0.088, 1.06, -1.94 + j * 0.51],
          [0.105, 0.63, 0.4],
          0.035,
        );
      }
    for (let j = 0; j < 38; j++)
      for (const sign of [-1, 1])
        box(
          board,
          silver,
          [x + sign * 0.047, 0.55, -2.17 + j * 0.109],
          [0.009, 0.19, 0.047],
        );
    for (const z of [-2.49, 2.19])
      box(board, ivory, [x, 0.66, z], [0.42, 0.48, 0.22], 0.06);
  }

  function ic(x: number, z: number, w: number, d: number) {
    box(board, black, [x, 0.47, z], [w, 0.27, d], 0.045);
    box(board, graphite, [x, 0.613, z], [w * 0.76, 0.019, d * 0.7], 0.009);
    const count = Math.floor(d / 0.14);
    for (let i = 0; i < count; i++)
      for (const s of [-1, 1]) {
        box(
          board,
          silver,
          [x + s * (w / 2 + 0.08), 0.36, z - d / 2 + 0.07 + i * 0.14],
          [0.21, 0.04, 0.046],
        );
      }
    cylinder(
      board,
      ceramic,
      [x - w * 0.28, 0.63, z - d * 0.25],
      0.036,
      0.009,
      [0, 0, 0],
      8,
    );
  }
  ic(3.28, 2.48, 1.15, 1.1);
  ic(4.95, 2.45, 0.7, 1.35);
  ic(-2.75, 2.97, 0.58, 0.85);
  ic(-0.9, 3.15, 1.3, 0.6);
  ic(1.05, 3.15, 1.3, 0.6);
  ic(0.4, -3.05, 1.7, 0.75);
  ic(2.5, -3.13, 0.85, 0.68);

  yield;
  // Fin stack with copper-free silver heat pipes. Stationary fan, no fake telemetry.
  box(board, edgeMetal, [4.08, 0.48, -0.75], [2.29, 0.27, 2.5], 0.08);
  for (let i = 0; i < 18; i++)
    box(board, silver, [3.06 + i * 0.12, 1, -0.75], [0.052, 0.89, 2.35]);
  for (const z of [-1.55, 0.05])
    cable(
      board,
      edgeMetal,
      [
        [2.92, 0.7, z],
        [3.0, 1.54, z],
        [4.6, 1.57, z],
        [5.22, 0.7, z],
      ],
      0.078,
    );
  for (let i = 0; i < 9; i++) {
    const x = 2.82 + (i % 3) * 0.43,
      z = -2.55 + Math.floor(i / 3) * 0.37;
    cylinder(board, black, [x, 0.63, z], 0.143, 0.59);
    cylinder(board, silver, [x, 0.94, z], 0.137, 0.035);
    box(board, edgeMetal, [x, 0.961, z], [0.18, 0.006, 0.017]);
    box(board, edgeMetal, [x, 0.962, z], [0.017, 0.006, 0.18]);
  }
  for (let i = 0; i < 44; i++) {
    const side = i < 22 ? -1 : 1,
      j = i % 22;
    const x = side * (2.69 + (j % 2) * 0.2),
      z = -1.85 + Math.floor(j / 2) * 0.36;
    box(board, ceramic, [x, 0.36, z], [0.1, 0.09, 0.17]);
    for (const dz of [-0.081, 0.081])
      box(board, silver, [x, 0.365, z + dz], [0.105, 0.08, 0.035]);
  }

  yield;
  // Routed diagonal escape traces, signal buses and plated through-holes.
  for (let i = 0; i < 22; i++) {
    const p = -1.8 + i * 0.17;
    trace(
      [
        [p, 2.34],
        [p, 2.56 + i * 0.025],
        [p + 0.4, 2.96 + i * 0.025],
        [p + 0.4, 3.83],
      ],
      0.015,
    );
    trace(
      [
        [p, -2.34],
        [p, -2.49 - i * 0.019],
        [p - 0.42, -2.91 - i * 0.019],
        [p - 0.42, -3.8],
      ],
      0.015,
    );
    trace(
      [
        [2.34, p],
        [2.56 + i * 0.009, p],
        [2.73 + i * 0.009, p + 0.17],
      ],
      0.014,
    );
  }
  for (let i = 0; i < 18; i++) {
    const z = -3.5 + i * 0.4;
    trace(
      [
        [-5.78, z],
        [-5.4, z],
        [-5.1, z + 0.3],
      ],
      0.022,
    );
    for (const x of [-5.76, 5.73]) {
      cylinder(board, silver, [x, 0.313, z], 0.038, 0.012, [0, 0, 0], 8);
      cylinder(board, black, [x, 0.323, z], 0.019, 0.012, [0, 0, 0], 8);
    }
  }
  yield;
  // Rear I/O housings have recessed cavities, tongues and actual contact geometry.
  for (let i = 0; i < 5; i++) {
    const x = -4.8 + i * 1.07;
    box(board, silver, [x, 0.67, -3.62], [0.88, 0.65, 0.62], 0.06);
    box(board, black, [x, 0.68, -3.939], [0.65, 0.41, 0.019], 0.009);
    box(board, graphite, [x, 0.64, -3.956], [0.52, 0.07, 0.024]);
    for (let j = 0; j < 5; j++)
      box(
        board,
        silver,
        [x - 0.21 + j * 0.105, 0.69, -3.974],
        [0.042, 0.04, 0.015],
      );
  }
  cable(
    board,
    rubber,
    [
      [5.5, 0.48, 2.5],
      [5.6, 0.62, 1.3],
      [5.65, 0.64, -2.1],
      [4.9, 0.65, -3.45],
    ],
    0.092,
  );
  cable(
    board,
    yellow,
    [
      [5.3, 0.47, 2.5],
      [5.35, 0.59, 1.3],
      [5.4, 0.57, -2.1],
      [4.7, 0.59, -3.45],
    ],
    0.037,
  );
  for (const z of [-2, 0, 2])
    box(board, silver, [5.52, 0.73, z], [0.32, 0.06, 0.12], 0.025);

  yield;
  // Monitor is a thick radiused instrument with inset face and a cast yoke.
  box(monitor, edgeMetal, [0, -0.1, -0.15], [3.6, 0.24, 1.55], 0.11);
  box(monitor, silver, [0, 1.08, -0.19], [0.68, 2.25, 0.47], 0.14);
  cylinder(monitor, edgeMetal, [0, 2.1, -0.1], 0.28, 2.1, [0, 0, Math.PI / 2]);
  box(monitor, ivory, [0, 3.18, 0], [8.55, 4.42, 0.65], 0.25);
  box(monitor, black, [0, 3.32, 0.343], [7.96, 3.73, 0.095], 0.04);
  box(monitor, graphite, [0, 3.33, 0.397], [7.63, 3.4, 0.026], 0.012);
  box(monitor, yellow, [3.63, 1.2, 0.35], [0.22, 0.07, 0.022], 0.012);
  for (let i = 0; i < 24; i++)
    box(
      monitor,
      black,
      [-2.3 + i * 0.2, 4.88, -0.333],
      [0.09, 0.25, 0.012],
      0.006,
    );
  cable(
    monitor,
    rubber,
    [
      [0.65, 0.05, -0.2],
      [1.2, 0.15, -0.8],
      [1.13, 1.6, -0.77],
      [0.6, 2.8, -0.36],
    ],
    0.075,
  );

  yield;
  // Low keyboard with sculpted stepped rows, sockets, separated keys and a dial.
  box(keyboard, ivory, [0, 0.06, 0], [9.6, 0.42, 2.85], 0.18);
  box(keyboard, edgeMetal, [0, -0.15, 0], [9.37, 0.09, 2.64], 0.04);
  box(keyboard, black, [-0.25, 0.29, -0.1], [8.49, 0.08, 2.1], 0.035);
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 14; col++) {
      const x = -4.16 + col * 0.568,
        z = -0.9 + row * 0.52;
      const y = 0.43 + (3 - row) * 0.023;
      if (row === 3 && col >= 4 && col <= 9) continue;
      box(
        keyboard,
        row === 0 && col === 0 ? yellow : ivory,
        [x, y, z],
        [0.51, 0.22, 0.45],
        0.058,
      );
      // Inset legend strokes rather than fictional specifications or decorative serials.
      box(
        keyboard,
        edgeMetal,
        [x - 0.09, y + 0.112, z - 0.05],
        [0.11, 0.006, 0.019],
      );
    }
  box(keyboard, ivory, [-0.47, 0.43, 0.66], [3.34, 0.22, 0.45], 0.065);
  cylinder(keyboard, black, [4.35, 0.4, -0.74], 0.245, 0.24, [0, 0, 0], 24);
  cylinder(keyboard, silver, [4.35, 0.54, -0.74], 0.213, 0.05, [0, 0, 0], 24);
  box(keyboard, yellow, [4.35, 0.57, -0.84], [0.025, 0.014, 0.15]);
  cable(
    keyboard,
    rubber,
    [
      [4.2, 0.05, -1.35],
      [4.9, 0.01, -1.8],
      [5.0, 0.04, -2.35],
      [4.6, 0.08, -2.55],
    ],
    0.059,
  );
  for (const x of [-3.9, 3.9])
    for (const z of [-0.95, 0.95])
      cylinder(keyboard, rubber, [x, -0.28, z], 0.18, 0.12);

  yield;
  // Rat silhouette points toward -z at heading=0, as in the existing MazeScene.
  function ellipsoid(mat: THREE.Material, at: XYZ, scale: XYZ) {
    bake(rat, new THREE.SphereGeometry(1, 12, 8), mat, at, [0, 0, 0], scale);
  }
  ellipsoid(ivory, [0, 0.069, 0], [0.084, 0.066, 0.133]);
  ellipsoid(ivory, [0, 0.085, -0.105], [0.054, 0.047, 0.078]);
  for (const x of [-0.038, 0.038])
    ellipsoid(silver, [x, 0.139, -0.085], [0.03, 0.034, 0.012]);
  for (const x of [-0.041, 0.041])
    ellipsoid(black, [x, 0.099, -0.138], [0.008, 0.008, 0.008]);
  ellipsoid(black, [0, 0.078, -0.18], [0.013, 0.012, 0.012]);
  cable(
    rat,
    silver,
    [
      [0, 0.035, 0.104],
      [0.031, 0.018, 0.182],
      [0.104, 0.012, 0.241],
      [0.118, 0.013, 0.285],
    ],
    0.008,
  );

  yield;
  // A single atlas serves all static wordmarks. A separate screen texture is updated
  // in place; DOM-less construction intentionally yields solid native textures.
  function canvasSurface(
    width: number,
    height: number,
    paint: (ctx: CanvasRenderingContext2D) => void,
  ) {
    let canvas: HTMLCanvasElement | undefined;
    let ctx: CanvasRenderingContext2D | null = null;
    if (typeof document !== "undefined") {
      try {
        canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        ctx = canvas.getContext("2d");
      } catch {
        /* headless fallback */
      }
    }
    const texture =
      canvas && ctx
        ? new THREE.CanvasTexture(canvas)
        : new THREE.DataTexture(
            new Uint8Array([24, 30, 29, 255]),
            1,
            1,
            THREE.RGBAFormat,
          );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    textures.add(texture);
    if (ctx) paint(ctx);
    return { texture, ctx };
  }
  const atlas = canvasSurface(1024, 512, (ctx) => {
    ctx.clearRect(0, 0, 1024, 512);
    ctx.fillStyle = "#e8e6da";
    ctx.textBaseline = "middle";
    ctx.font = 'bold 170px "IBM Plex Sans", sans-serif';
    ctx.fillText("r.", 30, 112);
    ctx.font = '500 56px "IBM Plex Mono", monospace';
    ctx.fillText("project rat race", 25, 288);
    ctx.font = '500 56px "IBM Plex Mono", monospace';
    ctx.fillText("$race", 25, 428);
  });
  const ink = new THREE.MeshBasicMaterial({
    map: atlas.texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  materials.add(ink);
  function decal(
    parent: THREE.Group,
    at: XYZ,
    width: number,
    height: number,
    band: number,
    flat = true,
  ) {
    const g = new THREE.PlaneGeometry(width, height),
      uv = g.getAttribute("uv");
    const ranges = [
      [0, 0.58],
      [0.31, 0.53],
      [0, 0.31],
    ];
    const [bottom, top] = ranges[band];
    for (let i = 0; i < uv.count; i++)
      uv.setXY(i, uv.getX(i), bottom + uv.getY(i) * (top - bottom));
    bake(parent, g, ink, at, flat ? [-Math.PI / 2, 0, 0] : [0, 0, 0]);
  }
  // Wordmarks sit on graphite plaques for consistent contrast in both themes.
  box(lidLeft, graphite, [-3.15, 1.783, 2.25], [3.42, 0.021, 0.66], 0.01);
  decal(lidLeft, [-3.15, 1.797, 2.25], 3.23, 0.61, 1);
  box(board, black, [4.32, 0.322, 3.49], [2.0, 0.022, 0.42], 0.01);
  decal(board, [4.32, 0.338, 3.49], 1.85, 0.36, 2);
  decal(monitor, [-2.15, 1.26, 0.354], 3.2, 0.3, 1, false);

  const screen = canvasSurface(1536, 672, () => {});
  const screenMat = new THREE.MeshBasicMaterial({
    map: screen.texture,
    toneMapped: false,
  });
  materials.add(screenMat);
  bake(
    monitor,
    new THREE.PlaneGeometry(7.49, 3.277),
    screenMat,
    [0, 3.33, 0.414],
  );
  let currentLabel = "",
    currentSteps = NaN,
    currentReference = maze === null;
  function paintStatus() {
    const ctx = screen.ctx;
    if (!ctx) return;
    ctx.fillStyle = "#141b1b";
    ctx.fillRect(0, 0, 1536, 672);
    ctx.strokeStyle = "#58615a";
    ctx.lineWidth = 2;
    ctx.strokeRect(32, 32, 1472, 608);
    ctx.fillStyle = "#e8ce37";
    ctx.font = 'bold 158px "IBM Plex Sans", sans-serif';
    ctx.fillText("r.", 84, 192);
    ctx.fillStyle = "#e8e6da";
    ctx.font = '500 39px "IBM Plex Mono", monospace';
    ctx.fillText("project rat race", 290, 120);
    ctx.fillStyle = "#a8b1a5";
    ctx.fillText("$race", 290, 183);
    ctx.fillStyle = "#e8ce37";
    ctx.fillRect(84, 240, 1368, 3);
    ctx.fillStyle = "#e8e6da";
    ctx.font = '500 49px "IBM Plex Mono", monospace';
    // Exact text, scaled to fit rather than truncated, capitalized or synthesized.
    ctx.fillText(currentLabel, 84, 352, 1360);
    ctx.font = '34px "IBM Plex Mono", monospace';
    ctx.fillStyle = "#a8b1a5";
    ctx.fillText(`steps  ${String(currentSteps)}`, 84, 449, 1360);
    ctx.fillStyle = "#e8ce37";
    ctx.font = '27px "IBM Plex Mono", monospace';
    ctx.fillText(
      currentReference
        ? "fixed reference maze / no live activity"
        : "supplied maze / recorded state",
      84,
      571,
      1360,
    );
    screen.texture.needsUpdate = true;
  }
  function setStatus(label: string, nextSteps: number) {
    if (
      disposed ||
      (label === currentLabel && Object.is(nextSteps, currentSteps))
    )
      return;
    currentLabel = label;
    currentSteps = nextSteps;
    monitor.userData.status = { label, steps: nextSteps };
    paintStatus();
  }

  yield;
  // Static batches finish here; dynamic wall/trail meshes retain their own buffers.
  for (const [parent, byMaterial] of batches)
    for (const [mat, parts] of byMaterial) {
      const geo = mergeGeometries(parts, false);
      parts.forEach((g) => g.dispose());
      if (!geo) throw new Error("PRR hardware geometry merge failed");
      geometries.add(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = !mat.transparent;
      mesh.receiveShadow = true;
      mesh.name = `${parent.name}-surface`;
      parent.add(mesh);
      yield;
    }
  batches.clear();
  const wallGeo = new THREE.BoxGeometry(1, 1, 1);
  geometries.add(wallGeo);
  const trailGeo = new THREE.CircleGeometry(0.019, 8);
  trailGeo.rotateX(-Math.PI / 2);
  geometries.add(trailGeo);
  const rewardGeo = new THREE.CylinderGeometry(0.085, 0.085, 0.035, 20);
  geometries.add(rewardGeo);
  const reward = new THREE.Mesh(rewardGeo, yellow);
  reward.name = "reward";
  processor.add(reward);
  let walls: THREE.InstancedMesh | undefined,
    trail: THREE.InstancedMesh | undefined;
  let lastWalls = "",
    lastTrail = "";
  function instances(
    old: THREE.InstancedMesh | undefined,
    count: number,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    name: string,
  ) {
    if (old && old.instanceMatrix.count >= count) {
      old.count = count;
      return old;
    }
    if (old) {
      processor.remove(old);
      old.dispose();
    }
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    mesh.name = name;
    mesh.count = count;
    mesh.castShadow = name === "maze-walls";
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    processor.add(mesh);
    return mesh;
  }
  function setMaze(next: Maze | null) {
    if (disposed) return;
    const m = next ?? referenceMaze(),
      offset = (m.size * CELL) / 2;
    const wasReference = currentReference;
    currentReference = next === null;
    processor.userData.source = currentReference
      ? "fixed-reference-seed-125"
      : "supplied-maze";
    processor.userData.cellScale = CELL;
    processor.userData.size = m.size;
    const wallKey = JSON.stringify([m.size, m.walls]);
    if (lastWalls !== wallKey) {
      walls = instances(
        walls,
        m.walls.length,
        wallGeo,
        wallMaterial,
        "maze-walls",
      );
      m.walls.forEach(([x1, z1, x2, z2], i) => {
        scratch.position.set(
          ((x1 + x2) * CELL) / 2 - offset,
          0.775,
          ((z1 + z2) * CELL) / 2 - offset,
        );
        scratch.rotation.set(0, -Math.atan2(z2 - z1, x2 - x1), 0);
        scratch.scale.set(
          Math.hypot(x2 - x1, z2 - z1) * CELL + 0.027,
          0.25,
          0.048,
        );
        scratch.updateMatrix();
        walls!.setMatrixAt(i, scratch.matrix);
      });
      walls.instanceMatrix.needsUpdate = true;
      walls.computeBoundingSphere();
      walls.computeBoundingBox();
      lastWalls = wallKey;
    }
    // No rounding or invented half-cell offset. Matches Scenes.tsx's heading convention.
    rat.position.set(m.rat.x * CELL - offset, 0.655, m.rat.z * CELL - offset);
    rat.rotation.y = m.rat.heading;
    reward.position.set(
      m.reward.x * CELL - offset,
      0.676,
      m.reward.z * CELL - offset,
    );
    const trailKey = JSON.stringify([m.size, m.trail]);
    if (lastTrail !== trailKey) {
      trail = instances(
        trail,
        m.trail.length,
        trailGeo,
        yellow,
        "recorded-trail",
      );
      m.trail.forEach(([x, z], i) => {
        scratch.position.set(x * CELL - offset, 0.654, z * CELL - offset);
        scratch.rotation.set(0, 0, 0);
        scratch.scale.set(1, 1, 1);
        scratch.updateMatrix();
        trail!.setMatrixAt(i, scratch.matrix);
      });
      trail.instanceMatrix.needsUpdate = true;
      trail.computeBoundingSphere();
      trail.computeBoundingBox();
      lastTrail = trailKey;
    }
    if (wasReference !== currentReference) paintStatus();
  }
  function setExplode(value: number) {
    if (disposed) return;
    const t = Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 1) : 0;
    // Input is a presentation progress value, not time. Nothing self-advances.
    const lift = THREE.MathUtils.smoothstep(t, 0, 0.65);
    const split = THREE.MathUtils.smoothstep(t, 0.18, 1);
    lid.position.y = lift * 5.6;
    lid.position.z = -split * 1.5;
    lidLeft.position.x = -split * 5.5;
    lidRight.position.x = split * 5.5;
    lidLeft.rotation.z = split * 0.12;
    lidRight.rotation.z = -split * 0.12;
    chassis.position.y = -t * 1.6;
    monitor.position.set(0, t * 2.5, -4.65 - t * 4.4);
    monitor.rotation.x = -t * 0.07;
    keyboard.position.set(0, -0.25 - t * 0.9, 5.65 + t * 4.1);
    keyboard.rotation.x = t * 0.12;
    root.userData.explode = t;
    root.updateMatrixWorld(true);
  }
  root.userData.landmarks = {
    board: [0, 0.3, 0],
    maze: [0, 0.6, 0],
    memory: [-4.3, 1, -0.15],
    heatsink: [4.08, 1, -0.75],
    monitorAssembled: [0, 3.33, -4.236],
    keyboardAssembled: [0, 0.18, 5.65],
    boardBounds: [-6, 0.12, -4, 6, 0.3, 4],
  };
  setMaze(maze);
  setStatus(statusLabel, steps);
  setExplode(0);
  return {
    root,
    mazeCenter,
    setExplode,
    setMaze,
    setStatus,
    dispose() {
      if (disposed) return;
      disposed = true;
      walls?.dispose();
      trail?.dispose();
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      geometries.clear();
      materials.clear();
      textures.clear();
      root.clear();
    },
  };
}

export function buildHardwareModel(
  options: HardwareModelOptions,
): HardwareModel {
  const chunks = buildHardwareChunks(options);
  let step = chunks.next();
  while (!step.done) step = chunks.next();
  return step.value;
}

export async function buildHardwareModelAsync(
  options: HardwareModelOptions,
): Promise<HardwareModel> {
  const chunks = buildHardwareChunks(options);
  let step = chunks.next();
  while (!step.done) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    step = chunks.next();
  }
  return step.value;
}
