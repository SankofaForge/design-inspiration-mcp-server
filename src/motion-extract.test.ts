import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ExtractMotionInputSchema,
  MOTION_HOTSPOT_LIMIT,
  MOTION_SCRIPT_LIMIT,
  MOTION_SCRIPT_MAX_BYTES,
  MOTION_SOURCE_FILE_LIMIT,
  MOTION_SOURCE_MAP_MAX_BYTES,
  MOTION_TOTAL_SCRIPT_BYTES,
  captureMotion,
  collectMotionCapture,
  decodeInlineSourceMap,
  defaultCaptureDeps,
  detectSignatures,
  findHotspots,
  findSourceMapReference,
  formatMotionReport,
  launchChromium,
  listUncertainties,
  readInlineScripts,
  readScrollMetrics,
  recordMotionSample,
  resolveSourceMapUrl,
  safeRelativePath,
  summarizeTrace,
  withoutProxyEnv,
  type CaptureDeps,
  type ExtractMotionInput,
  type MotionBrowser,
  type MotionReport,
  type MotionResponse,
  type MotionRoute,
  type PageCapture,
  type SourceMapResult,
} from "./motion-extract.js";
import { isLiveSiteUrl, motionCapture, server } from "./index.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

function emptyCapture(overrides: Partial<PageCapture> = {}): PageCapture {
  return {
    traces: [],
    animations: [],
    css: { keyframes: [], scrollDriven: [], transitionTimings: [], inaccessibleSheets: [] },
    webgl: { contexts: [], shaders: [], droppedShaders: 0, uniforms: {} },
    globals: {},
    scrollHeight: 3000,
    ...overrides,
  };
}

function richCapture(): PageCapture {
  return emptyCapture({
    traces: [
      {
        selector: "main > h1",
        label: "Elevation",
        changedProps: ["transform", "opacity"],
        distinctStates: 3,
        points: [
          { step: "load", scrollY: 0, values: { transform: "none", opacity: "1" } },
          { step: "scroll-1", scrollY: 400, values: { transform: "matrix(1, 0, 0, 1, 0, -40)", opacity: "0.5" } },
        ],
      },
      { selector: "div", label: "", changedProps: ["filter"], distinctStates: 2, points: [] },
    ],
    animations: [{ kind: "CSSAnimation", name: "spin", target: "svg", timeline: "document", timing: { duration: 1000, easing: "linear" }, keyframes: [] }, { kind: "Animation", name: "", target: "p", timeline: "view", timing: {}, keyframes: [] }],
    css: {
      keyframes: [{ name: "spin", cssText: "@keyframes spin {}" }],
      scrollDriven: [".x { animation-timeline: view(); }"],
      transitionTimings: [{ value: "cubic-bezier(0.2, 0, 0, 1)", uses: 3 }],
      inaccessibleSheets: [],
    },
    webgl: { contexts: ["webgl2"], shaders: [{ type: "fragment", source: "void main(){}" }, { type: "vertex", source: "void main(){gl_Position=vec4(0.);}" }], droppedShaders: 0, uniforms: { uTime: { calls: 10, first: [0], last: [1.5] } } },
    globals: { gsap: "3.12.5" },
  });
}

interface FakeOptions {
  capture?: PageCapture;
  responses?: MotionResponse[];
  inline?: Array<{ index: number; body: string }>;
  mapResponses?: Record<string, { status: number; body: string } | Error>;
  routeUrls?: string[];
}

function fakeResponse(url: string, body: string | Error, options: { status?: number; type?: string; headers?: Record<string, string> } = {}): MotionResponse {
  return {
    url: () => url,
    status: () => options.status ?? 200,
    request: () => ({ resourceType: () => options.type ?? "script" }),
    headers: () => options.headers ?? {},
    body: async () => {
      if (body instanceof Error) throw body;
      return Buffer.from(body);
    },
  };
}

