#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const SERPER_API_URL = "https://google.serper.dev";
export const CHARACTER_LIMIT = 25000;
export const AWWWARDS_HOST = "awwwards.com";

export const DESIGN_SITES = {
  awwwards: "awwwards.com",
} as const;

export type DesignSite = keyof typeof DESIGN_SITES;

export function normalizeHttpUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function isAwwwardsUrl(value: string): boolean {
  try {
    const url = new URL(normalizeHttpUrl(value));
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === AWWWARDS_HOST || url.hostname.endsWith(`.${AWWWARDS_HOST}`))
    );
  } catch {
    return false;
  }
}

export async function serperRequest<T>(
  endpoint: string,
  body: Record<string, unknown>
): Promise<T> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SERPER_API_KEY environment variable is required. Get one free at https://serper.dev"
    );
  }

  const response = await fetch(`${SERPER_API_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const status = response.status;
    if (status === 401)
      throw new Error("Error: Invalid SERPER_API_KEY. Check your key at https://serper.dev/api-key");
    if (status === 429)
      throw new Error("Error: Rate limit exceeded. Wait before making more requests.");
    throw new Error(`Error: Serper API returned status ${status}`);
  }

  return response.json() as Promise<T>;
}

export interface SerperImage {
  title: string;
  imageUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  thumbnailUrl?: string;
  source: string;
  link: string;
}

export interface SerperImagesResponse {
  images: SerperImage[];
  searchParameters?: Record<string, unknown>;
}

export interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export interface SerperSearchResponse {
  organic: SerperOrganicResult[];
  searchParameters?: Record<string, unknown>;
}

export function filterAwwwardsImages(images: SerperImage[]): SerperImage[] {
  return images.filter((image) => isAwwwardsUrl(image.link));
}

export function filterAwwwardsResults(results: SerperOrganicResult[]): SerperOrganicResult[] {
  return results.filter((result) => isAwwwardsUrl(result.link));
}

export function formatImageResults(images: SerperImage[], query: string): string {
  if (!images.length) return `No design inspiration found for "${query}".`;

  const lines = [`# Design Inspiration: "${query}"`, "", `Found ${images.length} results`, ""];
  for (const img of images) {
    lines.push(`## ${img.title}`);
    lines.push(`- **Source**: ${img.source}`);
    lines.push(`- **Image**: ${img.imageUrl}`);
    lines.push(`- **Page**: ${img.link}`);
    if (img.imageWidth && img.imageHeight) {
      lines.push(`- **Size**: ${img.imageWidth}x${img.imageHeight}`);
    }
    lines.push("");
  }

  let result = lines.join("\n");
  if (result.length > CHARACTER_LIMIT) {
    result = result.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated, use fewer results)";
  }
  return result;
}

export function formatSearchResults(results: SerperOrganicResult[], query: string): string {
  if (!results.length) return `No results found for "${query}".`;

  const lines = [`# Design References: "${query}"`, "", `Found ${results.length} results`, ""];
  for (const r of results) {
    lines.push(`## ${r.title}`);
    lines.push(`${r.snippet}`);
    lines.push(`- **Link**: ${r.link}`);
    lines.push("");
  }

  let result = lines.join("\n");
  if (result.length > CHARACTER_LIMIT) {
    result = result.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated, use fewer results)";
  }
  return result;
}

export function buildSiteQuery(query: string): string {
  return `${query} (site:${AWWWARDS_HOST})`;
}

export const server = new McpServer({
  name: "design-inspiration-mcp-server",
  version: "1.0.0",
});

export const SearchImagesInputSchema = z
  .object({
    query: z
      .string()
      .min(2, "Query must be at least 2 characters")
      .max(200, "Query must not exceed 200 characters")
      .describe(
        'UI design search query. Examples: "dashboard dark mode", "mobile onboarding flow", "saas pricing page"'
      ),
    num: z
      .number()
      .int()
      .min(1)
      .max(40)
      .default(10)
      .describe("Number of image results to return (1-40, default: 10)"),
  })
  .strict();

