import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  ArrowCounterClockwise,
  ArrowsOut,
  Cube,
  GridFour,
  Minus,
  Plus,
} from "@phosphor-icons/react";
import type { Maze } from "./types";

type Theme = "light" | "dark";
type Handle = {
  top: () => void;
  orbit: () => void;
  reset: () => void;
  zoom: (v: number) => void;
};
const noop = () => {};
function setup(host: HTMLDivElement, theme: Theme, span = 12) {
  const scene = new THREE.Scene();
  const bg = theme === "dark" ? 0x20231f : 0xeceee7;
  scene.background = new THREE.Color(bg);
  const camera = new THREE.OrthographicCamera(
    -span / 2,
    span / 2,
    span / 2,
    -span / 2,
    0.1,
    150,
  );
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, window.innerWidth < 600 ? 1.25 : 1.6),
  );
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.domElement.setAttribute(
    "aria-label",
    "interactive three dimensional scientific apparatus",
  );
  host.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.enableDamping = false;
  controls.minPolarAngle = 0.05;
  controls.maxPolarAngle = Math.PI / 2.07;
  const render = () => renderer.render(scene, camera);
  controls.addEventListener("change", render);
  const resize = () => {
    const w = host.clientWidth,
      h = host.clientHeight;
    if (!w || !h) return;
    const a = w / h;
    camera.left = (-span * a) / 2;
    camera.right = (span * a) / 2;
    camera.top = span / 2;
    camera.bottom = -span / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  scene.add(
    new THREE.HemisphereLight(
      theme === "dark" ? 0xf0f1df : 0xffffff,
      theme === "dark" ? 0x242c20 : 0xa5a798,
      2.3,
    ),
  );
  const key = new THREE.DirectionalLight(0xffffff, 4);
  key.position.set(-5, 14, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -15;
  key.shadow.camera.right = 15;
  key.shadow.camera.top = 15;
  key.shadow.camera.bottom = -15;
  key.shadow.bias = -0.001;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const dispose = () => {
    observer.disconnect();
    controls.dispose();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        for (const t of Array.isArray(m.material) ? m.material : [m.material])
          t.dispose();
      }
    });
    renderer.dispose();
    renderer.domElement.remove();
  };
  return { scene, camera, controls, renderer, render, resize, dispose };
}