function fakeBrowser(options: FakeOptions = {}) {
  const calls = {
    launchArgs: [] as string[],
    contextOptions: {} as Record<string, unknown>,
    moves: 0,
    wheels: [] as number[],
    samples: [] as string[],
    routed: [] as Array<{ url: string; action: string }>,
    closed: false,
    mapRequests: [] as string[],
  };
  const browser: MotionBrowser = {
    async newContext(contextOptions) {
      calls.contextOptions = contextOptions;
      let responseHandler: ((response: MotionResponse) => void) | undefined;
      let routeHandler: ((route: MotionRoute) => Promise<void>) | undefined;
      return {
        async addInitScript() {},
        async route(_pattern, handler) {
          routeHandler = handler;
        },
        request: {
          async get(url) {
            calls.mapRequests.push(url);
            const entry = options.mapResponses?.[url];
            if (entry instanceof Error) throw entry;
            const status = entry?.status ?? 404;
            return { status: () => status, body: async () => Buffer.from(entry?.body ?? "") };
          },
        },
        async newPage() {
          return {
            async goto() {
              for (const url of options.routeUrls ?? []) {
                await routeHandler?.({
                  request: () => ({ url: () => url }),
                  continue: async () => { calls.routed.push({ url, action: "continue" }); },
                  abort: async () => { calls.routed.push({ url, action: "abort" }); },
                });
              }
              for (const response of options.responses ?? []) responseHandler?.(response);
              return null;
            },
            url: () => "https://example.com/",
            async waitForTimeout() {},
            async evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R> {
              if (fn === (recordMotionSample as unknown)) {
                calls.samples.push((arg as { step: string }).step);
                return undefined as R;
              }
              if (fn === (readScrollMetrics as unknown)) return { innerHeight: 900, scrollHeight: 3000 } as R;
              if (fn === (readInlineScripts as unknown)) return (options.inline ?? []) as R;
              if (fn === (collectMotionCapture as unknown)) return (options.capture ?? emptyCapture()) as R;
              throw new Error("unexpected evaluate");
            },
            mouse: {
              async move() { calls.moves++; },
              async wheel(_x, y) { calls.wheels.push(y); },
            },
            on(_event, handler) {
              responseHandler = handler;
            },
          };
        },
      };
    },
    async close() {
      calls.closed = true;
    },
  };
  return { browser, calls };
}

let artifactRoot: string;

function deps(browser: MotionBrowser, extra: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    launch: async (launchOptions) => {
      void launchOptions;
      return browser;
    },
    isAllowedUrl: isLiveSiteUrl,
    artifactRoot,
    now: () => new Date("2026-10-11T12:00:00.000Z"),
    ...extra,
  };
}

function input(overrides: Partial<ExtractMotionInput> = {}): ExtractMotionInput {
  return ExtractMotionInputSchema.parse({ url: "https://example.com/", ...overrides });
}

beforeEach(async () => {
  artifactRoot = await mkdtemp(join(tmpdir(), "motion-extract-test-"));
});