type SearchImagesInput = z.infer<typeof SearchImagesInputSchema>;

server.registerTool("design_search_images", {
  title: "Deprecated: Search design images",
  description: `Deprecated. Use design_search_references for Awwwards page links or design_search_styles for aesthetic research. This tool remains available for compatibility.`,
  inputSchema: SearchImagesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}, async (params: SearchImagesInput) => {
  try {
    const siteQuery = buildSiteQuery(params.query + " UI design");
    const data = await serperRequest<SerperImagesResponse>("/images", {
      q: siteQuery,
      num: params.num,
    });

    const images = filterAwwwardsImages(data.images || []);
    const text = formatImageResults(images, params.query);

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        query: params.query,
        count: images.length,
        images: images.map((img) => ({
          title: img.title,
          imageUrl: img.imageUrl,
          thumbnailUrl: img.thumbnailUrl,
          source: img.source,
          link: img.link,
          width: img.imageWidth,
          height: img.imageHeight,
        })),
      },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : `Error: ${String(error)}`,
        },
      ],
    };
  }
});

export const SearchReferencesInputSchema = z
  .object({
    query: z
      .string()
      .min(2)
      .max(200)
      .describe(
        'UI design search query. Examples: "best dashboard designs 2025", "mobile navigation patterns"'
      ),
    num: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("Number of results to return (1-20, default: 10)"),
  })
  .strict();

type SearchReferencesInput = z.infer<typeof SearchReferencesInputSchema>;

server.registerTool("design_search_references", {
  title: "Search design references",
  description: `Search Awwwards.com for design references. Returns article titles, snippets, and Awwwards page links. Use this for case studies, write-ups, or design system documentation.`,
  inputSchema: SearchReferencesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}, async (params: SearchReferencesInput) => {
  try {
    const siteQuery = buildSiteQuery(params.query);
    const data = await serperRequest<SerperSearchResponse>("/search", {
      q: siteQuery,
      num: params.num,
    });

    const results = filterAwwwardsResults(data.organic || []);
    const text = formatSearchResults(results, params.query);

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        query: params.query,
        count: results.length,
        results: results.map((r) => ({
          title: r.title,
          link: r.link,
          snippet: r.snippet,
          position: r.position,
        })),
      },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : `Error: ${String(error)}`,
        },
      ],
    };
  }
});

export const SearchStyleInputSchema = z
  .object({
    style: z
      .string()
      .min(2)
      .max(200)
      .describe(
        'Design style to search for. Examples: "minimalist dark theme", "brutalist web design", "glassmorphism"'
      ),
    type: z
      .enum(["color-palette", "typography", "layout", "animation", "general"])
      .default("general")
      .describe("Type of style inspiration to search for"),
    num: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("Number of results (1-20, default: 10)"),
  })
  .strict();

type SearchStyleInput = z.infer<typeof SearchStyleInputSchema>;

server.registerTool("design_search_styles", {
  title: "Search design styles",
  description: `Search Awwwards.com for a specific aesthetic direction. Search color palettes, typography, layouts, or animation references. The tool returns image and web results.`,
  inputSchema: SearchStyleInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}, async (params: SearchStyleInput) => {
  try {
    const typeKeywords: Record<string, string> = {
      "color-palette": "color palette scheme",
      typography: "typography fonts",
      layout: "layout grid structure",
      animation: "animation motion design",
      general: "",
    };

    const query = `${params.style} ${typeKeywords[params.type]} UI design inspiration`;
    const fullQuery = buildSiteQuery(query);

    const [imageData, searchData] = await Promise.all([
      serperRequest<SerperImagesResponse>("/images", { q: fullQuery, num: params.num }),
      serperRequest<SerperSearchResponse>("/search", { q: fullQuery, num: params.num }),
    ]);

    const images = filterAwwwardsImages(imageData.images || []);
    const results = filterAwwwardsResults(searchData.organic || []);

    const lines = [`# Style Inspiration: "${params.style}" (${params.type})`, ""];

    if (images.length) {
      lines.push("## Images", "");
      for (const img of images.slice(0, 5)) {
        lines.push(`- **${img.title}**: ${img.imageUrl}`);
        lines.push(`  Source: ${img.source} | [View](${img.link})`);
      }
      lines.push("");
    }

    if (results.length) {
      lines.push("## References", "");
      for (const r of results) {
        lines.push(`- **${r.title}**`);
        lines.push(`  ${r.snippet}`);
        lines.push(`  [View](${r.link})`);
        lines.push("");
      }
    }

    let text = lines.join("\n");
    if (text.length > CHARACTER_LIMIT) {
      text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
    }

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        style: params.style,
        type: params.type,
        images: images.slice(0, 5).map((img) => ({
          title: img.title,
          imageUrl: img.imageUrl,
          source: img.source,
          link: img.link,
        })),
        references: results.map((r) => ({
          title: r.title,
          link: r.link,
          snippet: r.snippet,
        })),
      },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : `Error: ${String(error)}`,
        },
      ],
    };
  }
});

