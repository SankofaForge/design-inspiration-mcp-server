import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AWWWARDS_HOST,
  AWWWARDS_FETCH_TIMEOUT_MS,
  AWWWARDS_MAX_HTML_BYTES,
  CHARACTER_LIMIT,
  DESIGN_SITES,
  ExtractTokensInputSchema,
  PrepareReferencesInputSchema,
  SearchReferencesInputSchema,
  SearchStyleInputSchema,
  SOTD_QUERY,
  buildSiteQuery,
  classifyAwardPage,
  classifyAwardTier,
  filterAwwwardsImages,
  filterAwwwardsResults,
  filterSotdImages,
  filterSotdResults,
  formatSearchResults,
  formatTokens,
  isAwwwardsUrl,
  main,
  normalizeHttpUrl,
  runDembrandt,
  serperRequest,
  server,
  verifyAwwwardsSotd,
} from "./index.js";

interface ToolCallResultWithStructured<T = Record<string, unknown>> {
  content?: Array<{ type: string; text?: string;[key: string]: unknown }>;
  structuredContent?: T;
  isError?: boolean;
}

const VERIFIED_SOTD_HTML = `
  <html><head><title>Proof - Awwwards SOTD</title></head>
  <body><h2>Site of the Day - Oct 14, 2022</h2></body>
`;

function mockVerifiedSotdPage(html = VERIFIED_SOTD_HTML): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => html,
  } as unknown as Response);
}

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

