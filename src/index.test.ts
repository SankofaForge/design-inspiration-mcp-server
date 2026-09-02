import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AWWWARDS_HOST,
  CHARACTER_LIMIT,
  DESIGN_SITES,
  ExtractTokensInputSchema,
  PrepareReferencesInputSchema,
  SearchImagesInputSchema,
  SearchReferencesInputSchema,
  SearchStyleInputSchema,
  buildSiteQuery,
  filterAwwwardsImages,
  filterAwwwardsResults,
  formatImageResults,
  formatSearchResults,
  formatTokens,
  isAwwwardsUrl,
  main,
  normalizeHttpUrl,
  runDembrandt,
  serperRequest,
  server,
} from "./index.js";

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
      "study dashboard UI design (site:awwwards.com)"
    );
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
  it("formats image results with empty array", () => {
    expect(formatImageResults([], "minimal")).toBe('No design inspiration found for "minimal".');
  });

  it("formats image results with and without dimensions", () => {
    const formatted = formatImageResults(
      [
        {
          title: "Sample 1",
          source: "Awwwards",
          imageUrl: "https://awwwards.com/1.jpg",
          link: "https://awwwards.com/sites/1",
          imageWidth: 800,
          imageHeight: 600,
        },
        {
          title: "Sample 2",
          source: "Awwwards",
          imageUrl: "https://awwwards.com/2.jpg",
          link: "https://awwwards.com/sites/2",
        },
      ],
      "dashboard"
    );
    expect(formatted).toContain("# Design Inspiration: \"dashboard\"");
    expect(formatted).toContain("- **Size**: 800x600");
    expect(formatted).toContain("## Sample 2");
  });

  it("truncates long image results exceeding CHARACTER_LIMIT", () => {
    const longList = Array.from({ length: 500 }, (_, i) => ({
      title: `Item ${i} ` + "x".repeat(100),
      source: "Awwwards",
      imageUrl: `https://awwwards.com/${i}.jpg`,
      link: `https://awwwards.com/sites/${i}`,
    }));
    const formatted = formatImageResults(longList, "many");
    expect(formatted.length).toBeLessThanOrEqual(CHARACTER_LIMIT + 50);
    expect(formatted).toContain("...(truncated, use fewer results)");
  });

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
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
      callback(null, '{"colors":{"primary":"#fff"}}', "");
      return {} as any;
    });

    const result = await runDembrandt("https://awwwards.com/sites/test", ["--mobile"]);
    expect(result).toBe('{"colors":{"primary":"#fff"}}');
  });

  it("rejects with timeout error when killed", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
      const error: any = new Error("Command failed");
      error.killed = true;
      callback(error, "", "");
      return {} as any;
    });

    await expect(runDembrandt("https://awwwards.com/sites/test", [])).rejects.toThrow(
      "Timed out after 60s"
    );
  });

  it("rejects with unresolved name error", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
      const error = new Error("net::ERR_NAME_NOT_RESOLVED");
      callback(error, "", "net::ERR_NAME_NOT_RESOLVED");
      return {} as any;
    });

    await expect(runDembrandt("https://awwwards.com/sites/test", [])).rejects.toThrow(
      "Could not resolve URL: https://awwwards.com/sites/test"
    );
  });

  it("rejects with connection refused error", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
      const error = new Error("net::ERR_CONNECTION_REFUSED");
      callback(error, "", "net::ERR_CONNECTION_REFUSED");
      return {} as any;
    });

    await expect(runDembrandt("https://awwwards.com/sites/test", [])).rejects.toThrow(
      "Connection refused: https://awwwards.com/sites/test"
    );
  });

  it("rejects with general error message when stderr is empty", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
      const error = new Error("General crash");
      callback(error, "", "");
      return {} as any;
    });

    await expect(runDembrandt("https://awwwards.com/sites/test", [])).rejects.toThrow(
      "dembrandt failed: General crash"
    );
  });
});

describe("Schema validations", () => {
  it("validates SearchImagesInputSchema", () => {
    expect(SearchImagesInputSchema.safeParse({ query: "a" }).success).toBe(false);
    expect(SearchImagesInputSchema.safeParse({ query: "ok", num: 50 }).success).toBe(false);
    expect(SearchImagesInputSchema.safeParse({ query: "valid query", num: 10 }).success).toBe(true);
  });

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
});