// --- design_extract_tokens tool ---

export interface DesignTokens {
  colors?: Record<string, unknown>;
  typography?: Record<string, unknown>;
  spacing?: Record<string, unknown>;
  borders?: Record<string, unknown>;
  shadows?: Record<string, unknown>;
  [key: string]: unknown;
}

export function runDembrandt(url: string, flags: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [url, "--json-only", ...flags];
    execFile("dembrandt", args, { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.trim() || error.message;
        if (error.killed) return reject(new Error("Timed out after 60s. The site may be too slow — try with --slow via CLI."));
        if (msg.includes("net::ERR_NAME_NOT_RESOLVED")) return reject(new Error(`Could not resolve URL: ${url}`));
        if (msg.includes("net::ERR_CONNECTION_REFUSED")) return reject(new Error(`Connection refused: ${url}`));
        return reject(new Error(`dembrandt failed: ${msg}`));
      }
      resolve(stdout);
    });
  });
}

export function formatTokens(tokens: DesignTokens, url: string): string {
  const lines = [`# Design Tokens: ${url}`, ""];

  if (tokens.colors && Object.keys(tokens.colors).length) {
    lines.push("## Colors", "");
    for (const [name, value] of Object.entries(tokens.colors)) {
      if (typeof value === "string") {
        lines.push(`- **${name}**: \`${value}\``);
      } else if (typeof value === "object" && value !== null) {
        lines.push(`- **${name}**: \`${JSON.stringify(value)}\``);
      }
    }
    lines.push("");
  }

  if (tokens.typography && Object.keys(tokens.typography).length) {
    lines.push("## Typography", "");
    for (const [name, value] of Object.entries(tokens.typography)) {
      if (typeof value === "string") {
        lines.push(`- **${name}**: \`${value}\``);
      } else if (typeof value === "object" && value !== null) {
        lines.push(`- **${name}**: \`${JSON.stringify(value)}\``);
      }
    }
    lines.push("");
  }

  if (tokens.spacing && Object.keys(tokens.spacing).length) {
    lines.push("## Spacing", "");
    for (const [name, value] of Object.entries(tokens.spacing)) {
      lines.push(`- **${name}**: \`${JSON.stringify(value)}\``);
    }
    lines.push("");
  }

  if (tokens.borders && Object.keys(tokens.borders).length) {
    lines.push("## Borders", "");
    for (const [name, value] of Object.entries(tokens.borders)) {
      lines.push(`- **${name}**: \`${JSON.stringify(value)}\``);
    }
    lines.push("");
  }

  if (tokens.shadows && Object.keys(tokens.shadows).length) {
    lines.push("## Shadows", "");
    for (const [name, value] of Object.entries(tokens.shadows)) {
      lines.push(`- **${name}**: \`${JSON.stringify(value)}\``);
    }
    lines.push("");
  }

  // Any remaining top-level keys
  const handled = new Set(["colors", "typography", "spacing", "borders", "shadows"]);
  for (const [key, value] of Object.entries(tokens)) {
    if (handled.has(key) || value === undefined || value === null) continue;
    lines.push(`## ${key.charAt(0).toUpperCase() + key.slice(1)}`, "");
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`- **${k}**: \`${typeof v === "string" ? v : JSON.stringify(v)}\``);
      }
    } else {
      lines.push(`- ${JSON.stringify(value)}`);
    }
    lines.push("");
  }

  let result = lines.join("\n");
  if (result.length > CHARACTER_LIMIT) {
    result = result.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
  }
  return result;
}