describe("Awwwards source policy & helpers", () => {
  it("exposes only Awwwards as a design source", () => {
    expect(DESIGN_SITES).toEqual({ awwwards: AWWWARDS_HOST });
  });

  it("normalizes HTTP URLs correctly", () => {
    expect(normalizeHttpUrl("https://awwwards.com")).toBe("https://awwwards.com");
    expect(normalizeHttpUrl("http://awwwards.com")).toBe("http://awwwards.com");
    expect(normalizeHttpUrl("awwwards.com/sites/test")).toBe("https://awwwards.com/sites/test");
  });

  it("builds an Awwwards-only search query", () => {
    expect(buildSiteQuery("study dashboard UI design")).toBe(
      `study dashboard UI design ${SOTD_QUERY} (site:awwwards.com/sites)`
    );
    expect(() => buildSiteQuery("study dashboard UI design", "honorable-mention" as "sotd")).toThrow(
      "Unsupported Awwwards award tier"
    );
  });

  it("classifies award markers and rejects lower-tier results", () => {
    expect(classifyAwardTier({ title: "Product SOTD", snippet: "Site of the Day - Jan 1, 2026" })).toBe("sotd");
    expect(classifyAwardTier({ title: "Product", snippet: "Honorable Mention - Jan 1, 2026" })).toBe("honorable-mention");
    expect(classifyAwardTier({ title: "Product", snippet: "Nominee" })).toBe("nominee");
    expect(classifyAwardTier({ title: "Product SOTD", snippet: "Site of the Day" })).toBe("unknown");
    expect(classifyAwardTier({ title: "Product", snippet: "No award marker" })).toBe("unknown");
  });

  it("classifies the award metadata in an Awwwards page", () => {
    expect(classifyAwardPage(VERIFIED_SOTD_HTML)).toEqual({
      tier: "sotd",
      awardDate: "Oct 14, 2022",
      evidence: "Proof - Awwwards SOTD | Site of the Day - Oct 14, 2022",
    });
    expect(classifyAwardPage("<title>Memo - Awwwards Honorable Mention</title>")).toEqual({
      tier: "honorable-mention",
      evidence: "Memo - Awwwards Honorable Mention",
    });
    expect(classifyAwardPage("<title>Nominee - Awwwards</title>")).toEqual({
      tier: "nominee",
      evidence: "Nominee - Awwwards",
    });
    expect(classifyAwardPage("<title>Unverified page</title>")).toEqual({
      tier: "unknown",
      evidence: "Unverified page",
    });
    expect(classifyAwardPage('<meta property="og:title" content="Nominee - Awwwards">')).toEqual({
      tier: "nominee",
      evidence: "Nominee - Awwwards",
    });
    expect(classifyAwardPage("")).toEqual({
      tier: "unknown",
      evidence: "",
    });
  });

  it("verifies a live SOTD page and fails closed on a non-winning page", async () => {
    mockVerifiedSotdPage();
    await expect(verifyAwwwardsSotd("https://www.awwwards.com/sites/proof-1#details")).resolves.toMatchObject({
      url: "https://www.awwwards.com/sites/proof-1",
      tier: "sotd",
      awardDate: "Oct 14, 2022",
    });

    mockVerifiedSotdPage("<title>Memo - Awwwards Honorable Mention</title>");
    await expect(verifyAwwwardsSotd("https://www.awwwards.com/sites/memo")).rejects.toThrow(
      "not a verified Site of the Day winner (honorable-mention)"
    );
  });

  it("rejects non-Awwwards URLs before fetching", async () => {
    await expect(verifyAwwwardsSotd("https://example.com/sites/not-awwwards")).rejects.toThrow(
      "requires an Awwwards site URL"
    );
  });

  it("fails closed on fetch errors, redirects, oversized pages, and aborts", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    } as unknown as Response);
    await expect(verifyAwwwardsSotd("https://www.awwwards.com/sites/http-error")).rejects.toThrow("HTTP 503");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://example.com/redirected",
      text: async () => VERIFIED_SOTD_HTML,
    } as unknown as Response);
    await expect(verifyAwwwardsSotd("https://www.awwwards.com/sites/redirect")).rejects.toThrow("redirected outside Awwwards");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "x".repeat(AWWWARDS_MAX_HTML_BYTES + 1),
    } as unknown as Response);
    await expect(verifyAwwwardsSotd("https://www.awwwards.com/sites/oversized")).rejects.toThrow("exceeded");

    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(verifyAwwwardsSotd("https://www.awwwards.com/sites/aborted")).rejects.toThrow("timed out");

    globalThis.fetch = vi.fn().mockRejectedValue("network failure");
    await expect(verifyAwwwardsSotd("https://www.awwwards.com/sites/unknown-error")).rejects.toThrow("verification failed");
  });

  it("aborts a fetch when the verification timeout expires", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    const verification = verifyAwwwardsSotd("https://www.awwwards.com/sites/slow");
    const failure = expect(verification).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(AWWWARDS_FETCH_TIMEOUT_MS);
    await failure;
    vi.useRealTimers();
  });

  it("uses a bounded award verification timeout", () => {
    expect(AWWWARDS_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("keeps only Awwwards Site of the Day site pages", () => {
    expect(
      filterSotdResults([
        {
          title: "Winner SOTD",
          link: "https://www.awwwards.com/sites/winner",
          snippet: "Site of the Day - Jan 1, 2026",
          position: 1,
        },
        {
          title: "Mention",
          link: "https://www.awwwards.com/sites/mention",
          snippet: "Honorable Mention - Jan 1, 2026",
          position: 2,
        },
        {
          title: "Winner SOTD",
          link: "https://www.awwwards.com/collections/winner",
          snippet: "Site of the Day - Jan 1, 2026",
          position: 3,
        },
      ])
    ).toHaveLength(1);
  });

  it("drops style images with malformed or unselected page links", () => {
    expect(
      filterSotdImages(
        [
          { imageUrl: "https://cdn.example.com/valid.jpg", link: "https://[invalid", title: "Invalid", source: "Example" },
          { imageUrl: "https://cdn.example.com/other.jpg", link: "https://www.awwwards.com/sites/other", title: "Other", source: "Awwwards" },
        ],
        new Set(["https://www.awwwards.com/sites/selected"])
      )
    ).toEqual([]);
  });

  it("filters search responses to Awwwards page links", () => {
    expect(
      filterAwwwardsImages([
        {
          title: "Awwwards result",
          imageUrl: "https://cdn.example/awwwards-result.jpg",
          source: "Awwwards",
          link: "https://www.awwwards.com/sites/example",
        },
        {
          title: "External result",
          imageUrl: "https://cdn.example/external-result.jpg",
          source: "External",
          link: "https://example.com/design",
        },
      ])
    ).toHaveLength(1);

    expect(
      filterAwwwardsResults([
        {
          title: "Awwwards result",
          link: "https://www.awwwards.com/sites/example",
          snippet: "Awwwards page",
          position: 1,
        },
        {
          title: "External result",
          link: "https://example.com/design",
          snippet: "External page",
          position: 2,
        },
      ])
    ).toHaveLength(1);
  });

  it.each([
    "https://awwwards.com/sites/example",
    "http://awwwards.com/sites/example",
    "https://www.awwwards.com/sites/example",
    "https://subdomain.awwwards.com/sites/example",
    "awwwards.com/sites/example",
  ])("accepts an Awwwards URL: %s", (url) => {
    expect(isAwwwardsUrl(url)).toBe(true);
  });

  it.each([
    "https://dribbble.com/shots/example",
    "https://behance.net/gallery/example",
    "https://example.com/design",
    "https://awwwards.com.example.com/sites/example",
    "ftp://awwwards.com",
    "http://other.com",
    "://invalid-url",
  ])("rejects a non-Awwwards URL: %s", (url) => {
    expect(isAwwwardsUrl(url)).toBe(false);
  });

  it("handles catch block in isAwwwardsUrl on malformed input", () => {
    expect(isAwwwardsUrl("http://[invalid-ipv6-host")).toBe(false);
  });
});

describe("Formatting helpers", () => {
  it("formats search results with empty array", () => {
    expect(formatSearchResults([], "empty")).toBe('No results found for "empty".');
  });

  it("formats search results correctly", () => {
    const formatted = formatSearchResults(
      [
        {
          title: "Reference 1",
          snippet: "Snippet text",
          link: "https://awwwards.com/sites/1",
          position: 1,
        },
      ],
      "ref"
    );
    expect(formatted).toContain("# Design References: \"ref\"");
    expect(formatted).toContain("Snippet text");
  });

  it("truncates long search results exceeding CHARACTER_LIMIT", () => {
    const longList = Array.from({ length: 300 }, (_, i) => ({
      title: `Reference ${i}`,
      snippet: "y".repeat(200),
      link: `https://awwwards.com/sites/${i}`,
      position: i + 1,
    }));
    const formatted = formatSearchResults(longList, "long");
    expect(formatted.length).toBeLessThanOrEqual(CHARACTER_LIMIT + 50);
    expect(formatted).toContain("...(truncated, use fewer results)");
  });

  it("formats design tokens across all standard and custom sections", () => {
    const tokens = {
      colors: {
        primary: "#123456",
        palette: { dark: "#000000", light: "#ffffff" },
        unavailable: null,
      },
      typography: {
        heading: "Inter 24px",
        scale: { h1: "32px", h2: "24px" },
        unavailable: null,
      },
      spacing: {
        sm: "8px",
        md: { value: 16, unit: "px" },
      },
      borders: {
        thin: "1px solid #ccc",
      },
      shadows: {
        elevated: "0 4px 6px rgba(0,0,0,0.1)",
      },
      animations: {
        fade: "ease-in 300ms",
        bounce: { duration: 500 },
      },
      customString: "custom-value",
      emptySection: null,
      undefinedSection: undefined,
    };
    const formatted = formatTokens(tokens, "https://awwwards.com/sites/test");
    expect(formatted).toContain("# Design Tokens: https://awwwards.com/sites/test");
    expect(formatted).toContain("## Colors");
    expect(formatted).toContain("- **primary**: `#123456`");
    expect(formatted).toContain("## Typography");
    expect(formatted).toContain("## Spacing");
    expect(formatted).toContain("## Borders");
    expect(formatted).toContain("## Shadows");
    expect(formatted).toContain("## Animations");
    expect(formatted).toContain("- **fade**: `ease-in 300ms`");
    expect(formatted).toContain("## CustomString");
    expect(formatted).toContain("- \"custom-value\"");
  });

  it("truncates design tokens exceeding CHARACTER_LIMIT", () => {
    const tokens = {
      colors: Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [`color_${i}`, "rgba(100, 100, 100, 0.5) " + "c".repeat(50)])
      ),
    };
    const formatted = formatTokens(tokens, "https://awwwards.com/sites/test");
    expect(formatted.length).toBeLessThanOrEqual(CHARACTER_LIMIT + 50);
    expect(formatted).toContain("...(truncated)");
  });

  it("skips empty token sections", () => {
    const formatted = formatTokens(
      { colors: {}, typography: {} },
      "https://awwwards.com/sites/empty"
    );

    expect(formatted).toBe("# Design Tokens: https://awwwards.com/sites/empty\n");
    expect(formatted).not.toContain("## Colors");
    expect(formatted).not.toContain("## Typography");
  });
});