describe("Server request routing & tool execution via MCP client", () => {
  let client: Client;

  beforeEach(async () => {
    process.env.SERPER_API_KEY = "test-serper-key";
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
    expect(toolNames).toContain("design_search_images");
    expect(toolNames).toContain("design_search_references");
    expect(toolNames).toContain("design_search_styles");
    expect(toolNames).toContain("design_extract_tokens");
    expect(toolNames).toContain("design_prepare_references");
  });

  it("executes design_search_images tool successfully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        images: [
          {
            title: "Awwwards Dashboard",
            imageUrl: "https://awwwards.com/img1.png",
            thumbnailUrl: "https://awwwards.com/thumb1.png",
            source: "Awwwards",
            link: "https://www.awwwards.com/sites/sample",
            imageWidth: 1200,
            imageHeight: 800,
          },
        ],
      }),
    } as unknown as Response);

    const res = await client.callTool({
      name: "design_search_images",
      arguments: { query: "dashboard", num: 5 },
    });

    const structured = (res as any).structuredContent;
    expect(structured.count).toBe(1);
    expect(structured.images[0].title).toBe("Awwwards Dashboard");
  });

  it("handles error in design_search_images", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Serper network error"));

    const res = await client.callTool({
      name: "design_search_images",
      arguments: { query: "dashboard", num: 5 },
    });

    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Serper network error");
  });

  it("handles non-Error thrown in design_search_images", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue("string-rejection");

    const res = await client.callTool({
      name: "design_search_images",
      arguments: { query: "dashboard", num: 5 },
    });

    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("Error: string-rejection");
  });

  it("executes design_search_references tool successfully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        organic: [
          {
            title: "Awwwards Reference",
            link: "https://www.awwwards.com/sites/ref1",
            snippet: "Reference snippet",
            position: 1,
          },
        ],
      }),
    } as unknown as Response);

    const res = await client.callTool({
      name: "design_search_references",
      arguments: { query: "design system", num: 5 },
    });

    const structured = (res as any).structuredContent;
    expect(structured.count).toBe(1);
    expect(structured.results[0].title).toBe("Awwwards Reference");
  });

  it("handles error in design_search_references", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Serper search failed"));

    const res = await client.callTool({
      name: "design_search_references",
      arguments: { query: "design system", num: 5 },
    });

    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Serper search failed");
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
                  link: "https://www.awwwards.com/sites/style",
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
                snippet: "Style snippet",
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

      const structured = (res as any).structuredContent;
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
            snippet: "s".repeat(3000),
            position: i + 1,
          })),
        }),
      } as unknown as Response);
    });

    const res = await client.callTool({
      name: "design_search_styles",
      arguments: { style: "maximalist", type: "general", num: 10 },
    });

    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("...(truncated)");
  });

  it("handles error in design_search_styles", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Styles search error"));

    const res = await client.callTool({
      name: "design_search_styles",
      arguments: { style: "glassmorphism", type: "general" },
    });

    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Styles search error");
  });

  it("executes design_extract_tokens successfully", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
      callback(null, JSON.stringify({ colors: { bg: "#000" }, spacing: { lg: "24px" } }), "");
      return {} as any;
    });

    const res = await client.callTool({
      name: "design_extract_tokens",
      arguments: { url: "https://www.awwwards.com/sites/portfolio", dark_mode: true, mobile: true },
    });

    const structured = (res as any).structuredContent;
    expect(structured.dark_mode).toBe(true);
    expect(structured.mobile).toBe(true);
    expect(structured.tokens.colors.bg).toBe("#000");
  });

  it("handles error in design_extract_tokens", async () => {
    const mockedExecFile = vi.mocked(childProcess.execFile);
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
      callback(new Error("dembrandt binary missing"), "", "");
      return {} as any;
    });

    const res = await client.callTool({
      name: "design_extract_tokens",
      arguments: { url: "https://www.awwwards.com/sites/portfolio" },
    });

    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("dembrandt failed: dembrandt binary missing");
  });

  it("handles non-Error thrown in design_search_references", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue("search-failure-string");

    const res = await client.callTool({
      name: "design_search_references",
      arguments: { query: "design system", num: 5 },
    });

    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("Error: search-failure-string");
  });

  it("handles missing images and organic arrays gracefully in search tools", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const imgRes = await client.callTool({
      name: "design_search_images",
      arguments: { query: "missing-images", num: 5 },
    });
    expect((imgRes as any).structuredContent.count).toBe(0);

    const refRes = await client.callTool({
      name: "design_search_references",
      arguments: { query: "missing-refs", num: 5 },
    });
    expect((refRes as any).structuredContent.count).toBe(0);

    const styleRes = await client.callTool({
      name: "design_search_styles",
      arguments: { style: "missing-styles", type: "general", num: 5 },
    });
    expect((styleRes as any).structuredContent.images).toEqual([]);
    expect((styleRes as any).structuredContent.references).toEqual([]);
  });

  it("handles non-Error thrown in design_search_styles", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue("styles-string-error");

    const res = await client.callTool({
      name: "design_search_styles",
      arguments: { style: "glassmorphism", type: "general" },
    });

    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("Error: styles-string-error");
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

    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("Error: string-dembrandt-error");
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
            requires3d: false,
            assetRequirements: [],
          },
        ],
      },
    });

    const structured = (res as any).structuredContent;
    expect(structured.count).toBe(1);
    expect(structured.assetPlan).toHaveLength(0);
    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Prepared 1 reference.");
    expect(text).not.toContain("## Asset plan");
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
            requires3d: true,
          },
        ],
      },
    });

    const structured = (res as any).structuredContent;
    expect(structured.count).toBe(1);
    expect(structured.references[0].url).toBe("https://www.awwwards.com/sites/ref-3d");
    expect(structured.assetPlan[0].route).toBe("blender");
    expect(structured.assetPlan[0].outputs).toEqual(["glb", "png"]);
    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Prepared 1 reference.");
    expect(text).toContain("## Asset plan");
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
            requires3d: false,
          },
        ],
      },
    });

    const structured = (res as any).structuredContent;
    expect(structured.count).toBe(2);
    expect(structured.assetPlan).toHaveLength(2);
    expect(structured.assetPlan[0].route).toBe("lottie-creator");
    expect(structured.assetPlan[1].route).toBe("svgator");
    const text = ((res as any).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Prepared 2 references.");
  });
});

describe("main entrypoint execution", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.spyOn(console, "error").mockImplementation(() => {});
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