// Reference apparatus only. No policy, learning, clock, or history is advanced here.
function referenceWalls() {
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
  const w: number[][] = [
    [0, 0, 7, 0],
    [7, 0, 7, 7],
    [7, 7, 0, 7],
    [0, 7, 0, 0],
  ];
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      if (x < 6 && !open.has(edge(z * size + x, z * size + x + 1)))
        w.push([x + 1, z, x + 1, z + 1]);
      if (z < 6 && !open.has(edge(z * size + x, (z + 1) * size + x)))
        w.push([x, z + 1, x + 1, z + 1]);
    }
  return w;
}
function ratModel() {
  const rat = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: 0x73776b,
    roughness: 0.92,
  });
  const earMat = new THREE.MeshStandardMaterial({
    color: 0xadb09b,
    roughness: 0.8,
  });
  function ellipsoid(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    mat = skin,
  ) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    rat.add(m);
  }
  ellipsoid(0, 0.15, 0, 0.19, 0.15, 0.3);
  ellipsoid(0, 0.18, -0.25, 0.12, 0.105, 0.18);
  ellipsoid(-0.085, 0.295, -0.2, 0.067, 0.075, 0.025, earMat);
  ellipsoid(0.085, 0.295, -0.2, 0.067, 0.075, 0.025, earMat);
  const eye = new THREE.MeshStandardMaterial({ color: 0x171a15 });
  ellipsoid(-0.092, 0.21, -0.31, 0.016, 0.016, 0.016, eye);
  ellipsoid(0.092, 0.21, -0.31, 0.016, 0.016, 0.016, eye);
  const tail = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.08, 0.24),
    new THREE.Vector3(0.07, 0.04, 0.45),
    new THREE.Vector3(0.27, 0.03, 0.6),
    new THREE.Vector3(0.31, 0.03, 0.78),
  ]);
  const tm = new THREE.Mesh(
    new THREE.TubeGeometry(tail, 20, 0.016, 6, false),
    earMat,
  );
  rat.add(tm);
  return rat;
}
export function MazeScene({
  theme,
  maze,
}: {
  theme: Theme;
  maze: Maze | null;
}) {
  const host = useRef<HTMLDivElement>(null),
    handle = useRef<Handle>({
      top: noop,
      orbit: noop,
      reset: noop,
      zoom: noop,
    }),
    update = useRef<(m: Maze | null) => void>(() => {}),
    latest = useRef(maze);
  latest.current = maze;
  const [error, setError] = useState(false),
    [view, setView] = useState("orbit");
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (!host.current) return;
    setError(false);
    let cleanup = noop;
    try {
      const { scene, camera, controls, render, resize, dispose } = setup(
        host.current,
        theme,
        10.8,
      );
      cleanup = dispose;
      controls.target.set(3.5, 0, 3.5);
      const orbit = () => {
        camera.position.set(13.5, 12.3, 15);
        camera.zoom = 1;
        camera.updateProjectionMatrix();
        controls.update();
        render();
      };
      handle.current = {
        orbit,
        top: () => {
          camera.position.set(3.5, 20, 3.501);
          camera.zoom = 0.87;
          camera.updateProjectionMatrix();
          controls.update();
          render();
        },
        reset: orbit,
        zoom: (v) => {
          camera.zoom = Math.max(0.65, Math.min(1.6, camera.zoom * v));
          camera.updateProjectionMatrix();
          render();
        },
      };
      const baseMat = new THREE.MeshStandardMaterial({
          color: theme === "dark" ? 0x52594a : 0xe7e9df,
          roughness: 0.88,
        }),
        wallMat = new THREE.MeshStandardMaterial({
          color: theme === "dark" ? 0xc1c6b4 : 0xf8f9f0,
          roughness: 0.72,
        });
      const foundation = new THREE.Mesh(
        new THREE.BoxGeometry(7.6, 0.25, 7.6),
        baseMat,
      );
      foundation.position.set(3.5, -0.16, 3.5);
      foundation.receiveShadow = true;
      foundation.castShadow = true;
      scene.add(foundation);
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshStandardMaterial({
          color: theme === "dark" ? 0x20231f : 0xeceee7,
          roughness: 1,
        }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.31;
      ground.receiveShadow = true;
      scene.add(ground);
      const walls = new THREE.Group(),
        trail = new THREE.Group(),
        rat = ratModel(),
        reward = new THREE.Mesh(
          new THREE.BoxGeometry(0.3, 0.24, 0.3),
          new THREE.MeshStandardMaterial({
            color: 0xe8ce37,
            roughness: 0.55,
            metalness: 0.05,
          }),
        ),
        dotMat = new THREE.MeshBasicMaterial({ color: 0xe8ce37 });
      reward.castShadow = true;
      scene.add(walls, trail, rat, reward);
      let wallKey = "",
        trailKey = "";
      const clear = (g: THREE.Group) => {
        for (const o of [...g.children]) {
          g.remove(o);
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        }
      };
      update.current = (m) => {
        const next = m?.walls ?? referenceWalls(),
          key = JSON.stringify(next);
        if (key !== wallKey) {
          clear(walls);
          for (const [x1, z1, x2, z2] of next) {
            const wall = new THREE.Mesh(
              new THREE.BoxGeometry(
                Math.hypot(x2 - x1, z2 - z1) + 0.1,
                0.52,
                0.105,
              ),
              wallMat,
            );
            wall.position.set((x1 + x2) / 2, 0.22, (z1 + z2) / 2);
            wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
            wall.castShadow = true;
            wall.receiveShadow = true;
            walls.add(wall);
          }
          wallKey = key;
          host.current?.setAttribute("data-wall-count", String(next.length));
        }
        rat.position.set(m?.rat.x ?? 0.5, 0, m?.rat.z ?? 0.5);
        rat.rotation.y = m?.rat.heading ?? Math.PI;
        reward.position.set(m?.reward.x ?? 6.5, 0.13, m?.reward.z ?? 6.5);
        const points = m?.trail ?? [],
          tkey = JSON.stringify(points);
        if (tkey !== trailKey) {
          clear(trail);
          for (const [x, z] of points) {
            const dot = new THREE.Mesh(
              new THREE.CircleGeometry(0.038, 10),
              dotMat,
            );
            dot.rotation.x = -Math.PI / 2;
            dot.position.set(x, 0.005, z);
            trail.add(dot);
          }
          trailKey = tkey;
        }
        render();
      };
      if (viewRef.current === "top") handle.current.top();
      else orbit();
      update.current(latest.current);
      resize();
    } catch {
      cleanup();
      setError(true);
    }
    return () => {
      update.current = () => {};
      cleanup();
    };
  }, [theme]);
  useEffect(() => {
    update.current(maze);
  }, [maze]);
  return (
    <div className="scene-wrap">
      <div
        className="scene-host maze-host"
        ref={host}
        role="img"
        aria-label={
          maze
            ? "recorded experiment maze. camera controls do not direct the rat."
            : "sealed reference maze apparatus. camera controls do not start the experiment."
        }
      />
      {error && (
        <div className="scene-error">
          3d view unavailable on this device.
          <br />
          the backend state is unaffected.
        </div>
      )}
      <div className="scene-controls">
        <div className="segmented">
          <button
            aria-pressed={view === "orbit"}
            onClick={() => {
              handle.current.orbit();
              setView("orbit");
            }}
          >
            <Cube size={16} /> orbit
          </button>
          <button
            aria-pressed={view === "top"}
            onClick={() => {
              handle.current.top();
              setView("top");
            }}
          >
            <GridFour size={16} /> overhead
          </button>
        </div>
        <button
          className="square-control"
          aria-label="reset maze camera"
          onClick={() => {
            handle.current.reset();
            setView("orbit");
          }}
        >
          <ArrowCounterClockwise size={16} />
        </button>
      </div>
      <span className="camera-note">drag to inspect apparatus</span>
    </div>
  );
}