describe("serperRequest", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("throws when SERPER_API_KEY is missing", async () => {
    delete process.env.SERPER_API_KEY;
    await expect(serperRequest("/search", { q: "test" })).rejects.toThrow(
      "SERPER_API_KEY environment variable is required"
    );
  });

  it("throws on 401 response", async () => {
    process.env.SERPER_API_KEY = "dummy-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    } as unknown as Response);

    await expect(serperRequest("/search", { q: "test" })).rejects.toThrow(
      "Error: Invalid SERPER_API_KEY"
    );
  });

  it("throws on 429 response", async () => {
    process.env.SERPER_API_KEY = "dummy-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    } as unknown as Response);

    await expect(serperRequest("/search", { q: "test" })).rejects.toThrow(
      "Error: Rate limit exceeded"
    );
  });

  it("throws on other error statuses", async () => {
    process.env.SERPER_API_KEY = "dummy-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as unknown as Response);

    await expect(serperRequest("/search", { q: "test" })).rejects.toThrow(
      "Error: Serper API returned status 500"
    );
  });

  it("returns parsed JSON on success", async () => {
    process.env.SERPER_API_KEY = "dummy-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: ["ok"] }),
    } as unknown as Response);

    const data = await serperRequest<{ results: string[] }>("/search", { q: "test" });
    expect(data).toEqual({ results: ["ok"] });
  });
});

