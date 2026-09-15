import { memo, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Pause, Play } from "@phosphor-icons/react";
import type { Status } from "../types";
import { buildHardwareModelAsync } from "./HardwareModel";
import { CHAPTERS, progressAtScroll, sampleCameraRoute } from "./cameraRoute";
import "./hardware-stage.css";

gsap.registerPlugin(ScrollTrigger);
type Controls = {
  render: () => void;
  setPaused: (paused: boolean) => void;
  updateStatus: (status: Status) => void;
};
const phaseLabel = (status: Status) =>
  status.startedAt && status.maze
    ? status.phase === "live"
      ? "recorded experiment"
      : "recorded state paused"
    : "reference apparatus";

export default memo(function HardwareStage({
  theme,
  status,
}: {
  theme: "light" | "dark";
  status: Status;
}) {
  const mount = useRef<HTMLDivElement>(null),
    api = useRef<Controls | null>(null),
    latest = useRef(status);
  const [renderState, setRenderState] = useState("loading");
  const [paused, setPaused] = useState(() => {
    try {
      return localStorage.getItem("rr-hardware-motion") === "paused";
    } catch {
      return false;
    }
  });
  const pausedRef = useRef(paused);
  latest.current = status;
  useEffect(() => {
    api.current?.updateStatus(status);
  }, [status]);
  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let disposed = false,
      frame = 0,
      refreshFrame = 0,
      lost = false,
      tween: gsap.core.Tween | null = null;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let width = host.clientWidth,
      height = host.clientHeight,
      small = width < 720,
      tops: number[] = [],
      motionPaused = pausedRef.current;
    const rig = { progress: 0 };
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      setRenderState("fallback");
      host.dataset.renderState = "fallback";
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1 : 1.35));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = theme === "dark" ? 1.12 : 1.03;
    renderer.shadowMap.enabled = !small;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.domElement.setAttribute("aria-hidden", "true");
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(
        small ? 52 : 40,
        width / height,
        0.08,
        180,
      );
    const fogColor = theme === "dark" ? 0x111712 : 0xf4f4ee;
    scene.fog = new THREE.Fog(fogColor, 38, 100);
    const hemisphere = new THREE.HemisphereLight(
      theme === "dark" ? 0xe6eee1 : 0xffffff,
      0x46503c,
      theme === "dark" ? 1.8 : 2.1,
    );
    scene.add(hemisphere);
    const key = new THREE.DirectionalLight(
      0xfff7e8,
      theme === "dark" ? 3.0 : 3.5,
    );
    key.position.set(6, 17, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(small ? 512 : 1024, small ? 512 : 1024);
    Object.assign(key.shadow.camera, {
      left: -20,
      right: 20,
      top: 20,
      bottom: -20,
      near: 1,
      far: 60,
    });
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.03;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdce5ea, 1.8);
    fill.position.set(-10, 8, -10);
    scene.add(fill);
    let environment: THREE.WebGLRenderTarget | null = null;
    if (!small) {
      const pmrem = new THREE.PMREMGenerator(renderer),
        room = new RoomEnvironment();
      environment = pmrem.fromScene(room, 0.04);
      scene.environment = environment.texture;
      scene.environmentIntensity = 0.6;
      room.dispose();
      pmrem.dispose();
    }
    let cleanupModel = () => {};
    void (async () => {
      const data = latest.current,
        model = await buildHardwareModelAsync({
          theme,
          maze: data.startedAt ? data.maze : null,
          statusLabel: phaseLabel(data),
          steps: data.totalSteps,
        });
      if (disposed) {
        model.dispose();
        return;
      }
      scene.add(model.root);
      const floorGeometry = new THREE.PlaneGeometry(110, 110),
        floorMaterial = new THREE.ShadowMaterial({
          color: theme === "dark" ? 0x020503 : 0x647354,
          opacity: theme === "dark" ? 0.26 : 0.2,
        });
      const floor = new THREE.Mesh(floorGeometry, floorMaterial);
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.08;
      floor.receiveShadow = true;
      scene.add(floor);
      const target = new THREE.Vector3();
      let lastExplode = -1;
      const draw = () => {
        frame = 0;
        if (disposed || lost || document.hidden) return;
        const still = motion.matches || motionPaused,
          motionProgress = still ? 0 : rig.progress;
        const pose = sampleCameraRoute(still ? 0 : rig.progress, small, still);
        camera.position.set(...pose.position);
        target.set(...pose.target);
        if (small) {
          target.y += 1.8 * Math.max(0, 1 - motionProgress);
          camera.position.y += 0.8 * Math.max(0, 1 - motionProgress);
        }
        camera.lookAt(target);
        camera.setViewOffset(
          width,
          height,
          small ? 0 : -width * 0.17 * pose.composition,
          small ? -height * 0.025 * Math.max(0, 1 - motionProgress) : 0,
          width,
          height,
        );
        const explode = still ? 0 : pose.explode;
        model.setExplode(explode);
        if (Math.abs(explode - lastExplode) > 0.001) {
          renderer.shadowMap.needsUpdate = true;
          lastExplode = explode;
        }
        renderer.render(scene, camera);
        host.style.opacity = String(still ? 0.38 : pose.opacity);
        host.dataset.sceneProgress = rig.progress.toFixed(4);
        host.dataset.cameraPosition = camera.position
          .toArray()
          .map((n) => n.toFixed(3))
          .join(",");
        host.dataset.explode = explode.toFixed(3);
        host.dataset.cameraChapter =
          CHAPTERS[Math.min(CHAPTERS.length - 1, Math.round(rig.progress))];
        host.dataset.renderState = "ready";
        host.dataset.drawCalls = String(renderer.info.render.calls);
        host.dataset.triangles = String(renderer.info.render.triangles);
      };
      const requestRender = () => {
        if (!frame && !disposed && !lost && !document.hidden)
          frame = requestAnimationFrame(draw);
      };
      const move = (scroll: number, immediate = false) => {
        const progress = progressAtScroll(scroll, tops);
        if (motion.matches || motionPaused) {
          tween?.kill();
          rig.progress = progress;
          requestRender();
          return;
        }
        tween?.kill();
        if (immediate) {
          rig.progress = progress;
          requestRender();
        } else
          tween = gsap.to(rig, {
            progress,
            duration: 0.6,
            ease: "power2.out",
            onUpdate: requestRender,
          });
      };
      const measure = () => {
        const y = window.scrollY;
        tops = CHAPTERS.map((id, index) => {
          const el = document.getElementById(id);
          return el
            ? Math.max(0, el.getBoundingClientRect().top + y - 90)
            : index
              ? (tops[index - 1] ?? 0)
              : 0;
        });
        for (let i = 1; i < tops.length; i++)
          tops[i] = Math.max(tops[i], tops[i - 1] + 1);
      };
      measure();
      const trigger = ScrollTrigger.create({
        trigger: document.getElementById("main"),
        start: "top top",
        end: "bottom bottom",
        onUpdate: (self) => move(self.scroll()),
        onRefresh: (self) => {
          measure();
          move(self.scroll(), true);
        },
      });
      const resize = () => {
        width = host.clientWidth;
        height = host.clientHeight;
        if (!width || !height) return;
        small = width < 720;
        renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1 : 1.35));
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.fov = small ? 52 : 40;
        camera.updateProjectionMatrix();
        measure();
        move(trigger.scroll(), true);
      };
      const observer = new ResizeObserver(() => {
        if (refreshFrame) cancelAnimationFrame(refreshFrame);
        refreshFrame = requestAnimationFrame(() => {
          resize();
          ScrollTrigger.refresh();
        });
      });
      observer.observe(host);
      const main = document.getElementById("main");
      if (main) observer.observe(main);
      const changeMotion = () => {
        tween?.kill();
        move(trigger.scroll(), true);
      };
      const visibility = () => {
        if (document.hidden) {
          cancelAnimationFrame(frame);
          frame = 0;
          tween?.kill();
        } else move(trigger.scroll(), true);
      };
      const contextLost = (event: Event) => {
        event.preventDefault();
        lost = true;
        cancelAnimationFrame(frame);
        frame = 0;
        if (!disposed) {
          host.dataset.renderState = "fallback";
          setRenderState("fallback");
        }
      };
      const contextRestored = () => {
        lost = false;
        renderer.shadowMap.needsUpdate = true;
        setRenderState("ready");
        requestRender();
      };
      renderer.domElement.addEventListener("webglcontextlost", contextLost);
      renderer.domElement.addEventListener(
        "webglcontextrestored",
        contextRestored,
      );
      motion.addEventListener("change", changeMotion);
      document.addEventListener("visibilitychange", visibility);
      api.current = {
        render: requestRender,
        setPaused: (value) => {
          motionPaused = value;
          changeMotion();
        },
        updateStatus: (value) => {
          model.setMaze(value.startedAt ? value.maze : null);
          model.setStatus(phaseLabel(value), value.totalSteps);
          requestRender();
        },
      };
      renderer.shadowMap.needsUpdate = true;
      move(trigger.scroll(), true);
      setRenderState("ready");
      let cancelled = false;
      void document.fonts.ready.then(() => {
        if (!cancelled && !disposed) {
          measure();
          ScrollTrigger.refresh();
        }
      });
      cleanupModel = () => {
        cancelled = true;
        api.current = null;
        cancelAnimationFrame(frame);
        cancelAnimationFrame(refreshFrame);
        tween?.kill();
        trigger.kill();
        observer.disconnect();
        motion.removeEventListener("change", changeMotion);
        document.removeEventListener("visibilitychange", visibility);
        renderer.domElement.removeEventListener(
          "webglcontextlost",
          contextLost,
        );
        renderer.domElement.removeEventListener(
          "webglcontextrestored",
          contextRestored,
        );
        model.dispose();
        floorGeometry.dispose();
        floorMaterial.dispose();
      };
      api.current.updateStatus(latest.current);
    })().catch(() => {
      if (!disposed) {
        host.dataset.renderState = "fallback";
        setRenderState("fallback");
      }
    });
    return () => {
      disposed = true;
      cleanupModel();
      environment?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [theme]);
  const toggle = () => {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    try {
      localStorage.setItem("rr-hardware-motion", next ? "paused" : "on");
    } catch {}
    api.current?.setPaused(next);
  };
  return (
    <>
      <div className="hardware-backdrop" aria-hidden="true">
        <picture>
          <source
            media="(max-width: 720px)"
            srcSet={"/assets/hardware-fallback-mobile-" + theme + ".jpg"}
          />
          <img
            className={
              "hardware-fallback " +
              (renderState === "ready" ? "is-hidden" : "")
            }
            src={"/assets/hardware-fallback-" + theme + ".jpg"}
            alt=""
            fetchPriority="high"
          />
        </picture>
        <div
          className="hardware-stage"
          ref={mount}
          data-render-state={renderState}
        />
      </div>
      <div
        className="hardware-controls"
        role="region"
        aria-label="background scene controls"
      >
        <span>
          {renderState === "fallback"
            ? "3d unavailable. content remains accessible."
            : phaseLabel(status) + ". camera only."}
        </span>
        <button
          onClick={toggle}
          aria-label={
            paused ? "resume background motion" : "pause background motion"
          }
          aria-pressed={paused}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
          <span>{paused ? "resume motion" : "pause motion"}</span>
        </button>
      </div>
    </>
  );
});
