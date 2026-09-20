#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const SERPER_API_URL = "https://google.serper.dev";
export const CHARACTER_LIMIT = 25000;
export const AWWWARDS_HOST = "awwwards.com";
export const SOTD_QUERY = '"Site of the Day"';

export const DESIGN_SITES = {
  awwwards: "awwwards.com",
} as const;

export type DesignSite = keyof typeof DESIGN_SITES;

export type AwardTier = "sotd" | "honorable-mention" | "nominee" | "unknown";
export const AWWWARDS_FETCH_TIMEOUT_MS = 15_000;
export const AWWWARDS_MAX_HTML_BYTES = 5 * 1024 * 1024;
export const SERPER_TIMEOUT_MS = 15_000;
const AWARD_DATE_PATTERN = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b/i;

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

export function isAwwwardsSiteUrl(value: string): boolean {
  if (!isAwwwardsUrl(value)) return false;
  return new URL(normalizeHttpUrl(value)).pathname.startsWith("/sites/");
}

export function isLiveSiteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const address = isIP(hostname);
    const privateIpv4 = address === 4 && (/^(10|127)\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) || hostname === "169.254.169.254");
    const privateIpv6 = address === 6 && (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:"));
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !isAwwwardsUrl(value) && !url.username && !url.password &&
      hostname !== "localhost" && !hostname.endsWith(".localhost") && !hostname.endsWith(".local") &&
      !privateIpv4 && !privateIpv6
    );
  } catch {
    return false;
  }
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(normalizeHttpUrl(value));
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function extractHtmlTitle(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)?.[1];
  return stripHtml(title ?? ogTitle ?? "");
}

function extractAwardHeading(html: string): string {
  const headings = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((heading) => /site\s+of\s+the\s+day|honorable\s+mention|nominee/i.test(heading));
  return headings[0] ?? "";
}

export interface AwardVerification {
  tier: AwardTier;
  awardDate?: string;
  evidence: string;
}

export function classifyAwardPage(html: string): AwardVerification {
  const title = extractHtmlTitle(html);
  const heading = extractAwardHeading(html);
  const evidence = [title, heading].filter(Boolean).join(" | ");
  const normalized = evidence.replace(/\s+/g, " ").toLowerCase();
  if (/\bhonorable\s+mention\b/.test(normalized)) {
    return { tier: "honorable-mention", evidence };
  }
  if (/\bnominee\b/.test(normalized)) {
    return { tier: "nominee", evidence };
  }
  const hasSotdMarker = /\bawwwards\s+sotd\b|\bsite\s+of\s+the\s+day\b/.test(normalized);
  const awardDate = evidence.match(AWARD_DATE_PATTERN)?.[0];
  if (hasSotdMarker && awardDate) {
    return { tier: "sotd", awardDate, evidence };
  }
  return { tier: "unknown", evidence };
}

export async function verifyAwwwardsSotd(value: string): Promise<AwardVerification & { url: string }> {
  if (!isAwwwardsSiteUrl(value)) {
    throw new Error(`Awwwards award verification requires an Awwwards site URL: ${value}`);
  }

  const url = canonicalizeUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AWWWARDS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "design-inspiration-mcp-server/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Awwwards award verification returned HTTP ${response.status}`);
    }
    if (response.url && !isAwwwardsSiteUrl(response.url)) {
      throw new Error(`Awwwards award verification redirected outside Awwwards: ${response.url}`);
    }
    const html = await response.text();
    if (html.length > AWWWARDS_MAX_HTML_BYTES) {
      throw new Error(`Awwwards award verification response exceeded ${AWWWARDS_MAX_HTML_BYTES} bytes: ${url}`);
    }
    const verification = classifyAwardPage(html);
    if (verification.tier !== "sotd") {
      throw new Error(
        `Awwwards page is not a verified Site of the Day winner (${verification.tier}): ${url}`
      );
    }
    return { ...verification, url };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Awwwards award verification timed out after ${AWWWARDS_FETCH_TIMEOUT_MS / 1000}s: ${url}`);
    }
    if (error instanceof Error) throw error;
    throw new Error(`Awwwards award verification failed: ${String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function serperRequest<T>(
  endpoint: string,
  body: Record<string, string | number | boolean | null | undefined>
): Promise<T> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SERPER_API_KEY environment variable is required. Get one free at https://serper.dev"
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${SERPER_API_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 401)
      throw new Error("Error: Invalid SERPER_API_KEY. Check your key at https://serper.dev/api-key");
    if (status === 429)
      throw new Error("Error: Rate limit exceeded. Wait before making more requests.");
    throw new Error(`Error: Serper API returned status ${status}`);
  }

  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Serper API returned a non-object response");
  return data as T;
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
  searchParameters?: Record<string, string | number | boolean | null>;
}

export interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export interface SerperSearchResponse {
  organic: SerperOrganicResult[];
  searchParameters?: Record<string, string | number | boolean | null>;
}

export function filterAwwwardsImages(images: SerperImage[]): SerperImage[] {
  return images.filter((image) => isAwwwardsUrl(image.link));
}

export function filterAwwwardsResults(results: SerperOrganicResult[]): SerperOrganicResult[] {
  return results.filter((result) => isAwwwardsUrl(result.link));
}

export function classifyAwardTier(result: Pick<SerperOrganicResult, "title" | "snippet">): AwardTier {
  const text = `${result.title} ${result.snippet}`.replace(/\s+/g, " ").toLowerCase();
  if (/\bhonorable\s+mention\b/.test(text)) return "honorable-mention";
  if (/\bnominee\b/.test(text)) return "nominee";
  const hasSotdMarker = /\bsite\s+of\s+the\s+day\b|\bsotd\b/.test(text);
  const hasAwardDate = AWARD_DATE_PATTERN.test(text);
  if (hasSotdMarker && hasAwardDate) return "sotd";
  return "unknown";
}

export function filterSotdResults(results: SerperOrganicResult[]): SerperOrganicResult[] {
  return filterAwwwardsResults(results).filter(
    (result) => isAwwwardsSiteUrl(result.link) && classifyAwardTier(result) === "sotd"
  );
}

export function filterSotdImages(images: SerperImage[], resultLinks: Set<string>): SerperImage[] {
  return filterAwwwardsImages(images).filter((image) => resultLinks.has(canonicalizeUrl(image.link)));
}

export function formatSearchResults(results: SerperOrganicResult[], query: string): string {
  if (!results.length) return `No results found for "${query}".`;

  const lines = [
    `# Design References: "${query}"`,
    "",
    "Award filter: Site of the Day",
    `Found ${results.length} results`,
    "",
  ];
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

export function buildSiteQuery(query: string, awardTier: "sotd" = "sotd"): string {
  if (awardTier !== "sotd") throw new Error(`Unsupported Awwwards award tier: ${awardTier}`);
  return `${query} ${SOTD_QUERY} (site:${AWWWARDS_HOST}/sites)`;
}

export const server = new McpServer({
  name: "design-inspiration-mcp-server",
  version: "1.0.0",
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
    awardTier: z
      .literal("sotd")
      .default("sotd")
      .describe("Only current or past Site of the Day winners are eligible"),
  })
  .strict();

type SearchReferencesInput = z.infer<typeof SearchReferencesInputSchema>;

server.registerTool("design_search_references", {
  title: "Search design references",
  description: `Search Awwwards.com for current or past Site of the Day winners. Honorable Mentions, nominees, and unverified Awwwards pages are excluded.`,
  inputSchema: SearchReferencesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}, async (params: SearchReferencesInput) => {
  try {
    const siteQuery = buildSiteQuery(params.query, params.awardTier);
    const data = await serperRequest<SerperSearchResponse>("/search", {
      q: siteQuery,
      num: params.num,
    });

    const results = filterSotdResults(data.organic || []);
    const text = formatSearchResults(results, params.query);

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        query: params.query,
        awardTier: params.awardTier,
        count: results.length,
        results: results.map((r) => ({
          title: r.title,
          link: r.link,
          snippet: r.snippet,
          position: r.position,
          awardTier: classifyAwardTier(r),
        })),
      },
    };
  } catch (error) {
    return {
      isError: true,
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
    awardTier: z
      .literal("sotd")
      .default("sotd")
      .describe("Only current or past Site of the Day winners are eligible"),
  })
  .strict();

type SearchStyleInput = z.infer<typeof SearchStyleInputSchema>;

server.registerTool("design_search_styles", {
  title: "Search design styles",
  description: `Search current or past Awwwards Site of the Day winners for a specific aesthetic direction. Honorable Mentions, nominees, and unverified pages are excluded from both image and web results.`,
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
    const fullQuery = buildSiteQuery(query, params.awardTier);

    const [imageData, searchData] = await Promise.all([
      serperRequest<SerperImagesResponse>("/images", { q: fullQuery, num: params.num }),
      serperRequest<SerperSearchResponse>("/search", { q: fullQuery, num: params.num }),
    ]);

    const results = filterSotdResults(searchData.organic || []);
    const resultLinks = new Set(results.map((result) => canonicalizeUrl(result.link)));
    const images = filterSotdImages(imageData.images || [], resultLinks);

    const lines = [
      `# Style Inspiration: "${params.style}" (${params.type})`,
      "",
      "Award filter: Site of the Day",
      "",
    ];

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
          awardTier: classifyAwardTier(r),
        })),
      },
    };
  } catch (error) {
    return {
      isError: true,
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

export type TokenScalar = string | number | boolean | null;
export type TokenValue =
  | TokenScalar
  | TokenScalar[]
  | Record<string, TokenScalar | string[] | Record<string, TokenScalar>>;

export interface DesignTokens {
  colors?: Record<string, string | Record<string, string> | null>;
  typography?: Record<string, string | number | Record<string, string | number> | null>;
  spacing?: Record<string, string | number | Record<string, string | number> | null>;
  borders?: Record<string, string | Record<string, string> | null>;
  shadows?: Record<string, string | string[] | null>;
  [key: string]: TokenValue | undefined;
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
      for (const [k, v] of Object.entries(value as Record<string, TokenValue>)) {
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
      .refine(isAwwwardsSiteUrl, "URL must be an Awwwards site page")
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
      isError: true,
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
    if (!asset.preferredFormats.some((format) => ["glb", "gltf", "png", "webp", "usdz"].includes(format))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "3D assets require glb, gltf, png, webp, or usdz output", path: ["preferredFormats"] });
    }
    if (asset.preferredTool && asset.preferredTool !== "blender") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "3D assets must use Blender", path: ["preferredTool"] });
    }
  } else if (asset.preferredTool === "blender") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "2D assets cannot use Blender", path: ["preferredTool"] });
  }
  if (asset.kind === "animated-svg" && asset.preferredTool === "lottie-creator" && !asset.preferredFormats.some((format) => ["lottie", "dotlottie"].includes(format))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "lottie-creator requires lottie or dotlottie output", path: ["preferredFormats"] });
  }
});