describe("runDembrandt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves stdout on successful execution", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback?.(null, '{"colors":{"primary":"#fff"}}', "");
      return {} as unknown as childProcess.ChildProcess;
    });

    const result = await runDembrandt("https://awwwards.com/sites/test", ["--mobile"]);
    expect(result).toBe('{"colors":{"primary":"#fff"}}');
  });

  it("rejects with timeout error when killed", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const error = Object.assign(new Error("Command failed"), { killed: true, cmd: "dembrandt" }) as childProcess.ExecException;
      callback?.(error, "", "");
      return {} as unknown as childProcess.ChildProcess;
    });

    await expect(runDembrandt("https://awwwards.com/sites/test", [])).rejects.toThrow(
      "Timed out after 60s"
    );
  });

  it("rejects with unresolved name error", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const error = Object.assign(new Error("net::ERR_NAME_NOT_RESOLVED"), { cmd: "dembrandt" }) as childProcess.ExecException;
      callback?.(error, "", "net::ERR_NAME_NOT_RESOLVED");
      return {} as unknown as childProcess.ChildProcess;
    });

    await expect(runDembrandt("https://awwwards.com/sites/test", [])).rejects.toThrow(
      "Could not resolve URL: https://awwwards.com/sites/test"
    );
  });

  it("rejects with connection refused error", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const error = Object.assign(new Error("net::ERR_CONNECTION_REFUSED"), { cmd: "dembrandt" }) as childProcess.ExecException;
      callback?.(error, "", "net::ERR_CONNECTION_REFUSED");
      return {} as unknown as childProcess.ChildProcess;
    });

    await expect(runDembrandt("https://awwwards.com/sites/test", [])).rejects.toThrow(
      "Connection refused: https://awwwards.com/sites/test"
    );
  });

  it("rejects with general error message when stderr is empty", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const error = Object.assign(new Error("General crash"), { cmd: "dembrandt" }) as childProcess.ExecException;
      callback?.(error, "", "");
      return {} as unknown as childProcess.ChildProcess;
    });

    await expect(runDembrandt("https://awwwards.com/sites/test", [])).rejects.toThrow(
      "dembrandt failed: General crash"
    );
  });
});