export const ExtractTokensInputSchema = z
  .object({
    url: z
      .string()
      .min(4, "URL is required")
      .refine(isAwwwardsUrl, "URL must be on Awwwards.com")
      .describe('Awwwards.com URL to extract design tokens from. Example: "https://www.awwwards.com/sites/example"'),
    dark_mode: z
      .boolean()
      .default(false)
      .describe("Extract colors from dark mode variant"),
    mobile: z
      .boolean()
      .default(false)
      .describe("Extract from mobile viewport (375px)"),
  })
  .strict();

type ExtractTokensInput = z.infer<typeof ExtractTokensInputSchema>;

server.registerTool("design_extract_tokens", {
  title: "Extract design tokens from website",
  description: `Extract design tokens from an Awwwards.com page using a headless browser. The URL must use the Awwwards.com domain.`,
  inputSchema: ExtractTokensInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}, async (params: ExtractTokensInput) => {
  try {
    const url = normalizeHttpUrl(params.url);
    const flags: string[] = [];
    if (params.dark_mode) flags.push("--dark-mode");
    if (params.mobile) flags.push("--mobile");

    const stdout = await runDembrandt(url, flags);
    const tokens: DesignTokens = JSON.parse(stdout);
    const text = formatTokens(tokens, url);

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { url, dark_mode: params.dark_mode, mobile: params.mobile, tokens },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : `Error: ${String(error)}`,
        },
      ],
    };
  }
});

const AssetRequirementSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  kind: z.enum(["3d-model", "3d-render", "animated-svg", "lottie"]),
  role: z.string().trim().min(1).max(160),
  preferredTool: z.enum(["blender", "svgator", "lottie-creator"]).optional(),
  preferredFormats: z.array(z.enum(["glb", "gltf", "png", "webp", "usdz", "svg", "lottie", "dotlottie"])).min(1).max(5),
  delivery: z.enum(["web", "reference"]),
  prompt: z.string().trim().max(1000).optional(),
  animation: z.object({
    durationMs: z.number().int().positive().max(120000),
    loop: z.boolean().default(false),
    trigger: z.enum(["autoplay", "load", "in-view", "hover", "click", "scroll", "interaction", "state-machine"]).default("autoplay"),
    reducedMotion: z.enum(["static", "disable", "simplify"]).default("static"),
    frameRate: z.number().int().positive().max(120).optional(),
  }).strict().optional(),
  performanceBudget: z.object({
    maxTriangles: z.number().int().positive().optional(),
    maxTextureMb: z.number().positive().optional(),
    maxFileKb: z.number().int().positive().optional(),
    maxPaths: z.number().int().positive().optional(),
    maxFps: z.number().int().positive().max(120).optional(),
  }).strict().optional(),
}).strict().superRefine((asset, ctx) => {
  const is2d = asset.kind === "animated-svg" || asset.kind === "lottie";
  if (is2d && !asset.animation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "animation is required for animated-svg and lottie assets", path: ["animation"] });
  }
  if (asset.kind === "animated-svg" && !asset.preferredFormats.some((format) => ["svg", "lottie", "dotlottie"].includes(format))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "animated-svg assets require svg, lottie, or dotlottie output", path: ["preferredFormats"] });
  }
  if (asset.kind === "lottie" && !asset.preferredFormats.some((format) => ["lottie", "dotlottie"].includes(format))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "lottie assets require lottie or dotlottie output", path: ["preferredFormats"] });
  }
  if (asset.kind === "3d-model" || asset.kind === "3d-render") {
    if (asset.preferredTool && asset.preferredTool !== "blender") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "3D assets must use Blender", path: ["preferredTool"] });
    }
  } else if (asset.preferredTool === "blender") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "2D assets cannot use Blender", path: ["preferredTool"] });
  }
});