export const PrepareReferencesInputSchema = z.object({
  references: z.array(z.object({
    url: z
      .string()
      .trim()
      .url()
      .refine((value) => /^https?:$/.test(new URL(value).protocol), "URL must use HTTP or HTTPS")
      .refine(isAwwwardsSiteUrl, "Reference URL must be an Awwwards site page"),
    liveUrl: z
      .string()
      .trim()
      .min(1, "liveUrl is required")
      .url("liveUrl must be a valid URL")
      .refine((value) => /^https?:$/.test(new URL(value).protocol), "liveUrl must use HTTP or HTTPS")
      .refine(isLiveSiteUrl, "liveUrl must not be an Awwwards URL"),
    role: z.string().trim().min(1).max(120),
    captureName: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/, "captureName must contain 1 to 81 letters, numbers, dots, dashes, or underscores"),
    extractTokens: z.boolean().default(false),
    requires3d: z.boolean().default(false),
    assetRequirements: z.array(AssetRequirementSchema).max(20).default([]),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  const captureNames = new Set<string>();
  const liveUrls = new Set<string>();
  value.references.forEach((reference, referenceIndex) => {
    const normalizedCaptureName = reference.captureName.toLowerCase();
    if (captureNames.has(normalizedCaptureName)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate captureName: ${reference.captureName}`, path: ["references", referenceIndex, "captureName"] });
    }
    captureNames.add(normalizedCaptureName);
    const liveUrl = canonicalizeUrl(reference.liveUrl);
    if (liveUrls.has(liveUrl)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate liveUrl: ${reference.liveUrl}`, path: ["references", referenceIndex, "liveUrl"] });
    }
    liveUrls.add(liveUrl);
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
  description: "Verify each selected Awwwards page is a dated Site of the Day winner, then normalize the references. Does not capture or invoke other MCPs.",
  inputSchema: PrepareReferencesInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async (params: PrepareReferencesInput) => {
  const references = [];
  try {
    for (const reference of params.references) {
      const awardVerification = await verifyAwwwardsSotd(reference.url);
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
      references.push({
        ...reference,
        captureName: reference.captureName.toLowerCase(),
        url: awardVerification.url,
        liveUrl: reference.liveUrl.trim(),
        awardVerification,
        assetRequirements,
      });
    }
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        /* c8 ignore next -- verifyAwwwardsSotd normalizes unknown throws to Error. */
        text: error instanceof Error ? error.message : `Awwwards award verification failed: ${String(error)}`,
      }],
    };
  }
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
    liveSiteUrl: reference.liveUrl,
    asset,
  })));
  const markdown = [
    "# Prepared design references", "", `Prepared ${references.length} reference${references.length === 1 ? "" : "s"}.`, "",
    ...references.map((reference) => `- [${reference.captureName}](${reference.url}) — SOTD ${reference.awardVerification.awardDate}; ${reference.role}; capture${reference.extractTokens ? ", extract tokens" : ""}${reference.assetRequirements.length ? `, ${reference.assetRequirements.length} asset requirement(s)` : ""}.`),
    ...(assetPlan.length ? ["", "## Asset plan", "", ...assetPlan.map((asset) => `- \`${asset.assetId}\` (${asset.asset.kind}) → ${asset.route}; outputs: ${asset.outputs.join(", ")}.`)] : []),
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