describe("Schema validations", () => {
  it("validates SearchReferencesInputSchema", () => {
    expect(SearchReferencesInputSchema.safeParse({ query: "a" }).success).toBe(false);
    expect(SearchReferencesInputSchema.safeParse({ query: "valid reference", num: 5 }).success).toBe(true);
  });

  it("validates SearchStyleInputSchema", () => {
    expect(SearchStyleInputSchema.safeParse({ style: "a" }).success).toBe(false);
    expect(SearchStyleInputSchema.safeParse({ style: "minimal", type: "invalid" }).success).toBe(false);
    expect(
      SearchStyleInputSchema.safeParse({ style: "minimalist", type: "color-palette", num: 15 }).success
    ).toBe(true);
  });

  it("validates ExtractTokensInputSchema", () => {
    expect(ExtractTokensInputSchema.safeParse({ url: "https://example.com" }).success).toBe(false);
    expect(ExtractTokensInputSchema.safeParse({ url: "https://awwwards.com/sites/test" }).success).toBe(true);
  });

  it("validates PrepareReferencesInputSchema and AssetRequirementSchema", () => {
    // 2d asset without animation
    expect(
      PrepareReferencesInputSchema.safeParse({
        references: [
          {
            url: "https://awwwards.com/sites/test",
            role: "hero",
            captureName: "hero-capture",
            assetRequirements: [
              {
                id: "asset-1",
                kind: "animated-svg",
                role: "hero svg",
                preferredFormats: ["svg"],
                delivery: "web",
              },
            ],
          },
        ],
      }).success
    ).toBe(false);

    // animated-svg without svg/lottie/dotlottie formats
    expect(
      PrepareReferencesInputSchema.safeParse({
        references: [
          {
            url: "https://awwwards.com/sites/test",
            role: "hero",
            captureName: "hero-capture",
            assetRequirements: [
              {
                id: "asset-1",
                kind: "animated-svg",
                role: "hero svg",
                preferredFormats: ["glb"],
                delivery: "web",
                animation: { durationMs: 1000 },
              },
            ],
          },
        ],
      }).success
    ).toBe(false);

    // lottie without lottie/dotlottie formats
    expect(
      PrepareReferencesInputSchema.safeParse({
        references: [
          {
            url: "https://awwwards.com/sites/test",
            role: "hero",
            captureName: "hero-capture",
            assetRequirements: [
              {
                id: "asset-1",
                kind: "lottie",
                role: "hero lottie",
                preferredFormats: ["png"],
                delivery: "web",
                animation: { durationMs: 1000 },
              },
            ],
          },
        ],
      }).success
    ).toBe(false);

    // 3d asset with non-blender tool
    expect(
      PrepareReferencesInputSchema.safeParse({
        references: [
          {
            url: "https://awwwards.com/sites/test",
            role: "hero",
            captureName: "hero-capture",
            assetRequirements: [
              {
                id: "asset-1",
                kind: "3d-model",
                role: "hero 3d",
                preferredTool: "svgator",
                preferredFormats: ["glb"],
                delivery: "web",
              },
            ],
          },
        ],
      }).success
    ).toBe(false);

    // 2d asset with blender tool
    expect(
      PrepareReferencesInputSchema.safeParse({
        references: [
          {
            url: "https://awwwards.com/sites/test",
            role: "hero",
            captureName: "hero-capture",
            assetRequirements: [
              {
                id: "asset-1",
                kind: "animated-svg",
                role: "hero svg",
                preferredTool: "blender",
                preferredFormats: ["svg"],
                delivery: "web",
                animation: { durationMs: 1000 },
              },
            ],
          },
        ],
      }).success
    ).toBe(false);

    // duplicate asset IDs
    expect(
      PrepareReferencesInputSchema.safeParse({
        references: [
          {
            url: "https://awwwards.com/sites/test",
            role: "hero",
            captureName: "hero-capture",
            assetRequirements: [
              {
                id: "asset-1",
                kind: "3d-model",
                role: "hero 3d",
                preferredTool: "blender",
                preferredFormats: ["glb"],
                delivery: "web",
              },
              {
                id: "asset-1",
                kind: "3d-render",
                role: "hero 3d render",
                preferredFormats: ["png"],
                delivery: "web",
              },
            ],
          },
        ],
      }).success
    ).toBe(false);
  });

  it("requires distinct live-site URLs and capture names under the capture contract", () => {
    const base = {
      url: "https://awwwards.com/sites/test",
      role: "hero",
      captureName: "hero-capture",
      liveUrl: "https://example.com/hero",
    };
    expect(PrepareReferencesInputSchema.safeParse({ references: [{ ...base, liveUrl: "https://awwwards.com/sites/live" }] }).success).toBe(false);
    expect(PrepareReferencesInputSchema.safeParse({ references: [{ ...base, liveUrl: "ftp://example.com/hero" }] }).success).toBe(false);
    expect(PrepareReferencesInputSchema.safeParse({ references: [{ ...base, liveUrl: "https://example.com/hero" }, { ...base, captureName: "other", liveUrl: "https://example.com/hero" }] }).success).toBe(false);
    expect(PrepareReferencesInputSchema.safeParse({ references: [{ ...base }, { ...base, captureName: "other", liveUrl: "https://example.com/other" }] }).success).toBe(true);
    expect(PrepareReferencesInputSchema.safeParse({ references: [{ ...base, captureName: "a".repeat(82) }] }).success).toBe(false);
    expect(PrepareReferencesInputSchema.safeParse({ references: [{ ...base, captureName: "a".repeat(81) }] }).success).toBe(true);
  });
});