export const PrepareReferencesInputSchema = z.object({
  references: z.array(z.object({
    url: z
      .string()
      .trim()
      .url()
      .refine((value) => /^https?:$/.test(new URL(value).protocol), "URL must use HTTP or HTTPS")
      .refine(isAwwwardsUrl, "Reference URL must be on Awwwards.com"),
    role: z.string().trim().min(1).max(120),
    captureName: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    extractTokens: z.boolean().default(false),
    requires3d: z.boolean().default(false),
    assetRequirements: z.array(AssetRequirementSchema).max(20).default([]),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.references.forEach((reference, referenceIndex) => {
    reference.assetRequirements.forEach((asset, assetIndex) => {
      if (ids.has(asset.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate asset ID: ${asset.id}`, path: ["references", referenceIndex, "assetRequirements", assetIndex, "id"] });
      }
      ids.add(asset.id);
    });
  });
});

type PrepareReferencesInput = z.infer<typeof PrepareReferencesInputSchema>;

server.registerTool("design_prepare_references", {
  title: "Prepare design references",
  description: "Validate and normalize selected references. Does not browse, capture, or invoke other MCPs.",
  inputSchema: PrepareReferencesInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (params: PrepareReferencesInput) => {
  const references = params.references.map((reference) => {
    const url = new URL(reference.url);
    url.hash = "";
    const assetRequirements = reference.assetRequirements.length > 0
      ? reference.assetRequirements
      : reference.requires3d
        ? [{
            id: `${reference.captureName}-3d`,
            kind: "3d-render" as const,
            role: "3D asset indicated by the selected reference",
            preferredFormats: ["glb", "png"] as const,
            delivery: "web" as const,
            prompt: reference.role,
          }]
        : [];
    return { ...reference, url: url.toString(), assetRequirements };
  });
  const assetPlan = references.flatMap((reference) => reference.assetRequirements.map((asset) => ({
    assetId: asset.id,
    route: asset.kind === "3d-model" || asset.kind === "3d-render"
      ? "blender" as const
      : (asset.preferredTool ?? (asset.kind === "lottie" ? "lottie-creator" : "svgator")) as "svgator" | "lottie-creator",
    reason: `${asset.kind} requested for ${reference.captureName}`,
    outputs: asset.preferredFormats,
    nextAction: asset.kind === "3d-model" || asset.kind === "3d-render"
      ? "Create or modify a Blender scene and export web-ready assets"
      : "Create or edit the animation in the selected 2D animation MCP and export the requested formats",
    sourceReference: reference.url,
    asset,
  })));
  const markdown = [
    "# Prepared design references", "", `Prepared ${references.length} reference${references.length === 1 ? "" : "s"}.`, "",
    ...references.map((reference) => `- [${reference.captureName}](${reference.url}) — ${reference.role}; capture${reference.extractTokens ? ", extract tokens" : ""}${reference.assetRequirements.length ? `, ${reference.assetRequirements.length} asset requirement(s)` : ""}.`),
    ...(assetPlan.length ? ["", "## Asset plan", "", ...assetPlan.map((asset) => `- \`${asset.assetId}\` (${asset.asset.kind}) → ${asset.route}; outputs: ${asset.outputs.join(", ")}.`)]: []),
  ].join("\n");
  return { content: [{ type: "text" as const, text: markdown }], structuredContent: { references, count: references.length, assetPlan } };
});

export async function main() {
  if (!process.env.SERPER_API_KEY) {
    console.error("WARNING: SERPER_API_KEY not set. Get a free key at https://serper.dev");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Design Inspiration MCP server running on stdio");
}

/* v8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
/* v8 ignore stop */
