import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { z } from "zod";

// --- design_extract_motion: runtime and bundle evidence for a live site's motion ---

export const MOTION_SCRIPT_LIMIT = 40;
export const MOTION_SCRIPT_MAX_BYTES = 8 * 1024 * 1024;
export const MOTION_TOTAL_SCRIPT_BYTES = 40 * 1024 * 1024;
export const MOTION_SOURCE_MAP_MAX_BYTES = 20 * 1024 * 1024;
export const MOTION_SOURCE_FILE_LIMIT = 2000;
export const MOTION_HOTSPOT_LIMIT = 200;
export const MOTION_SAMPLE_NODE_LIMIT = 4000;
export const MOTION_PAGE_TIMEOUT_MS = 45_000;

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
} as const;

export type EvidenceClass = "runtime-exact" | "runtime-observed" | "original-source" | "bundle-signature" | "code-reading-required";

export interface TracePoint {
  step: string;
  scrollY: number;
  values: Record<string, string>;
}

export interface ElementTrace {
  selector: string;
  label: string;
  changedProps: string[];
  distinctStates: number;
  points: TracePoint[];
}

export interface AnimationRecord {
  kind: string;
  name: string;
  target: string;
  timeline: string;
  timing: Record<string, string | number>;
  keyframes: Array<Record<string, string | number | null>>;
}

export interface CssMotionRules {
  keyframes: Array<{ name: string; cssText: string }>;
  scrollDriven: string[];
  transitionTimings: Array<{ value: string; uses: number }>;
  inaccessibleSheets: string[];
}

export interface UniformRecord {
  calls: number;
  first: number[];
  last: number[];
}

export interface WebglCapture {
  contexts: string[];
  shaders: Array<{ type: string; source: string }>;
  droppedShaders: number;
  uniforms: Record<string, UniformRecord>;
}

export interface PageCapture {
  traces: ElementTrace[];
  animations: AnimationRecord[];
  css: CssMotionRules;
  webgl: WebglCapture;
  globals: Record<string, string>;
  scrollHeight: number;
}

export interface ScriptBody {
  url: string;
  body: string;
  sourceMapHeader?: string;
}

export interface Hotspot {
  pattern: string;
  file: string;
  line: number;
  snippet: string;
}

export interface LibrarySignature {
  library: string;
  version?: string;
  files: string[];
}

export interface SourceMapResult {
  script: string;
  mapUrl: string;
  status: "recovered" | "no-sources-content" | "not-found" | "blocked" | "invalid" | "too-large";
  sources: number;
  savedSources: number;
  skippedLibrarySources: number;
}

export interface MotionReport {
  status: "ready" | "partial";
  reasonCode: string;
  url: string;
  finalUrl: string;
  capturedAt: string;
  viewport: keyof typeof VIEWPORTS;
  reducedMotion: boolean;
  artifactDir: string;
  evidence: Record<string, EvidenceClass>;
  page: PageCapture;
  signatures: LibrarySignature[];
  hotspots: Hotspot[];
  sourceMaps: SourceMapResult[];
  scripts: Array<{ url: string; bytes: number; savedAs: string }>;
  skippedScripts: number;
  uncertainties: string[];
}

export const EVIDENCE_CLASSES: Record<string, EvidenceClass> = {
  "page.animations": "runtime-exact",
  "page.css": "runtime-exact",
  "page.webgl": "runtime-exact",
  "page.globals": "runtime-exact",
  "page.traces": "runtime-observed",
  sourceMaps: "original-source",
  signatures: "bundle-signature",
  hotspots: "code-reading-required",
};

