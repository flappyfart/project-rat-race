export const CHAPTERS = [
  "top",
  "machine",
  "maze",
  "anatomy",
  "connection",
  "beyond",
  "manifesto",
  "protocol",
] as const;
export type Chapter = (typeof CHAPTERS)[number];
export type Vec3 = readonly [number, number, number];
export type CameraPose = {
  position: Vec3;
  target: Vec3;
  explode: number;
  opacity: number;
  composition: number;
};
export const CAMERA_ROUTE: readonly CameraPose[] = [
  {
    position: [16, 13, 21],
    target: [0, 1, 0],
    explode: 0,
    opacity: 1,
    composition: 1,
  },
  {
    position: [11, 15, 15],
    target: [0, 1.4, 0],
    explode: 1,
    opacity: 1,
    composition: 0.35,
  },
  {
    position: [4.0, 4.0, 5.8],
    target: [-0.5, 0.8, 0],
    explode: 1,
    opacity: 1,
    composition: 0.85,
  },
  {
    position: [-9, 7, 8],
    target: [-3.7, 1, 0],
    explode: 0.85,
    opacity: 0.9,
    composition: 0.15,
  },
  {
    position: [12, 6.8, 9],
    target: [4.5, 0.8, 0],
    explode: 0.55,
    opacity: 0.85,
    composition: 0.15,
  },
  {
    position: [17, 17, 23],
    target: [0, 1, 0],
    explode: 0,
    opacity: 0.48,
    composition: 0.5,
  },
  {
    position: [19, 19, 26],
    target: [0, 1, 0],
    explode: 0,
    opacity: 0.22,
    composition: 0.5,
  },
  {
    position: [19, 19, 26],
    target: [0, 1, 0],
    explode: 0,
    opacity: 0.18,
    composition: 0.5,
  },
];
export function clampProgress(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(CHAPTERS.length - 1, value))
    : 0;
}
/** Anchor tops in document pixels; no synthetic equal-height scroll sections. */
export function progressAtScroll(
  scroll: number,
  tops: readonly number[],
): number {
  if (!Number.isFinite(scroll) || tops.length < 2) return 0;
  for (let i = 0; i < Math.min(tops.length - 1, CHAPTERS.length - 1); i++) {
    if (scroll < tops[i + 1])
      return clampProgress(
        i + Math.max(0, scroll - tops[i]) / Math.max(1, tops[i + 1] - tops[i]),
      );
  }
  return clampProgress(tops.length - 1);
}
export function sampleCameraRoute(
  progress: number,
  mobile = false,
  reducedMotion = false,
): CameraPose {
  const p = reducedMotion ? 0 : clampProgress(progress);
  const i = Math.floor(p),
    a = CAMERA_ROUTE[i],
    b = CAMERA_ROUTE[Math.min(i + 1, CAMERA_ROUTE.length - 1)];
  const x = p - i,
    t = x * x * (3 - 2 * x);
  const mix = (a: number, b: number) => a + (b - a) * t;
  const target = a.target.map((v, j) => mix(v, b.target[j])) as unknown as Vec3;
  const position = a.position.map((v, j) => {
    const value = mix(v, b.position[j]);
    return mobile
      ? target[j] + (value - target[j]) * (1.5 - 0.18 * Math.min(p, 1))
      : value;
  }) as unknown as Vec3;
  return {
    position,
    target,
    explode: mix(a.explode, b.explode),
    opacity: mix(a.opacity, b.opacity),
    composition: mix(a.composition, b.composition),
  };
}

export type MutableCameraPose = {
  position: [number, number, number];
  target: [number, number, number];
  explode: number;
  opacity: number;
  composition: number;
};
export function sampleCameraRouteInto(
  progress: number,
  mobile: boolean,
  reducedMotion: boolean,
  out: MutableCameraPose,
) {
  const p = reducedMotion ? 0 : clampProgress(progress),
    i = Math.floor(p),
    a = CAMERA_ROUTE[i],
    b = CAMERA_ROUTE[Math.min(i + 1, CAMERA_ROUTE.length - 1)],
    x = p - i,
    t = x * x * (3 - 2 * x),
    scale = mobile ? 1.5 - 0.18 * Math.min(p, 1) : 1;
  for (let j = 0; j < 3; j++) {
    const target = a.target[j] + (b.target[j] - a.target[j]) * t;
    out.target[j] = target;
    const position = a.position[j] + (b.position[j] - a.position[j]) * t;
    out.position[j] = mobile ? target + (position - target) * scale : position;
  }
  out.explode = a.explode + (b.explode - a.explode) * t;
  out.opacity = a.opacity + (b.opacity - a.opacity) * t;
  out.composition = a.composition + (b.composition - a.composition) * t;
  return out;
}