describe("Server request routing & tool execution via MCP client", () => {
  let client: Client;

  beforeEach(async () => {
    process.env.SERPER_API_KEY = "test-serper-key";
    mockVerifiedSotdPage();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    vi.restoreAllMocks();
  });

  it("lists all registered tools", async () => {
    const list = await client.listTools();
    const toolNames = list.tools.map((t) => t.name);
    expect(toolNames).toEqual([
      "design_search_references",
      "design_search_styles",
      "design_extract_tokens",
      "design_prepare_references",
    ]);
  });

  it("executes design_search_references tool successfully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        organic: [
          {
            title: "Awwwards SOTD Reference",
            link: "https://www.awwwards.com/sites/ref1",
            snippet: "Site of the Day - Jan 1, 2026. Reference snippet",
            position: 1,
          },
        ],
      }),
    } as unknown as Response);

    const res = await client.callTool({
      name: "design_search_references",
      arguments: { query: "design system", num: 5 },
    });

    const structured = (res as ToolCallResultWithStructured<{ count: number; results: Array<{ title: string }> }>).structuredContent!;
    expect(structured.count).toBe(1);
    expect(structured.results[0].title).toBe("Awwwards SOTD Reference");
  });

  it("handles error in design_search_references", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Serper search failed"));

    const res = await client.callTool({
      name: "design_search_references",
      arguments: { query: "design system", num: 5 },
    });

    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Serper search failed");
    expect((res as ToolCallResultWithStructured).isError).toBe(true);
  });

  it.each(["color-palette", "typography", "layout", "animation", "general"] as const)(
    "executes design_search_styles with type: %s",
    async (type) => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/images")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              images: [
                {
                  title: "Style Image",
                  imageUrl: "https://awwwards.com/img.jpg",
                  source: "Awwwards",
                  link: "https://www.awwwards.com/sites/style-ref",
                },
              ],
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            organic: [
              {
                title: "Style Reference",
                link: "https://www.awwwards.com/sites/style-ref",
                snippet: "Site of the Day - Jan 1, 2026. Style snippet",
                position: 1,
              },
            ],
          }),
        } as unknown as Response);
      });

      const res = await client.callTool({
        name: "design_search_styles",
        arguments: { style: "brutalist", type, num: 5 },
      });

      const structured = (res as ToolCallResultWithStructured<{ style: string; type: string; images: unknown[]; references: unknown[] }>).structuredContent!;
      expect(structured.style).toBe("brutalist");
      expect(structured.type).toBe(type);
      expect(structured.images).toHaveLength(1);
      expect(structured.references).toHaveLength(1);
    }
  );

  it("handles truncation in design_search_styles", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/images")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            images: Array.from({ length: 5 }, (_, i) => ({
              title: "Style Image " + "x".repeat(3000),
              imageUrl: `https://awwwards.com/${i}.jpg`,
              source: "Awwwards",
              link: `https://www.awwwards.com/sites/${i}`,
            })),
          }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          organic: Array.from({ length: 10 }, (_, i) => ({
            title: "Style Reference " + i,
            link: `https://www.awwwards.com/sites/ref-${i}`,
            snippet: "Site of the Day - Jan 1, 2026. " + "s".repeat(3000),
            position: i + 1,
          })),
        }),
      } as unknown as Response);
    });

    const res = await client.callTool({
      name: "design_search_styles",
      arguments: { style: "maximalist", type: "general", num: 10 },
    });

    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toContain("...(truncated)");
  });

  it("handles error in design_search_styles", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Styles search error"));

    const res = await client.callTool({
      name: "design_search_styles",
      arguments: { style: "glassmorphism", type: "general" },
    });

    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Styles search error");
    expect((res as ToolCallResultWithStructured).isError).toBe(true);
  });

  it("executes design_extract_tokens successfully", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback?.(null, JSON.stringify({ colors: { bg: "#000" }, spacing: { lg: "24px" } }), "");
      return {} as unknown as childProcess.ChildProcess;
    });

    const res = await client.callTool({
      name: "design_extract_tokens",
      arguments: { url: "https://www.awwwards.com/sites/portfolio", dark_mode: true, mobile: true },
    });

    const structured = (res as ToolCallResultWithStructured<{ dark_mode: boolean; mobile: boolean; tokens: { colors: { bg: string } } }>).structuredContent!;
    expect(structured.dark_mode).toBe(true);
    expect(structured.mobile).toBe(true);
    expect(structured.tokens.colors.bg).toBe("#000");
  });

  it("handles error in design_extract_tokens", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const error = Object.assign(new Error("dembrandt binary missing"), { cmd: "dembrandt" }) as childProcess.ExecException;
      callback?.(error, "", "");
      return {} as unknown as childProcess.ChildProcess;
    });

    const res = await client.callTool({
      name: "design_extract_tokens",
      arguments: { url: "https://www.awwwards.com/sites/portfolio" },
    });

    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toContain("dembrandt failed: dembrandt binary missing");
    expect((res as ToolCallResultWithStructured).isError).toBe(true);
  });

  it("handles non-Error thrown in design_search_references", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue("search-failure-string");

    const res = await client.callTool({
      name: "design_search_references",
      arguments: { query: "design system", num: 5 },
    });

    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toBe("Error: search-failure-string");
    expect((res as ToolCallResultWithStructured).isError).toBe(true);
  });

  it("handles missing images and organic arrays gracefully in search tools", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const refRes = await client.callTool({
      name: "design_search_references",
      arguments: { query: "missing-refs", num: 5 },
    });
    expect((refRes as ToolCallResultWithStructured<{ count: number }>).structuredContent?.count).toBe(0);

    const styleRes = await client.callTool({
      name: "design_search_styles",
      arguments: { style: "missing-styles", type: "general", num: 5 },
    });
    expect((styleRes as ToolCallResultWithStructured<{ images: unknown[]; references: unknown[] }>).structuredContent?.images).toEqual([]);
    expect((styleRes as ToolCallResultWithStructured<{ images: unknown[]; references: unknown[] }>).structuredContent?.references).toEqual([]);
  });

  it("handles non-Error thrown in design_search_styles", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue("styles-string-error");

    const res = await client.callTool({
      name: "design_search_styles",
      arguments: { style: "glassmorphism", type: "general" },
    });

    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toBe("Error: styles-string-error");
    expect((res as ToolCallResultWithStructured).isError).toBe(true);
  });

  it("handles non-Error thrown in design_extract_tokens", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation(() => {
      throw "string-dembrandt-error";
    });

    const res = await client.callTool({
      name: "design_extract_tokens",
      arguments: { url: "https://www.awwwards.com/sites/portfolio" },
    });

    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toBe("Error: string-dembrandt-error");
    expect((res as ToolCallResultWithStructured).isError).toBe(true);
  });

  it("executes design_prepare_references with empty asset plan", async () => {
    const res = await client.callTool({
      name: "design_prepare_references",
      arguments: {
        references: [
          {
            url: "https://www.awwwards.com/sites/ref-no-assets",
            role: "reference without assets",
            captureName: "no-assets-ref",
            liveUrl: "https://example.com/no-assets",
            requires3d: false,
            assetRequirements: [],
          },
        ],
      },
    });

    const structured = (res as ToolCallResultWithStructured<{ count: number; references: Array<{ awardVerification: { tier: string; awardDate?: string } }>; assetPlan: unknown[] }>).structuredContent!;
    expect(structured.count).toBe(1);
    expect(structured.references[0].awardVerification).toEqual({
      tier: "sotd",
      awardDate: "Oct 14, 2022",
      evidence: "Proof - Awwwards SOTD | Site of the Day - Oct 14, 2022",
      url: "https://www.awwwards.com/sites/ref-no-assets",
    });
    expect(structured.assetPlan).toHaveLength(0);
    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Prepared 1 reference.");
    expect(text).not.toContain("## Asset plan");
  });

  it("fails preparation when the selected page is not an SOTD winner", async () => {
    mockVerifiedSotdPage("<title>Memo - Awwwards Honorable Mention</title>");

    const res = await client.callTool({
      name: "design_prepare_references",
      arguments: {
        references: [
          {
            url: "https://www.awwwards.com/sites/memo",
            role: "hero reference",
            captureName: "hero-reference",
            liveUrl: "https://example.com/hero",
          },
        ],
      },
    });

    expect((res as ToolCallResultWithStructured).isError).toBe(true);
    expect(((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text).toContain(
      "not a verified Site of the Day winner (honorable-mention)"
    );
  });

  it("executes design_prepare_references with single reference and auto-generated 3d", async () => {
    const res = await client.callTool({
      name: "design_prepare_references",
      arguments: {
        references: [
          {
            url: "https://www.awwwards.com/sites/ref-3d#hash-to-strip",
            role: "hero 3d element",
            captureName: "hero-3d",
            liveUrl: "https://example.com/hero-3d",
            requires3d: true,
          },
        ],
      },
    });

    const structured = (res as ToolCallResultWithStructured<{ count: number; references: Array<{ url: string }>; assetPlan: Array<{ route: string; outputs: string[] }> }>).structuredContent!;
    expect(structured.count).toBe(1);
    expect(structured.references[0].url).toBe("https://www.awwwards.com/sites/ref-3d");
    expect(structured.assetPlan[0].route).toBe("blender");
    expect(structured.assetPlan[0].outputs).toEqual(["glb", "png"]);
    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Prepared 1 reference.");
    expect(text).toContain("## Asset plan");
  });

  it("routes a complex Lottie request to explicitly preferred SVGator", async () => {
    const asset = {
      id: "hero-origami-bird",
      kind: "lottie",
      role: "Complex vector illustration with articulated wings and feather morphs",
      preferredTool: "svgator",
      preferredFormats: ["lottie", "svg"],
      delivery: "web",
      animation: { durationMs: 2400, loop: false, trigger: "in-view", reducedMotion: "static" },
      performanceBudget: { maxFileKb: 150, maxPaths: 120, maxFps: 60 },
    };
    const res = await client.callTool({
      name: "design_prepare_references",
      arguments: {
        references: [{
          url: "https://www.awwwards.com/sites/ref-2d",
          role: "hero motion",
          captureName: "hero-motion",
          liveUrl: "https://example.com/hero-motion",
          assetRequirements: [asset],
        }],
      },
    });

    expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
    const structured = (res as ToolCallResultWithStructured<{ assetPlan: Array<{ assetId: string; route: string; outputs: string[]; asset: typeof asset }> }>).structuredContent!;
    expect(structured.assetPlan).toHaveLength(1);
    expect(structured.assetPlan[0]).toMatchObject({
      assetId: asset.id,
      route: "svgator",
      outputs: ["lottie", "svg"],
      asset,
      sourceReference: "https://www.awwwards.com/sites/ref-2d",
      liveSiteUrl: "https://example.com/hero-motion",
    });
  });

  it("executes design_prepare_references with multiple references and 2D assets", async () => {
    const res = await client.callTool({
      name: "design_prepare_references",
      arguments: {
        references: [
          {
            url: "https://www.awwwards.com/sites/ref-2d",
            role: "navigation motion",
            captureName: "nav-motion",
            liveUrl: "https://example.com/nav-motion",
            extractTokens: true,
            assetRequirements: [
              {
                id: "nav-lottie",
                kind: "lottie",
                role: "lottie icon",
                preferredFormats: ["lottie"],
                delivery: "web",
                animation: { durationMs: 500 },
              },
              {
                id: "nav-svg",
                kind: "animated-svg",
                role: "svg icon",
                preferredFormats: ["svg"],
                delivery: "web",
                animation: { durationMs: 500 },
              },
            ],
          },
          {
            url: "https://www.awwwards.com/sites/ref-simple",
            role: "simple reference",
            captureName: "simple-ref",
            liveUrl: "https://example.com/simple-ref",
            requires3d: false,
          },
        ],
      },
    });

    const structured = (res as ToolCallResultWithStructured<{ count: number; assetPlan: Array<{ route: string }> }>).structuredContent!;
    expect(structured.count).toBe(2);
    expect(structured.assetPlan).toHaveLength(2);
    expect(structured.assetPlan[0].route).toBe("lottie-creator");
    expect(structured.assetPlan[1].route).toBe("svgator");
    const text = ((res as ToolCallResultWithStructured).content?.[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Prepared 2 references.");
  });
});

describe("main entrypoint execution", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.spyOn(console, "error").mockImplementation(() => { });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("runs main when SERPER_API_KEY is not set", async () => {
    delete process.env.SERPER_API_KEY;
    const connectSpy = vi.spyOn(server, "connect").mockResolvedValue(undefined as never);

    await main();

    expect(connectSpy).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("WARNING: SERPER_API_KEY not set")
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Design Inspiration MCP server running on stdio")
    );
  });

  it("runs main when SERPER_API_KEY is set", async () => {
    process.env.SERPER_API_KEY = "valid-key";
    const connectSpy = vi.spyOn(server, "connect").mockResolvedValue(undefined as never);

    await main();

    expect(connectSpy).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("WARNING: SERPER_API_KEY not set")
    );
  });
});