export const LIBRARY_SIGNATURES: Array<{ library: string; test: RegExp; version?: RegExp }> = [
  { library: "gsap", test: /GreenSock|\bgsap\b/, version: /GSAP\s+(\d+\.\d+\.\d+)/ },
  { library: "gsap-scrolltrigger", test: /ScrollTrigger/ },
  { library: "gsap-splittext", test: /SplitText/ },
  { library: "split-type", test: /split-type|SplitType/ },
  { library: "lenis", test: /\blenis\b/i },
  { library: "locomotive-scroll", test: /locomotive-scroll|data-scroll-container/ },
  { library: "motion", test: /framer-motion|framerAppear|MotionGlobalConfig/ },
  { library: "three", test: /__THREE__|THREE\.|three\.module/, version: /REVISION\s*=\s*["'](\d{2,3}(?:dev)?)["']/ },
  { library: "ogl", test: /\bOGL\b/ },
  { library: "pixi", test: /PIXI\.|pixi\.js/ },
  { library: "barba", test: /@barba|barba\.js|\bbarba\b/ },
  { library: "taxi", test: /@unseenco\/taxi/ },
  { library: "highway", test: /@dogstudio\/highway/ },
  { library: "swiper", test: /\bswiper\b/i },
  { library: "lottie", test: /bodymovin|lottie-web|dotlottie/ },
  { library: "rive", test: /@rive-app|rive\.wasm/ },
  { library: "theatre", test: /@theatre\/core/ },
  { library: "spline", test: /@splinetool/ },
  { library: "matter-js", test: /matter-js|Matter\.Engine/ },
  { library: "curtains", test: /curtainsjs|new\s+Curtains\(/ },
];

export const HOTSPOT_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "gsap-call", regex: /\b(?:gsap|TweenMax|TweenLite)\.(?:to|from|fromTo|timeline|set|quickTo|quickSetter)\(/g },
  { name: "scrolltrigger", regex: /ScrollTrigger\.create\(|scrollTrigger\s*:\s*\{/g },
  { name: "ease-literal", regex: /\bease\s*:\s*["'`][\w.()-]+["'`]/g },
  { name: "cubic-bezier", regex: /cubic-bezier\([^)]{5,60}\)/g },
  { name: "spring-option", regex: /\b(?:stiffness|damping|mass|bounce|restDelta|visualDuration)\s*:\s*[\d.]+/g },
  { name: "motion-hook", regex: /\b(?:useScroll|useTransform|useSpring|useVelocity|useMotionValueEvent|useAnimate|useInView)\(/g },
  { name: "smooth-scroll-option", regex: /\b(?:lerp|smoothWheel|wheelMultiplier|touchMultiplier|syncTouch)\s*:/g },
  { name: "waapi-animate", regex: /\.animate\(\s*[[{]/g },
  { name: "scroll-timeline", regex: /animation-timeline|view-timeline|ViewTimeline|ScrollTimeline|animation-range/g },
  { name: "shader-uniform", regex: /\bu[A-Z]\w*\s*:\s*\{\s*value\s*:/g },
  { name: "text-split", regex: /SplitText|SplitType|splitText/g },
];

const HOTSPOTS_PER_PATTERN_PER_FILE = 15;
const HOTSPOTS_PER_FILE = 40;
const SNIPPET_RADIUS = 160;
const IGNORED_SOURCE_PATTERN = /(^|\/)node_modules\//;

export function findSourceMapReference(body: string): string | undefined {
  const tail = body.slice(-2000);
  const match = tail.match(/[#@]\s*sourceMappingURL=(\S+)\s*$/);
  return match?.[1];
}

export function resolveSourceMapUrl(scriptUrl: string, reference: string): string {
  return new URL(reference, scriptUrl).toString();
}

export function decodeInlineSourceMap(reference: string): string | undefined {
  const match = reference.match(/^data:application\/json(?:;charset=[\w-]+)?;base64,(.+)$/i);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : undefined;
}

export function safeRelativePath(value: string): string {
  const stripped = value
    .replace(/^[a-z][\w+.-]*:\/\/+/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/");
  const parts = normalize(stripped)
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[^\w.@-]/g, "_").slice(0, 120));
  return parts.length ? parts.join("/") : "unnamed";
}

export function detectSignatures(scripts: ScriptBody[]): LibrarySignature[] {
  const found = new Map<string, LibrarySignature>();
  for (const script of scripts) {
    for (const signature of LIBRARY_SIGNATURES) {
      if (!signature.test.test(script.body)) continue;
      const entry = found.get(signature.library) ?? { library: signature.library, files: [] };
      const version = signature.version ? script.body.match(signature.version)?.[1] : undefined;
      if (version && !entry.version) entry.version = version;
      if (entry.files.length < 5) entry.files.push(script.url);
      found.set(signature.library, entry);
    }
  }
  return [...found.values()];
}

export function findHotspots(scripts: ScriptBody[], limit = MOTION_HOTSPOT_LIMIT): Hotspot[] {
  const hotspots: Hotspot[] = [];
  for (const script of scripts) {
    let inFile = 0;
    for (const pattern of HOTSPOT_PATTERNS) {
      let perFile = 0;
      for (const match of script.body.matchAll(pattern.regex)) {
        if (perFile >= HOTSPOTS_PER_PATTERN_PER_FILE || inFile >= HOTSPOTS_PER_FILE || hotspots.length >= limit) break;
        const index = match.index;
        const start = Math.max(0, index - SNIPPET_RADIUS);
        const end = Math.min(script.body.length, index + match[0].length + SNIPPET_RADIUS);
        hotspots.push({
          pattern: pattern.name,
          file: script.url,
          line: script.body.slice(0, index).split("\n").length,
          snippet: script.body.slice(start, end).replace(/\s+/g, " ").trim(),
        });
        perFile++;
        inFile++;
      }
    }
  }
  return hotspots;
}

export function listUncertainties(page: PageCapture, sourceMaps: SourceMapResult[], skippedScripts: number): string[] {
  const notes: string[] = [];
  if (!page.traces.length && !page.animations.length) {
    notes.push("No element changed during the pointer and scroll path. The page may use virtual scrolling, a canvas-only scene, or triggers outside the scripted path.");
  }
  if (page.webgl.contexts.some((context) => context.includes("webgl")) && !page.webgl.shaders.length) {
    notes.push("A WebGL context was requested but no shader source was captured. Rendering may run in a worker or OffscreenCanvas, or the context failed to start.");
  }
  if (page.webgl.droppedShaders) {
    notes.push(`${page.webgl.droppedShaders} shader source(s) were not stored because the shader cap was reached.`);
  }
  if (page.css.inaccessibleSheets.length) {
    notes.push(`${page.css.inaccessibleSheets.length} cross-origin stylesheet(s) could not be read through CSSOM.`);
  }
  if (skippedScripts) {
    notes.push(`${skippedScripts} script(s) were skipped because of the count or size limit.`);
  }
  if (!sourceMaps.some((map) => map.status === "recovered")) {
    notes.push("No original source was recovered from source maps. Treat bundle hotspots as minified code that needs reading, not as original source.");
  }
  notes.push("Element traces sample computed styles between settled steps. They show values, not the easing curve between samples.");
  return notes;
}

export function summarizeTrace(trace: ElementTrace, prop: string): string {
  const sequence: string[] = [];
  for (const point of trace.points) {
    const value = point.values[prop];
    if (sequence[sequence.length - 1] !== value) sequence.push(value);
  }
  const shown = sequence.length > 4 ? [...sequence.slice(0, 3), "...", sequence[sequence.length - 1]] : sequence;
  return `${prop}: ${shown.join(" -> ")}`;
}

export function formatMotionReport(report: MotionReport, characterLimit: number): string {
  const lines = [
    `# Motion extraction: ${report.finalUrl}`,
    "",
    `Status: ${report.status} (${report.reasonCode}). Viewport: ${report.viewport}. Reduced motion: ${report.reducedMotion ? "on" : "off"}.`,
    `Artifacts: ${report.artifactDir}`,
    "",
    "## Stack",
    "",
    ...Object.entries(report.page.globals).map(([name, value]) => `- runtime global ${name}: ${value}`),
    ...report.signatures.map((signature) => `- bundle signature ${signature.library}${signature.version ? ` ${signature.version}` : ""}`),
    "",
    "## Source maps",
    "",
    ...(report.sourceMaps.length
      ? report.sourceMaps.map((map) => `- ${map.status}: ${map.mapUrl} (${map.savedSources} saved, ${map.skippedLibrarySources} library sources skipped)`)
      : ["- none referenced or found"]),
    "",
    "## Element traces",
    "",
    ...report.page.traces.map((trace) => {
      const changes = trace.changedProps.map((prop) => summarizeTrace(trace, prop)).join("; ");
      return `- \`${trace.selector}\` ${trace.label ? `"${trace.label}" ` : ""}(${trace.distinctStates} states) ${changes}`;
    }),
    "",
    "## Animations (Web Animations API)",
    "",
    ...report.page.animations.map((animation) => `- ${animation.kind} ${animation.name || "(unnamed)"} on \`${animation.target}\`, timeline ${animation.timeline}, ${JSON.stringify(animation.timing)}`),
    "",
    "## CSS",
    "",
    ...report.page.css.keyframes.map((rule) => `- @keyframes ${rule.name}`),
    ...report.page.css.scrollDriven.map((rule) => `- scroll-driven: ${rule}`),
    ...report.page.css.transitionTimings.slice(0, 10).map((timing) => `- transition timing ${timing.value} x${timing.uses}`),
    "",
    "## WebGL",
    "",
    `- contexts: ${report.page.webgl.contexts.join(", ") || "none"}`,
    `- shaders: ${report.page.webgl.shaders.length} (saved under shaders/)`,
    ...Object.entries(report.page.webgl.uniforms).slice(0, 30).map(([name, uniform]) => `- uniform ${name}: ${uniform.calls} calls, first ${JSON.stringify(uniform.first)}, last ${JSON.stringify(uniform.last)}`),
    "",
    "## Code hotspots",
    "",
    ...report.hotspots.slice(0, 40).map((hotspot) => `- [${hotspot.pattern}] ${hotspot.file}:${hotspot.line} \`${hotspot.snippet.slice(0, 220)}\``),
    "",
    "## Uncertainties",
    "",
    ...report.uncertainties.map((note) => `- ${note}`),
  ];
  const text = lines.join("\n");
  return text.length > characterLimit ? `${text.slice(0, characterLimit)}\n\n...(truncated; read report.json in the artifact directory)` : text;
}

export const ExtractMotionInputSchema = z
  .object({
    url: z
      .string()
      .trim()
      .url("url must be a valid URL")
      .describe("Public live-site URL to inspect. Awwwards pages are not accepted; pass the site itself."),
    viewport: z.enum(["desktop", "mobile"]).default("desktop").describe("Viewport profile (desktop 1440x900, mobile 390x844)"),
    reduced_motion: z.boolean().default(false).describe("Emulate prefers-reduced-motion: reduce"),
    scroll_steps: z.number().int().min(0).max(40).default(12).describe("Number of wheel steps down the page (0 skips scrolling)"),
    include_bundles: z.boolean().default(true).describe("Save script bundles, probe source maps, and search for motion code hotspots"),
    webgl: z.boolean().default(true).describe("Enable software WebGL in headless Chromium so shader sources can be captured"),
    max_elements: z.number().int().min(1).max(200).default(40).describe("Maximum number of changing elements to report"),
    dry_run: z.boolean().default(false).describe("If true, return the capture plan without launching a browser"),
  })
  .strict();

export type ExtractMotionInput = z.infer<typeof ExtractMotionInputSchema>;

// Minimal structural types for the Playwright surface this module uses. They keep
// tests independent of a real browser.
export interface MotionResponse {
  url(): string;
  status(): number;
  request(): { resourceType(): string };
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
}

export interface MotionRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}

export interface MotionPage {
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  mouse: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  on(event: "response", handler: (response: MotionResponse) => void): void;
}

export interface MotionContext {
  addInitScript(script: () => void): Promise<void>;
  route(pattern: string, handler: (route: MotionRoute) => Promise<void>): Promise<void>;
  newPage(): Promise<MotionPage>;
  request: {
    get(url: string, options: { timeout: number; failOnStatusCode: boolean }): Promise<{ status(): number; body(): Promise<Buffer> }>;
  };
}

export interface MotionBrowser {
  newContext(options: Record<string, unknown>): Promise<MotionContext>;
  close(): Promise<void>;
}

export interface CaptureDeps {
  launch(options: { headless: boolean; args: string[] }): Promise<MotionBrowser>;
  isAllowedUrl(url: string): boolean;
  artifactRoot: string;
  now(): Date;
}

// The MCP runtime exports an HTTPS_PROXY that only allows Awwwards. Playwright
// turns proxy variables into a browser proxy, so the live-site browser drops them.
export function withoutProxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(?:https?|all|no)_proxy$/i.test(entry[0]))
  );
}

/* v8 ignore start */
export async function launchChromium(options: { headless: boolean; args: string[] }): Promise<MotionBrowser> {
  let chromium: { launch(options: { headless: boolean; args: string[]; env: Record<string, string> }): Promise<unknown> };
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed in the MCP runtime");
  }
  try {
    return (await chromium.launch({ ...options, env: withoutProxyEnv(process.env) })) as MotionBrowser;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Chromium failed to launch. Set PLAYWRIGHT_BROWSERS_PATH to a cache that contains the browser for playwright-core. ${message}`);
  }
}

// Runs in the page before any site script. It records WebGL shader sources and
// uniform writes, and which canvas contexts the page requests.
export function installMotionHooks(): void {
  type Fn = (...args: unknown[]) => unknown;
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.__motionExtract) return;
  const state = {
    contexts: [] as string[],
    shaders: [] as Array<{ type: string; source: string }>,
    droppedShaders: 0,
    uniforms: {} as Record<string, { calls: number; first: number[]; last: number[] }>,
  };
  g.__motionExtract = state;
  const shaderTypes = new WeakMap<object, string>();
  const uniformNames = new WeakMap<object, string>();
  const flatten = (values: unknown[]): number[] => {
    const out: number[] = [];
    for (const value of values) {
      if (typeof value === "number") out.push(value);
      else if (value && typeof value === "object" && "length" in value) {
        for (const item of Array.from(value as ArrayLike<number>).slice(0, 16)) out.push(Number(item));
      }
      if (out.length >= 16) break;
    }
    return out.slice(0, 16).map((n) => Math.round(n * 10000) / 10000);
  };
  try {
    const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, Fn>;
    const getContext = canvasProto.getContext;
    canvasProto.getContext = function (this: unknown, ...args: unknown[]) {
      const type = String(args[0]);
      if (!state.contexts.includes(type)) state.contexts.push(type);
      return getContext.apply(this, args);
    };
  } catch { /* keep the page usable */ }
  const protos = [g.WebGLRenderingContext, g.WebGL2RenderingContext]
    .map((ctor) => (ctor as { prototype?: Record<string, Fn> } | undefined)?.prototype)
    .filter((proto): proto is Record<string, Fn> => Boolean(proto));
  for (const proto of protos) {
    try {
      const createShader = proto.createShader;
      proto.createShader = function (this: { VERTEX_SHADER: number }, ...args: unknown[]) {
        const shader = createShader.apply(this, args);
        if (shader && typeof shader === "object") shaderTypes.set(shader, args[0] === this.VERTEX_SHADER ? "vertex" : "fragment");
        return shader;
      };
      const shaderSource = proto.shaderSource;
      proto.shaderSource = function (this: unknown, ...args: unknown[]) {
        const source = String(args[1]);
        if (!state.shaders.some((shader) => shader.source === source)) {
          if (state.shaders.length < 60) state.shaders.push({ type: shaderTypes.get(args[0] as object) ?? "unknown", source });
          else state.droppedShaders++;
        }
        return shaderSource.apply(this, args);
      };
      const getUniformLocation = proto.getUniformLocation;
      proto.getUniformLocation = function (this: unknown, ...args: unknown[]) {
        const location = getUniformLocation.apply(this, args);
        if (location && typeof location === "object") uniformNames.set(location, String(args[1]));
        return location;
      };
      for (const method of ["uniform1f", "uniform2f", "uniform3f", "uniform4f", "uniform1i", "uniform1fv", "uniform2fv", "uniform3fv", "uniform4fv"]) {
        const original = proto[method];
        if (typeof original !== "function") continue;
        proto[method] = function (this: unknown, ...args: unknown[]) {
          const name = args[0] && typeof args[0] === "object" ? uniformNames.get(args[0] as object) : undefined;
          if (name) {
            const values = flatten(args.slice(1));
            const record = state.uniforms[name] ?? (Object.keys(state.uniforms).length < 120 ? (state.uniforms[name] = { calls: 0, first: values, last: values }) : undefined);
            if (record) {
              record.calls++;
              record.last = values;
            }
          }
          return original.apply(this, args);
        };
      }
    } catch { /* keep the page usable */ }
  }
}

// Runs in the page. Records computed motion properties for every rendered
// element under a step label, and merges the current Web Animations list.
export function recordMotionSample(args: { step: string; nodeLimit: number }): void {
  const g = globalThis as unknown as Record<string, unknown>;
  type Store = {
    steps: Array<{ step: string; scrollY: number }>;
    values: Record<string, { label: string; states: Record<number, string[]> }>;
    animations: Record<string, unknown>;
  };
  const store = (g.__motionSamples ??= { steps: [], values: {}, animations: {} }) as Store;
  const props = ["transform", "opacity", "clipPath", "filter", "translate", "scale", "rotate"];
  const skip = new Set(["SCRIPT", "STYLE", "META", "LINK", "NOSCRIPT", "BR", "HEAD", "TITLE", "TEMPLATE"]);
  const selectorFor = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement && parts.length < 5) {
      if (current.id && /^[A-Za-z][\w-]*$/.test(current.id)) {
        parts.unshift(`#${current.id}`);
        break;
      }
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      const siblings = parent ? Array.from(parent.children).filter((child) => child.tagName === current!.tagName) : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
      current = parent;
    }
    return parts.join(" > ");
  };
  const index = store.steps.length;
  store.steps.push({ step: args.step, scrollY: Math.round(window.scrollY) });
  const elements = document.body ? Array.from(document.body.querySelectorAll("*")) : [];
  let counted = 0;
  for (const element of elements) {
    if (counted >= args.nodeLimit) break;
    if (skip.has(element.tagName)) continue;
    const style = getComputedStyle(element);
    if (style.display === "none") continue;
    counted++;
    const selector = selectorFor(element);
    const record = (store.values[selector] ??= {
      label: (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
      states: {},
    });
    const source = style as unknown as Record<string, string>;
    record.states[index] = props.map((prop) => source[prop] ?? "");
  }
  for (const animation of document.getAnimations()) {
    const effect = animation.effect as KeyframeEffect | null;
    const target = effect?.target ? selectorFor(effect.target) : "";
    const anyAnimation = animation as unknown as { animationName?: string; transitionProperty?: string };
    const name = anyAnimation.animationName ?? anyAnimation.transitionProperty ?? animation.id ?? "";
    const key = `${animation.constructor.name}|${name}|${target}`;
    if (store.animations[key]) continue;
    const timelineName = animation.timeline?.constructor?.name ?? "none";
    const timing = effect?.getTiming?.() ?? {};
    store.animations[key] = {
      kind: animation.constructor.name,
      name,
      target,
      timeline: timelineName === "DocumentTimeline" ? "document" : timelineName === "ScrollTimeline" ? "scroll" : timelineName === "ViewTimeline" ? "view" : timelineName,
      timing: Object.fromEntries(Object.entries(timing).filter(([, value]) => typeof value === "string" || typeof value === "number")),
      keyframes: (effect?.getKeyframes?.() ?? []).slice(0, 8).map((frame) =>
        Object.fromEntries(Object.entries(frame).slice(0, 12).map(([prop, value]) => [prop, typeof value === "number" || value === null ? value : String(value).slice(0, 200)]))
      ),
    };
  }
}

// Runs in the page after the scripted path. Returns only elements whose
// computed motion properties changed, plus CSSOM rules, WebGL hooks, and globals.
export function collectMotionCapture(args: { maxElements: number }): PageCapture {
  const g = globalThis as unknown as Record<string, unknown>;
  const props = ["transform", "opacity", "clipPath", "filter", "translate", "scale", "rotate"];
  type Store = {
    steps: Array<{ step: string; scrollY: number }>;
    values: Record<string, { label: string; states: Record<number, string[]> }>;
    animations: Record<string, AnimationRecord>;
  };
  const store = (g.__motionSamples ?? { steps: [], values: {}, animations: {} }) as Store;
  const traces: ElementTrace[] = [];
  for (const [selector, record] of Object.entries(store.values)) {
    const indices = Object.keys(record.states).map(Number).sort((a, b) => a - b);
    const states = indices.map((i) => record.states[i].join("\u0000"));
    const distinct = new Set(states).size;
    if (distinct < 2) continue;
    const changed = props.filter((_, p) => new Set(indices.map((i) => record.states[i][p])).size > 1);
    traces.push({
      selector,
      label: record.label,
      changedProps: changed,
      distinctStates: distinct,
      points: indices.map((i) => ({
        step: store.steps[i].step,
        scrollY: store.steps[i].scrollY,
        values: Object.fromEntries(changed.map((prop) => [prop, record.states[i][props.indexOf(prop)]])),
      })),
    });
  }
  traces.sort((a, b) => b.distinctStates - a.distinctStates);

  const keyframes: Array<{ name: string; cssText: string }> = [];
  const scrollDriven: string[] = [];
  const timings = new Map<string, number>();
  const inaccessibleSheets: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSKeyframesRule) {
        if (keyframes.length < 40) keyframes.push({ name: rule.name, cssText: rule.cssText.slice(0, 1500) });
      } else if (rule instanceof CSSStyleRule) {
        const text = rule.cssText;
        if (/animation-timeline|view-timeline|scroll-timeline|animation-range/.test(text) && scrollDriven.length < 40) scrollDriven.push(text.slice(0, 600));
        const timing = rule.style.getPropertyValue("transition-timing-function");
        if (timing) timings.set(timing, (timings.get(timing) ?? 0) + 1);
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) visit(nested);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      inaccessibleSheets.push(sheet.href ?? "inline");
    }
  }

  const globals: Record<string, string> = {};
  const read = (name: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== false) globals[name] = typeof value === "string" || typeof value === "number" ? String(value) : "present";
  };
  const gsap = g.gsap as { version?: string } | undefined;
  read("gsap", gsap ? gsap.version ?? "present" : undefined);
  read("ScrollTrigger", g.ScrollTrigger);
  read("__THREE__", g.__THREE__);
  read("THREE", g.THREE);
  read("lenis-class", document.documentElement.classList.contains("lenis") || undefined);
  read("Lenis", g.Lenis ?? g.lenis);
  read("barba", g.barba);
  read("PIXI", (g.PIXI as { VERSION?: string } | undefined)?.VERSION ?? g.PIXI);
  read("framer-appear", document.querySelector("[data-framer-appear-id], [data-projection-id]") ? "present" : undefined);

  return {
    traces: traces.slice(0, args.maxElements),
    animations: Object.values(store.animations).slice(0, 80),
    css: {
      keyframes,
      scrollDriven,
      transitionTimings: [...timings.entries()].map(([value, uses]) => ({ value, uses })).sort((a, b) => b.uses - a.uses).slice(0, 20),
      inaccessibleSheets: inaccessibleSheets.slice(0, 40),
    },
    webgl: (g.__motionExtract as WebglCapture | undefined) ?? { contexts: [], shaders: [], droppedShaders: 0, uniforms: {} },
    globals,
    scrollHeight: document.documentElement.scrollHeight,
  };
}

export function readInlineScripts(): Array<{ index: number; body: string }> {
  return Array.from(document.querySelectorAll("script:not([src])"))
    .filter((script) => !/json|template|text\/html/i.test(script.getAttribute("type") ?? ""))
    .map((script, index) => ({ index, body: script.textContent ?? "" }))
    .filter((script) => script.body.trim().length > 0)
    .slice(0, 20);
}

export function readScrollMetrics(): { innerHeight: number; scrollHeight: number } {
  return { innerHeight: window.innerHeight, scrollHeight: document.documentElement.scrollHeight };
}
/* v8 ignore stop */

async function collectScripts(
  responses: MotionResponse[],
  inline: Array<{ index: number; body: string }>,
  pageUrl: string
): Promise<{ scripts: ScriptBody[]; skipped: number }> {
  const scripts: ScriptBody[] = [];
  let skipped = 0;
  let total = 0;
  for (const response of responses) {
    if (scripts.length >= MOTION_SCRIPT_LIMIT) {
      skipped++;
      continue;
    }
    let body: Buffer;
    try {
      body = await response.body();
    } catch {
      skipped++;
      continue;
    }
    if (body.byteLength > MOTION_SCRIPT_MAX_BYTES || total + body.byteLength > MOTION_TOTAL_SCRIPT_BYTES) {
      skipped++;
      continue;
    }
    total += body.byteLength;
    const headers = response.headers();
    scripts.push({ url: response.url(), body: body.toString("utf8"), sourceMapHeader: headers["sourcemap"] ?? headers["x-sourcemap"] });
  }
  for (const script of inline) {
    scripts.push({ url: `${pageUrl}#inline-${script.index}`, body: script.body });
  }
  return { scripts, skipped };
}

async function recoverSourceMap(
  script: ScriptBody,
  context: MotionContext,
  deps: CaptureDeps,
  artifactDir: string,
  mapIndex: number
): Promise<SourceMapResult | undefined> {
  if (script.url.includes("#inline-")) return undefined;
  const reference = script.sourceMapHeader ?? findSourceMapReference(script.body);
  const mapUrl = reference ? (reference.startsWith("data:") ? "inline" : resolveSourceMapUrl(script.url, reference)) : `${script.url}.map`;
  const result: SourceMapResult = { script: script.url, mapUrl, status: "not-found", sources: 0, savedSources: 0, skippedLibrarySources: 0 };
  let text = reference?.startsWith("data:") ? decodeInlineSourceMap(reference) : undefined;
  if (text === undefined) {
    if (mapUrl === "inline") return { ...result, status: "invalid" };
    if (!deps.isAllowedUrl(mapUrl)) return { ...result, status: "blocked" };
    try {
      const response = await context.request.get(mapUrl, { timeout: 10_000, failOnStatusCode: false });
      if (response.status() !== 200) return reference ? result : undefined;
      const body = await response.body();
      if (body.byteLength > MOTION_SOURCE_MAP_MAX_BYTES) return { ...result, status: "too-large" };
      text = body.toString("utf8");
    } catch {
      return reference ? result : undefined;
    }
  }
  let map: { sources?: unknown; sourcesContent?: unknown };
  try {
    map = JSON.parse(text) as { sources?: unknown; sourcesContent?: unknown };
  } catch {
    return reference ? { ...result, status: "invalid" } : undefined;
  }
  if (!Array.isArray(map.sources)) return reference ? { ...result, status: "invalid" } : undefined;
  result.sources = map.sources.length;
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  if (!contents.some((content) => typeof content === "string")) return { ...result, status: "no-sources-content" };
  for (let i = 0; i < map.sources.length && result.savedSources < MOTION_SOURCE_FILE_LIMIT; i++) {
    const source = String(map.sources[i]);
    const content = contents[i];
    if (typeof content !== "string") continue;
    if (IGNORED_SOURCE_PATTERN.test(source)) {
      result.skippedLibrarySources++;
      continue;
    }
    const target = join(artifactDir, "sources", String(mapIndex), safeRelativePath(source));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    result.savedSources++;
  }
  return { ...result, status: "recovered" };
}

export function defaultCaptureDeps(isAllowedUrl: (url: string) => boolean): CaptureDeps {
  return {
    launch: launchChromium,
    isAllowedUrl,
    artifactRoot: process.env.DESIGN_INSPIRATION_ARTIFACT_DIR || join(tmpdir(), "design-extract-motion"),
    now: () => new Date(),
  };
}

export async function captureMotion(params: ExtractMotionInput, deps: CaptureDeps): Promise<MotionReport> {
  if (!deps.isAllowedUrl(params.url)) {
    throw new Error(`URL must be a public live site, not an Awwwards, local, or private address: ${params.url}`);
  }
  const capturedAt = deps.now();
  const host = new URL(params.url).hostname.replace(/[^\w.-]/g, "_");
  const artifactDir = join(deps.artifactRoot, `${host}-${capturedAt.toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(artifactDir, { recursive: true });

  const viewport = VIEWPORTS[params.viewport];
  const browser = await deps.launch({ headless: true, args: params.webgl ? ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] : [] });
  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      reducedMotion: params.reduced_motion ? "reduce" : "no-preference",
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      if (deps.isAllowedUrl(route.request().url())) await route.continue();
      else await route.abort();
    });
    await context.addInitScript(installMotionHooks);
    const page = await context.newPage();
    const scriptResponses: MotionResponse[] = [];
    page.on("response", (response) => {
      if (response.status() === 200 && response.request().resourceType() === "script") scriptResponses.push(response);
    });

    await page.goto(params.url, { waitUntil: "load", timeout: MOTION_PAGE_TIMEOUT_MS });
    await page.waitForTimeout(1500);
    const sample = (step: string) => page.evaluate(recordMotionSample, { step, nodeLimit: MOTION_SAMPLE_NODE_LIMIT });
    await sample("load");
    await page.waitForTimeout(600);
    await sample("load+600ms");

    if (!viewport.isMobile) {
      const points = [[0.5, 0.5], [0.2, 0.3], [0.8, 0.3], [0.8, 0.7], [0.2, 0.7]];
      for (const [index, [x, y]] of points.entries()) {
        await page.mouse.move(viewport.width * x, viewport.height * y, { steps: 8 });
        await page.waitForTimeout(300);
        await sample(`pointer-${index}`);
      }
      await page.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 4 });
    }

    if (params.scroll_steps > 0) {
      const { innerHeight, scrollHeight } = await page.evaluate(readScrollMetrics, undefined);
      const delta = Math.max(Math.ceil((scrollHeight - innerHeight) / params.scroll_steps), Math.round(innerHeight * 0.6));
      for (let step = 1; step <= params.scroll_steps; step++) {
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(450);
        await sample(`scroll-${step}`);
      }
      await page.waitForTimeout(1200);
      await sample("scroll-settled");
    }

    const capture = await page.evaluate(collectMotionCapture, { maxElements: params.max_elements });
    const finalUrl = page.url();

    for (const [index, shader] of capture.webgl.shaders.entries()) {
      await mkdir(join(artifactDir, "shaders"), { recursive: true });
      await writeFile(join(artifactDir, "shaders", `${String(index).padStart(2, "0")}-${shader.type}.glsl`), shader.source);
    }

    let scripts: ScriptBody[] = [];
    let skippedScripts = 0;
    const savedScripts: MotionReport["scripts"] = [];
    const sourceMaps: SourceMapResult[] = [];
    if (params.include_bundles) {
      const inline = await page.evaluate(readInlineScripts, undefined);
      ({ scripts, skipped: skippedScripts } = await collectScripts(scriptResponses, inline, finalUrl));
      await mkdir(join(artifactDir, "bundles"), { recursive: true });
      for (const [index, script] of scripts.entries()) {
        const name = `${String(index).padStart(2, "0")}-${safeRelativePath(new URL(script.url).pathname.split("/").pop() || "script")}`.replace(/(\.m?js)?$/, ".js");
        await writeFile(join(artifactDir, "bundles", name), script.body);
        savedScripts.push({ url: script.url, bytes: Buffer.byteLength(script.body), savedAs: `bundles/${name}` });
        const map = await recoverSourceMap(script, context, deps, artifactDir, index);
        if (map) sourceMaps.push(map);
      }
    }

    const signatures = detectSignatures(scripts);
    const hotspots = findHotspots(scripts);
    const uncertainties = listUncertainties(capture, sourceMaps, skippedScripts);
    const hasSignal = capture.traces.length > 0 || capture.animations.length > 0 || capture.webgl.shaders.length > 0 || hotspots.length > 0;
    const report: MotionReport = {
      status: hasSignal ? "ready" : "partial",
      reasonCode: hasSignal ? "motion.captured" : "motion.no_signal",
      url: params.url,
      finalUrl,
      capturedAt: capturedAt.toISOString(),
      viewport: params.viewport,
      reducedMotion: params.reduced_motion,
      artifactDir,
      evidence: EVIDENCE_CLASSES,
      page: capture,
      signatures,
      hotspots,
      sourceMaps,
      scripts: savedScripts,
      skippedScripts,
      uncertainties,
    };
    await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await browser.close();
  }
}