type MeshData = {
  vertices: number[];
  normals: number[];
  indices: number[];
  regions?: MeshData[];
};
function geometry(data: MeshData) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(data.vertices, 3),
  );
  g.setAttribute("normal", new THREE.Float32BufferAttribute(data.normals, 3));
  g.setIndex(data.indices);
  g.computeBoundingBox();
  return g;
}
export function AtlasScene({ theme }: { theme: Theme }) {
  const host = useRef<HTMLDivElement>(null),
    actions = useRef({
      reset: noop,
      zoom: (_n: number) => {},
      isolate: (_v: boolean) => {},
    });
  const [state, setState] = useState("loading"),
    [isolated, setIsolated] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const abort = new AbortController();
    let cleanup = noop;
    (async () => {
      try {
        const r = await fetch("/data/rat-atlas.mesh.json", {
          signal: abort.signal,
        });
        if (!r.ok) throw new Error();
        const data = (await r.json()) as MeshData;
        if (abort.signal.aborted) return;
        const { scene, camera, controls, render, resize, dispose } = setup(
          host.current!,
          theme,
          30,
        );
        cleanup = dispose;
        const group = new THREE.Group();
        const g = geometry(data);
        const c = g.boundingBox!.getCenter(new THREE.Vector3());
        group.position.copy(c).multiplyScalar(-1);
        const mat = new THREE.MeshStandardMaterial({
          color: theme === "dark" ? 0xc2c9b8 : 0xa6b19d,
          metalness: 0.05,
          roughness: 0.67,
          transparent: true,
          opacity: 0.48,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const brain = new THREE.Mesh(g, mat);
        group.add(brain);
        for (const reg of data.regions ?? []) {
          const m = new THREE.Mesh(
            geometry(reg),
            new THREE.MeshStandardMaterial({
              color: 0xe8ce37,
              roughness: 0.5,
              metalness: 0.07,
            }),
          );
          group.add(m);
        }
        scene.add(group);
        controls.target.set(0, 0, 0);
        const reset = () => {
          camera.up.set(0, 0, 1);
          camera.position.set(26, -36, 24);
          camera.zoom = 1.1;
          camera.updateProjectionMatrix();
          controls.update();
          render();
        };
        // Dataset RAS millimeters. z is superior. One shared centering transform for every part.
        controls.maxPolarAngle = Math.PI;
        actions.current = {
          reset,
          zoom: (v) => {
            camera.zoom = Math.max(0.65, Math.min(1.8, camera.zoom * v));
            camera.updateProjectionMatrix();
            render();
          },
          isolate: (v) => {
            brain.visible = !v;
            render();
          },
        };
        reset();
        resize();
        setState("ready");
      } catch {
        if (!abort.signal.aborted) setState("error");
      }
    })();
    return () => {
      abort.abort();
      cleanup();
    };
  }, [theme]);
  return (
    <div className="atlas-apparatus">
      <div
        ref={host}
        className="scene-host atlas-host"
        role="img"
        aria-label="genuine waxholm rat anatomical atlas surface, hippocampal structures shown in yellow. no simulated activity."
      />
      {state !== "ready" && (
        <div className="atlas-fallback">
          <img
            src="/assets/atlas-surface.png"
            alt="static surface rendered from the actual waxholm rat atlas"
          />
          <span>
            {state === "loading"
              ? "loading anatomical geometry"
              : "static anatomical view. interactive view unavailable."}
          </span>
        </div>
      )}
      <div className="atlas-legend">
        <span className="legend-swatch" /> hippocampal formation{" "}
        <span className="atlas-metric">anatomy only</span>
      </div>
      <div className="atlas-controls">
        <button
          className="text-control"
          aria-pressed={isolated}
          onClick={() => {
            actions.current.isolate(!isolated);
            setIsolated(!isolated);
          }}
        >
          <ArrowsOut size={16} />
          {isolated ? "show whole atlas" : "isolate hippocampus"}
        </button>
        <div>
          <button
            aria-label="zoom anatomy out"
            onClick={() => actions.current.zoom(0.9)}
          >
            <Minus size={16} />
          </button>
          <button
            aria-label="zoom anatomy in"
            onClick={() => actions.current.zoom(1.1)}
          >
            <Plus size={16} />
          </button>
          <button
            aria-label="reset anatomy camera"
            onClick={() => actions.current.reset()}
          >
            <ArrowCounterClockwise size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