afterEach(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("motion extraction helpers", () => {
  it("finds and resolves source map references", () => {
    expect(findSourceMapReference("code\n//# sourceMappingURL=app.js.map\n")).toBe("app.js.map");
    expect(findSourceMapReference("code //@ sourceMappingURL=x.map")).toBe("x.map");
    expect(findSourceMapReference("no map here")).toBeUndefined();
    expect(resolveSourceMapUrl("https://cdn.example.com/js/app.js", "app.js.map")).toBe("https://cdn.example.com/js/app.js.map");
  });

  it("decodes inline base64 source maps only", () => {
    const encoded = Buffer.from('{"sources":[]}').toString("base64");
    expect(decodeInlineSourceMap(`data:application/json;charset=utf-8;base64,${encoded}`)).toBe('{"sources":[]}');
    expect(decodeInlineSourceMap("data:text/plain,abc")).toBeUndefined();
  });

  it("builds safe relative paths", () => {
    expect(safeRelativePath("webpack://app/./src/../src/anim/hero.ts?abc")).toBe("app/src/anim/hero.ts");
    expect(safeRelativePath("../../etc/passwd")).toBe("etc/passwd");
    expect(safeRelativePath("C:\\x\\y z.js")).toBe("C_/x/y_z.js");
    expect(safeRelativePath("../")).toBe("unnamed");
  });

  it("detects library signatures with versions and caps file lists", () => {
    const scripts = [
      { url: "a.js", body: "/* GSAP 3.12.5 */ gsap.to(x) ScrollTrigger" },
      { url: "b.js", body: "gsap REVISION = \"160\" THREE.Mesh" },
      ...Array.from({ length: 6 }, (_, i) => ({ url: `c${i}.js`, body: "lenis" })),
    ];
    const signatures = detectSignatures(scripts);
    expect(signatures.find((s) => s.library === "gsap")).toEqual({ library: "gsap", version: "3.12.5", files: ["a.js", "b.js"] });
    expect(signatures.find((s) => s.library === "three")?.version).toBe("160");
    expect(signatures.find((s) => s.library === "gsap-scrolltrigger")?.version).toBeUndefined();
    expect(signatures.find((s) => s.library === "lenis")?.files).toHaveLength(5);
    const kept = detectSignatures([{ url: "a.js", body: "gsap GSAP 3.12.5" }, { url: "b.js", body: "gsap GSAP 3.11.0" }]);
    expect(kept.find((s) => s.library === "gsap")?.version).toBe("3.12.5");
  });

  it("finds hotspots with line numbers and caps", () => {
    const hotspots = findHotspots([{ url: "a.js", body: "x\ny\ngsap.to(el, { ease: \"power2.out\", duration: 1 })" }]);
    expect(hotspots.map((h) => h.pattern)).toEqual(["gsap-call", "ease-literal"]);
    expect(hotspots[0]).toMatchObject({ file: "a.js", line: 3 });
    const many = findHotspots([{ url: "b.js", body: "stiffness: 1 ".repeat(40) }]);
    expect(many).toHaveLength(15);
    expect(findHotspots([{ url: "b.js", body: "stiffness: 1 ".repeat(40) }], 3)).toHaveLength(3);
    expect(MOTION_HOTSPOT_LIMIT).toBe(200);
  });

  it("lists uncertainties for missing evidence", () => {
    const missing = listUncertainties(
      emptyCapture({
        webgl: { contexts: ["webgl"], shaders: [], droppedShaders: 2, uniforms: {} },
        css: { keyframes: [], scrollDriven: [], transitionTimings: [], inaccessibleSheets: ["https://cdn/x.css"] },
      }),
      [],
      3
    );
    expect(missing.join("\n")).toMatch(/No element changed/);
    expect(missing.join("\n")).toMatch(/no shader source/);
    expect(missing.join("\n")).toMatch(/2 shader source/);
    expect(missing.join("\n")).toMatch(/1 cross-origin/);
    expect(missing.join("\n")).toMatch(/3 script/);
    expect(missing.join("\n")).toMatch(/No original source/);
    const recovered: SourceMapResult[] = [{ script: "a", mapUrl: "a.map", status: "recovered", sources: 1, savedSources: 1, skippedLibrarySources: 0 }];
    expect(listUncertainties(richCapture(), recovered, 0)).toEqual([
      "Element traces sample computed styles between settled steps. They show values, not the easing curve between samples.",
    ]);
  });

  it("summarizes trace value sequences", () => {
    const trace = {
      selector: "a",
      label: "",
      changedProps: ["scale"],
      distinctStates: 6,
      points: ["none", "none", "1.1", "1.2", "1.3", "none"].map((scale, i) => ({ step: `s${i}`, scrollY: i, values: { scale } })),
    };
    expect(summarizeTrace(trace, "scale")).toBe("scale: none -> 1.1 -> 1.2 -> ... -> none");
    expect(summarizeTrace({ ...trace, points: trace.points.slice(0, 3) }, "scale")).toBe("scale: none -> 1.1");
  });

  it("caps hotspots per file across patterns", () => {
    const body = ["stiffness: 1 ", "damping: 2 ", "ease: \"a\" ", "lerp: "].map((part) => part.repeat(15)).join("");
    expect(findHotspots([{ url: "v.js", body }])).toHaveLength(40);
  });

  it("formats a report and truncates long output", () => {
    const report: MotionReport = {
      status: "ready",
      reasonCode: "motion.captured",
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      capturedAt: "2026-10-11T12:00:00.000Z",
      viewport: "desktop",
      reducedMotion: true,
      artifactDir: "/tmp/x",
      evidence: {},
      page: richCapture(),
      signatures: [{ library: "gsap", version: "3.12.5", files: [] }, { library: "lenis", files: [] }],
      hotspots: [{ pattern: "ease-literal", file: "a.js", line: 1, snippet: "ease:\"power2.out\"" }],
      sourceMaps: [{ script: "a.js", mapUrl: "a.js.map", status: "recovered", sources: 2, savedSources: 1, skippedLibrarySources: 1 }],
      scripts: [],
      skippedScripts: 0,
      uncertainties: ["note"],
    };
    const text = formatMotionReport(report, 100_000);
    expect(text).toContain("Reduced motion: on");
    expect(text).toContain("runtime global gsap: 3.12.5");
    expect(text).toContain("bundle signature gsap 3.12.5");
    expect(text).toContain("bundle signature lenis\n");
    expect(text).toContain("recovered: a.js.map (1 saved, 1 library sources skipped)");
    expect(text).toContain('`main > h1` "Elevation" (3 states) transform: none -> matrix(1, 0, 0, 1, 0, -40); opacity: 1 -> 0.5');
    expect(text).toContain("`div` (2 states) filter: ");
    expect(text).toContain("CSSAnimation spin on `svg`");
    expect(text).toContain("Animation (unnamed) on `p`, timeline view");
    expect(text).toContain("contexts: webgl2");
    expect(text).toContain("uniform uTime: 10 calls");
    const empty = formatMotionReport({ ...report, reducedMotion: false, page: emptyCapture(), sourceMaps: [], signatures: [] }, 100_000);
    expect(empty).toContain("Reduced motion: off");
    expect(empty).toContain("none referenced or found");
    expect(empty).toContain("contexts: none");
    expect(formatMotionReport(report, 50)).toMatch(/truncated; read report.json/);
  });

  it("validates input defaults and limits", () => {
    expect(input()).toEqual({
      url: "https://example.com/",
      viewport: "desktop",
      reduced_motion: false,
      scroll_steps: 12,
      include_bundles: true,
      webgl: true,
      max_elements: 40,
      dry_run: false,
    });
    expect(ExtractMotionInputSchema.safeParse({ url: "not a url" }).success).toBe(false);
    expect(ExtractMotionInputSchema.safeParse({ url: "https://example.com", scroll_steps: 41 }).success).toBe(false);
    expect(ExtractMotionInputSchema.safeParse({ url: "https://example.com", extra: 1 }).success).toBe(false);
  });

  it("drops proxy variables from the browser environment", () => {
    expect(withoutProxyEnv({ PATH: "/bin", HTTPS_PROXY: "x", http_proxy: "y", ALL_PROXY: "z", NO_PROXY: "n", UNSET: undefined })).toEqual({ PATH: "/bin" });
  });

  it("builds default dependencies from the environment", () => {
    const previous = process.env.DESIGN_INSPIRATION_ARTIFACT_DIR;
    process.env.DESIGN_INSPIRATION_ARTIFACT_DIR = "/srv/motion";
    const configured = defaultCaptureDeps(isLiveSiteUrl);
    expect(configured.artifactRoot).toBe("/srv/motion");
    expect(configured.launch).toBe(launchChromium);
    expect(configured.now()).toBeInstanceOf(Date);
    delete process.env.DESIGN_INSPIRATION_ARTIFACT_DIR;
    expect(defaultCaptureDeps(isLiveSiteUrl).artifactRoot).toBe(join(tmpdir(), "design-extract-motion"));
    if (previous !== undefined) process.env.DESIGN_INSPIRATION_ARTIFACT_DIR = previous;
  });
});

describe("captureMotion", () => {
  it("rejects disallowed URLs before launching a browser", async () => {
    const launch = vi.fn();
    await expect(captureMotion(input({ url: "http://127.0.0.1/" }), deps({} as MotionBrowser, { launch }))).rejects.toThrow("public live site");
    expect(launch).not.toHaveBeenCalled();
  });

  it("drives the desktop path, saves artifacts, and recovers source maps", async () => {
    const mapJson = JSON.stringify({
      sources: ["webpack://app/./src/hero.ts", "webpack://app/node_modules/gsap/index.js", "webpack://app/./src/empty.ts"],
      sourcesContent: ["export const ease = 'power2.out';", "lib", null],
    });
    const inlineMap = `data:application/json;base64,${Buffer.from(JSON.stringify({ sources: ["src/inline.ts"], sourcesContent: ["inline source"] })).toString("base64")}`;
    const { browser, calls } = fakeBrowser({
      capture: richCapture(),
      routeUrls: ["https://cdn.example.com/a.js", "http://10.0.0.1/secret"],
      inline: [{ index: 0, body: "gsap.to(x, { ease: 'expo.out' })" }],
      responses: [
        fakeResponse("https://example.com/app.js", "gsap.to(x)\n//# sourceMappingURL=app.js.map"),
        fakeResponse("https://example.com/header.mjs", "lenis", { headers: { sourcemap: "header.map" } }),
        fakeResponse("https://example.com/x.js", "x", { headers: { "x-sourcemap": "x.map" } }),
        fakeResponse("https://example.com/inline-map.js", `code\n//# sourceMappingURL=${inlineMap}`),
        fakeResponse("https://example.com/probe.js", "probe"),
        fakeResponse("https://example.com/", "<html>", { type: "document" }),
        fakeResponse("https://example.com/missing.js", "", { status: 404 }),
      ],
      mapResponses: {
        "https://example.com/app.js.map": { status: 200, body: mapJson },
        "https://example.com/header.map": { status: 200, body: JSON.stringify({ sources: ["a"], sourcesContent: [null] }) },
        "https://example.com/x.map": new Error("network"),
        "https://example.com/probe.js.map": { status: 404, body: "" },
      },
    });
    const report = await captureMotion(input({ reduced_motion: true, scroll_steps: 3 }), deps(browser, {
      launch: async (launchOptions) => {
        calls.launchArgs = launchOptions.args;
        return browser;
      },
    }));

    expect(calls.launchArgs).toEqual(["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]);
    expect(calls.contextOptions).toMatchObject({ reducedMotion: "reduce", isMobile: false, serviceWorkers: "block" });
    expect(calls.routed).toEqual([
      { url: "https://cdn.example.com/a.js", action: "continue" },
      { url: "http://10.0.0.1/secret", action: "abort" },
    ]);
    expect(calls.samples).toEqual(["load", "load+600ms", "pointer-0", "pointer-1", "pointer-2", "pointer-3", "pointer-4", "scroll-1", "scroll-2", "scroll-3", "scroll-settled"]);
    expect(calls.wheels).toEqual([700, 700, 700]);
    expect(calls.moves).toBe(6);
    expect(calls.closed).toBe(true);

    expect(report.status).toBe("ready");
    expect(report.scripts.map((script) => script.savedAs)).toEqual([
      "bundles/00-app.js",
      "bundles/01-header.js",
      "bundles/02-x.js",
      "bundles/03-inline-map.js",
      "bundles/04-probe.js",
      "bundles/05-script.js",
    ]);
    expect(report.sourceMaps.map((map) => [map.mapUrl, map.status, map.savedSources, map.skippedLibrarySources])).toEqual([
      ["https://example.com/app.js.map", "recovered", 1, 1],
      ["https://example.com/header.map", "no-sources-content", 0, 0],
      ["https://example.com/x.map", "not-found", 0, 0],
      ["inline", "recovered", 1, 0],
    ]);
    expect(report.signatures.map((signature) => signature.library)).toEqual(expect.arrayContaining(["gsap", "lenis"]));
    expect(report.hotspots.some((hotspot) => hotspot.file === "https://example.com/#inline-0")).toBe(true);

    const dir = report.artifactDir;
    expect(dir).toBe(join(artifactRoot, "example.com-2026-10-11T12-00-00-000Z"));
    expect(await readFile(join(dir, "sources", "0", "app/src/hero.ts"), "utf8")).toBe("export const ease = 'power2.out';");
    expect(await readFile(join(dir, "sources", "3", "src/inline.ts"), "utf8")).toBe("inline source");
    expect((await readdir(join(dir, "shaders"))).sort()).toEqual(["00-fragment.glsl", "01-vertex.glsl"]);
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).reasonCode).toBe("motion.captured");
  });

  it("handles the mobile path without bundles, scrolling, or WebGL", async () => {
    const { browser, calls } = fakeBrowser();
    const report = await captureMotion(input({ viewport: "mobile", scroll_steps: 0, include_bundles: false, webgl: false }), deps(browser, {
      launch: async (launchOptions) => {
        calls.launchArgs = launchOptions.args;
        return browser;
      },
    }));
    expect(calls.launchArgs).toEqual([]);
    expect(calls.contextOptions).toMatchObject({ reducedMotion: "no-preference", isMobile: true, hasTouch: true });
    expect(calls.samples).toEqual(["load", "load+600ms"]);
    expect(calls.moves).toBe(0);
    expect(report).toMatchObject({ status: "partial", reasonCode: "motion.no_signal", scripts: [], sourceMaps: [] });
  });

  it("uses a minimum wheel distance on short pages", async () => {
    const { browser, calls } = fakeBrowser();
    await captureMotion(input({ scroll_steps: 40, include_bundles: false }), deps(browser));
    expect(new Set(calls.wheels)).toEqual(new Set([540]));
  });

  it("enforces script limits and skips unreadable bodies", async () => {
    const responses = [
      fakeResponse("https://example.com/broken.js", new Error("gone")),
      fakeResponse("https://example.com/huge.js", "x".repeat(MOTION_SCRIPT_MAX_BYTES + 1)),
      ...Array.from({ length: 6 }, (_, i) => fakeResponse(`https://example.com/big${i}.js`, "y".repeat(MOTION_SCRIPT_MAX_BYTES - 10))),
      ...Array.from({ length: MOTION_SCRIPT_LIMIT + 1 }, (_, i) => fakeResponse(`https://example.com/s${i}.js`, "z")),
    ];
    const { browser } = fakeBrowser({ responses });
    const report = await captureMotion(input({ scroll_steps: 0 }), deps(browser));
    expect(report.scripts).toHaveLength(MOTION_SCRIPT_LIMIT);
    expect(report.skippedScripts).toBe(9);
    expect(MOTION_TOTAL_SCRIPT_BYTES).toBeLessThan(6 * MOTION_SCRIPT_MAX_BYTES);
  });

  it("classifies source map failures", async () => {
    const big = "m".repeat(MOTION_SOURCE_MAP_MAX_BYTES + 1);
    const { browser } = fakeBrowser({
      responses: [
        fakeResponse("https://example.com/blocked.js", "//# sourceMappingURL=http://192.168.1.2/a.map"),
        fakeResponse("https://example.com/bad-inline.js", "//# sourceMappingURL=data:application/json,{}"),
        fakeResponse("https://example.com/large.js", "//# sourceMappingURL=large.map"),
        fakeResponse("https://example.com/notjson.js", "//# sourceMappingURL=notjson.map"),
        fakeResponse("https://example.com/nosources.js", "//# sourceMappingURL=nosources.map"),
        fakeResponse("https://example.com/missing.js", "//# sourceMappingURL=missing.map"),
        fakeResponse("https://example.com/nocontent.js", "//# sourceMappingURL=nocontent.map"),
        fakeResponse("https://example.com/probe-json.js", "a"),
        fakeResponse("https://example.com/probe-shape.js", "b"),
        fakeResponse("https://example.com/probe-error.js", "c"),
      ],
      mapResponses: {
        "https://example.com/large.map": { status: 200, body: big },
        "https://example.com/notjson.map": { status: 200, body: "not json" },
        "https://example.com/nosources.map": { status: 200, body: "{}" },
        "https://example.com/nocontent.map": { status: 200, body: "{\"sources\":[\"a.ts\"]}" },
        "https://example.com/probe-json.js.map": { status: 200, body: "<html>" },
        "https://example.com/probe-shape.js.map": { status: 200, body: "{\"mappings\":\"\"}" },
        "https://example.com/probe-error.js.map": new Error("reset"),
      },
    });
    const report = await captureMotion(input({ scroll_steps: 0 }), deps(browser));
    expect(report.sourceMaps.map((map) => [map.mapUrl, map.status])).toEqual([
      ["http://192.168.1.2/a.map", "blocked"],
      ["inline", "invalid"],
      ["https://example.com/large.map", "too-large"],
      ["https://example.com/notjson.map", "invalid"],
      ["https://example.com/nosources.map", "invalid"],
      ["https://example.com/missing.map", "not-found"],
      ["https://example.com/nocontent.map", "no-sources-content"],
    ]);
  });

  it("caps saved sources per map", async () => {
    const count = MOTION_SOURCE_FILE_LIMIT + 2;
    const map = JSON.stringify({
      sources: Array.from({ length: count }, (_, i) => `src/f${i}.ts`),
      sourcesContent: Array.from({ length: count }, () => "x"),
    });
    const { browser } = fakeBrowser({
      responses: [fakeResponse("https://example.com/many.js", "//# sourceMappingURL=many.map")],
      mapResponses: { "https://example.com/many.map": { status: 200, body: map } },
    });
    const report = await captureMotion(input({ scroll_steps: 0 }), deps(browser));
    expect(report.sourceMaps[0].savedSources).toBe(MOTION_SOURCE_FILE_LIMIT);
  });

  it("closes the browser when the capture fails", async () => {
    const { browser, calls } = fakeBrowser();
    const failing = { ...browser, newContext: async () => { throw new Error("context failed"); }, close: browser.close };
    await expect(captureMotion(input(), deps(failing))).rejects.toThrow("context failed");
    expect(calls.closed).toBe(true);
  });
});

describe("design_extract_motion tool", () => {
  let client: Client;
  const originalDeps = motionCapture.deps;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    motionCapture.deps = originalDeps;
    await client.close();
  });

  it("returns a dry-run plan for each option set", async () => {
    const full = await client.callTool({ name: "design_extract_motion", arguments: { url: "https://example.com", dry_run: true } });
    expect(full.structuredContent).toMatchObject({ status: "dry_run", reasonCode: "dry_run.capture_not_run", viewport: "desktop" });
    expect((full.structuredContent as { plannedSteps: string[] }).plannedSteps).toHaveLength(6);
    const lean = await client.callTool({
      name: "design_extract_motion",
      arguments: { url: "https://example.com", dry_run: true, viewport: "mobile", scroll_steps: 0, include_bundles: false },
    });
    expect((lean.structuredContent as { plannedSteps: string[] }).plannedSteps).toHaveLength(3);
  });

  it("rejects Awwwards and private URLs", async () => {
    for (const url of ["https://www.awwwards.com/sites/x", "http://localhost:3000"]) {
      const result = await client.callTool({ name: "design_extract_motion", arguments: { url, dry_run: true } });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toMatch(/public live site/);
    }
  });

  it("runs a capture and returns a bounded summary", async () => {
    const { browser } = fakeBrowser({ capture: richCapture() });
    motionCapture.deps = deps(browser);
    const result = await client.callTool({ name: "design_extract_motion", arguments: { url: "https://example.com", scroll_steps: 1 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "ready", shaders: 2, uniforms: ["uTime"], globals: { gsap: "3.12.5" } });
    expect((result.content as Array<{ text: string }>)[0].text).toContain("# Motion extraction: https://example.com/");
  });

  it("reports launch failures, including non-Error values", async () => {
    motionCapture.deps = deps({} as MotionBrowser, { launch: async () => { throw new Error("no chromium"); } });
    const failed = await client.callTool({ name: "design_extract_motion", arguments: { url: "https://example.com" } });
    expect((failed.content as Array<{ text: string }>)[0].text).toBe("no chromium");
    motionCapture.deps = deps({} as MotionBrowser, { launch: async () => { throw "boom"; } });
    const odd = await client.callTool({ name: "design_extract_motion", arguments: { url: "https://example.com" } });
    expect((odd.content as Array<{ text: string }>)[0].text).toBe("Error: boom");
  });
});
