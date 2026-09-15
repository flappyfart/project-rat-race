import { memo, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Pause, Play } from "@phosphor-icons/react";
import type { Status } from "../types";
import { buildHardwareModelAsync } from "./HardwareModel";
import {
  CHAPTERS,
  progressAtScroll,
  sampleCameraRouteInto,
} from "./cameraRoute";
import type { MutableCameraPose } from "./cameraRoute";
import { followScroll, shouldResizeDrawingBuffer } from "./mobileMotion";
import "./hardware-stage.css";

gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });
type Controls = {
  setPaused: (paused: boolean) => void;
  updateStatus: (status: Status) => void;
};
const phaseLabel = (s: Status) =>
  s.startedAt && s.maze
    ? s.phase === "live"
      ? "recorded experiment"
      : "recorded state paused"
    : "reference apparatus";
const presentationKey = (s: Status) =>
  `${phaseLabel(s)}:${s.totalSteps}:${s.startedAt ? (s.stateHash ?? JSON.stringify(s.maze)) : "reference"}`;
const isMobile = () =>
  matchMedia("(max-width: 1023px), (pointer: coarse)").matches;

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
      refreshTimer = 0,
      lost = false,
      cleanupModel = () => {};
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let width = host.clientWidth,
      height = host.clientHeight,
      small = isMobile(),
      motionPaused = pausedRef.current;
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
    scene.fog = new THREE.Fog(theme === "dark" ? 0x111712 : 0xf4f4ee, 38, 100);
    scene.add(
      new THREE.HemisphereLight(
        theme === "dark" ? 0xe6eee1 : 0xffffff,
        0x46503c,
        theme === "dark" ? 1.8 : 2.1,
      ),
    );
    const key = new THREE.DirectionalLight(
      0xfff7e8,
      theme === "dark" ? 3 : 3.5,
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
    void (async () => {
      const data = latest.current,
        model = await buildHardwareModelAsync({
          theme,
          maze: data.startedAt ? data.maze : null,
          statusLabel: phaseLabel(data),
          steps: data.totalSteps,
          detail: small ? "compact" : "full",
        });
      if (disposed) {
        model.dispose();
        return;
      }
      scene.add(model.root);
      host.dataset.geometryDetail = small ? "compact" : "full";
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
      const target = new THREE.Vector3(),
        pose: MutableCameraPose = {
          position: [0, 0, 0],
          target: [0, 0, 0],
          explode: 0,
          opacity: 1,
          composition: 0,
        };
      let progress = 0,
        desired = 0,
        lastFrameAt = 0,
        lastInputAt = 0,
        lastExplode = -1,
        lastOpacity = -1,
        lastOffsetX = NaN,
        lastOffsetY = NaN,
        renderCount = 0;
      let tops: number[] = [],
        layoutDirty = false,
        mainHeight = 0,
        refreshCount = 0,
        lastState = presentationKey(data);
      const main = document.getElementById("main");
      const draw = (now: number) => {
        frame = 0;
        if (disposed || lost || document.hidden) {
          lastFrameAt = 0;
          return;
        }
        const still = motion.matches || motionPaused,
          dt = lastFrameAt ? now - lastFrameAt : 1000 / 60;
        lastFrameAt = now;
        progress = still ? desired : followScroll(progress, desired, dt, small);
        if (Math.abs(progress - desired) < 0.0002) progress = desired;
        const p = still ? 0 : progress,
          landscape = small && width > height * 1.2;
        sampleCameraRouteInto(p, small && !landscape, still, pose);
        camera.position.set(...pose.position);
        target.set(...pose.target);
        if (small && !landscape) {
          target.y += 1.8 * Math.max(0, 1 - p);
          camera.position.y += 0.8 * Math.max(0, 1 - p);
        }
        camera.lookAt(target);
        const ox = small && !landscape ? 0 : -width * 0.17 * pose.composition,
          oy = small && !landscape ? -height * 0.025 * Math.max(0, 1 - p) : 0;
        if (
          !Number.isFinite(lastOffsetX) ||
          Math.abs(ox - lastOffsetX) > 0.1 ||
          Math.abs(oy - lastOffsetY) > 0.1
        ) {
          camera.setViewOffset(width, height, ox, oy, width, height);
          lastOffsetX = ox;
          lastOffsetY = oy;
        }
        const explode = still ? 0 : pose.explode;
        if (Math.abs(explode - lastExplode) > 0.00005) {
          model.setExplode(explode);
          renderer.shadowMap.needsUpdate = !small;
          lastExplode = explode;
        }
        renderer.render(scene, camera);
        renderCount++;
        const opacity = still ? 0.38 : pose.opacity;
        if (Math.abs(opacity - lastOpacity) > 0.002) {
          host.style.opacity = String(opacity);
          lastOpacity = opacity;
        }
        host.dataset.sceneProgress = progress.toFixed(4);
        host.dataset.targetProgress = desired.toFixed(4);
        host.dataset.cameraPosition = `${camera.position.x.toFixed(3)},${camera.position.y.toFixed(3)},${camera.position.z.toFixed(3)}`;
        host.dataset.explode = explode.toFixed(3);
        host.dataset.cameraChapter =
          CHAPTERS[Math.min(CHAPTERS.length - 1, Math.round(progress))];
        host.dataset.renderState = "ready";
        host.dataset.drawCalls = String(renderer.info.render.calls);
        host.dataset.triangles = String(renderer.info.render.triangles);
        host.dataset.renderCount = String(renderCount);
        if (!still && progress !== desired) frame = requestAnimationFrame(draw);
        else lastFrameAt = 0;
      };
      const requestRender = () => {
        if (!frame && !disposed && !lost && !document.hidden)
          frame = requestAnimationFrame(draw);
      };
      const move = (scroll: number, immediate = false) => {
        const next = progressAtScroll(scroll, tops),
          changed = Math.abs(next - desired) > 0.00001;
        desired = next;
        if (immediate) progress = next;
        if (immediate || changed) {
          lastInputAt = performance.now();
          if (!(motion.matches || motionPaused) || immediate) requestRender();
        }
      };
      const measure = () => {
        const y = window.scrollY,
          inset =
            parseFloat(
              getComputedStyle(document.documentElement).scrollPaddingTop,
            ) || 0;
        tops = CHAPTERS.map((id, index) => {
          const el = document.getElementById(id);
          return el
            ? Math.max(0, el.getBoundingClientRect().top + y - inset)
            : index
              ? (tops[index - 1] ?? 0)
              : 0;
        });
        for (let i = 1; i < tops.length; i++)
          tops[i] = Math.max(tops[i], tops[i - 1] + 1);
        mainHeight = main?.getBoundingClientRect().height ?? 0;
      };
      measure();
      const trigger = ScrollTrigger.create({
        trigger: main,
        start: "top top",
        end: "bottom bottom",
        onUpdate: (self) => move(self.scroll()),
        onRefresh: (self) => {
          measure();
          move(self.scroll());
        },
      });
      const applyResize = () => {
        const next = { width: host.clientWidth, height: host.clientHeight };
        if (!shouldResizeDrawingBuffer({ width, height }, next, small))
          return false;
        width = next.width;
        height = next.height;
        small = isMobile();
        renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1 : 1.35));
        renderer.setSize(width, height, false);
        renderer.shadowMap.enabled = !small;
        camera.aspect = width / height;
        camera.fov = small ? 52 : 40;
        camera.updateProjectionMatrix();
        lastOffsetX = NaN;
        renderer.shadowMap.needsUpdate = !small;
        return true;
      };
      const refresh = () => {
        refreshTimer = 0;
        if (disposed) return;
        const next = { width: host.clientWidth, height: host.clientHeight };
        const hardResize = shouldResizeDrawingBuffer(
          { width, height },
          next,
          small,
        );
        if (
          !hardResize &&
          (ScrollTrigger.isScrolling() || performance.now() - lastInputAt < 180)
        ) {
          refreshTimer = window.setTimeout(refresh, 180);
          return;
        }
        const resized = applyResize();
        if (resized || layoutDirty) {
          layoutDirty = false;
          measure();
          refreshCount++;
          host.dataset.layoutRefreshes = String(refreshCount);
          trigger.refresh();
          move(trigger.scroll(), resized);
        }
      };
      const queueRefresh = () => {
        if (!refreshTimer) refreshTimer = window.setTimeout(refresh, 120);
      };
      const observer = new ResizeObserver((entries) => {
        const next = { width: host.clientWidth, height: host.clientHeight };
        const toolbarOnly =
          small &&
          Math.abs(next.width - width) <= 1 &&
          Math.abs(next.height - height) > 1 &&
          !shouldResizeDrawingBuffer({ width, height }, next, true);
        if (toolbarOnly) {
          mainHeight = main?.getBoundingClientRect().height ?? mainHeight;
          return;
        }
        for (const entry of entries)
          if (
            entry.target === main &&
            Math.abs(entry.contentRect.height - mainHeight) > 2
          )
            layoutDirty = true;
        if (
          layoutDirty ||
          shouldResizeDrawingBuffer({ width, height }, next, small)
        )
          queueRefresh();
      });
      observer.observe(host);
      if (main) observer.observe(main);
      const scrollEnd = () => {
        if (layoutDirty) queueRefresh();
      };
      ScrollTrigger.addEventListener("scrollEnd", scrollEnd);
      const changeMotion = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        lastFrameAt = 0;
        progress = desired = progressAtScroll(trigger.scroll(), tops);
        requestRender();
      };
      const visibility = () => {
        if (document.hidden) {
          cancelAnimationFrame(frame);
          frame = 0;
          lastFrameAt = 0;
        } else {
          measure();
          move(trigger.scroll(), true);
        }
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
        renderer.shadowMap.needsUpdate = !small;
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
        setPaused: (value) => {
          motionPaused = value;
          changeMotion();
        },
        updateStatus: (value) => {
          const nextKey = presentationKey(value);
          if (nextKey === lastState) return;
          lastState = nextKey;
          model.setMaze(value.startedAt ? value.maze : null);
          model.setStatus(phaseLabel(value), value.totalSteps);
          requestRender();
        },
      };
      renderer.shadowMap.needsUpdate = !small;
      move(trigger.scroll(), true);
      setRenderState("ready");
      void document.fonts.ready.then(() => {
        if (!disposed) {
          layoutDirty = true;
          queueRefresh();
        }
      });
      cleanupModel = () => {
        api.current = null;
        cancelAnimationFrame(frame);
        clearTimeout(refreshTimer);
        trigger.kill();
        observer.disconnect();
        ScrollTrigger.removeEventListener("scrollEnd", scrollEnd);
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
            onLoad={() =>
              document.getElementById("hardware-first-paint")?.remove()
            }
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
