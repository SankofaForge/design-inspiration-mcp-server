# design-inspiration

MCP server that searches Awwwards.com for UI design inspiration. It works with Claude Code and other MCP clients.

Uses the [Serper API](https://serper.dev) with a `site:awwwards.com` filter. It can also extract design tokens from Awwwards.com pages with a headless browser.

Find inspiration, then extract exact tokens from sites you like.

## Why

I wanted Claude to pull design references while building UI without leaving the terminal. The search tools return Awwwards.com pages that can be reviewed directly.

The search side wraps Serper's image and web search endpoints with pre-configured site filters. Simple.

The token extraction tool reads an Awwwards.com page and reports its colors, fonts, spacing, borders, and shadows.

## Tools

**`design_search_references`** — Search current and past Awwwards Site of the Day winners. Honorable Mentions, nominees, and pages without an explicit, dated SOTD marker are filtered out.

**`design_search_styles`** — Search SOTD winners for a specific aesthetic direction. It combines image and web results for color, typography, layout, or animation queries, and keeps images only when their page also passed the SOTD filter.

**`design_prepare_references`** — Fetch each selected Awwwards page and verify its title or award heading identifies a dated Site of the Day win before normalizing the handoff. Each reference also requires a distinct, valid non-Awwwards `liveUrl` and a `captureName` accepted by the live capture server (1–81 letters, numbers, dots, dashes, or underscores). Honorable Mentions, nominees, missing award metadata, non-2xx responses, and timeouts fail the handoff.

**`design_extract_tokens`** — Extract design tokens from an Awwwards.com page. Supports `dark_mode` and `mobile` flags. Requires `dembrandt` installed globally (`npm install -g dembrandt`).

The supported search tools query Awwwards.com. They accept a `num` parameter to control result count.

## Setup

You need a Serper API key for the search tools. Free tier gives you 2,500 searches with no credit card.

1. Sign up at [serper.dev](https://serper.dev)
2. Copy your API key

For token extraction, install dembrandt globally:

```bash
npm install -g dembrandt
```

### Claude Code

```bash
claude mcp add design-inspiration -e SERPER_API_KEY=your-key-here -- node /path/to/design-inspiration-mcp-server/dist/index.js
```

### Any MCP client (stdio)

```json
{
  "design-inspiration": {
    "type": "stdio",
    "command": "node",
    "args": ["/path/to/design-inspiration-mcp-server/dist/index.js"],
    "env": {
      "SERPER_API_KEY": "your-key-here"
    }
  }
}
```

## Build from source

```bash
git clone https://github.com/YonasValentin/design-inspiration-mcp-server.git
cd design-inspiration-mcp-server
npm install
npm run build
```

## How it actually works

The search tools append the exact `"Site of the Day"` marker and `(site:awwwards.com/sites)` to each query. They call Serper's `/images` or `/search` endpoint, restrict links to Awwwards site pages, and reject results marked Honorable Mention, Nominee, or unknown. A result must include the award marker and a month/day/year signal before it can enter the shortlist.

The `design_search_styles` tool runs both endpoints in parallel (`Promise.all`) to get images and articles for the same query.

`design_extract_tokens` shells out to `dembrandt` (via `child_process.execFile`) with `--json-only`, parses the JSON output, and formats it into markdown and structured data. It has a 60-second timeout. `dembrandt` runs as a global CLI, so the project has no extra npm dependency for token extraction.

Results are returned as both markdown (for display) and structured JSON (for programmatic use). Responses get truncated at 25,000 characters to avoid flooding the context window.

## Usage tips

Search for specific UI patterns, not generic terms:

```
# good
"fintech dashboard dark mode"
"mobile onboarding flow card swipe"
"saas pricing page comparison table"

# too vague
"nice website"
"good design"
```

The SOTD filter is a quality floor, not a substitute for review. Shortlist at least three returned pages, check that each live URL still works, and capture the selected site before using its motion as implementation evidence. If the search returns no qualifying pages, report that gap instead of falling back to Honorable Mentions or nominees.

You can download a returned image URL and have Claude view it directly:

```bash
curl -sL "https://example-cdn.invalid/reference.jpg" -o /tmp/reference.jpg
```

Then ask Claude to read the image file — it can see and describe the design.

## License

MIT

## Declarative 3D asset workflow

References can declare that a site concept needs 3D assets. `design_prepare_references` verifies the SOTD award, validates the asset requirement, and returns an `assetPlan`; it does not capture the site, create files, call Blender, or invoke another MCP.

The prepared reference preserves the indexed Awwwards `url` as source provenance and carries the selected live site through `liveUrl`. Asset-plan entries retain both as `sourceReference` and `liveSiteUrl`, so the capture handoff and asset provenance cannot be confused.

When an asset plan contains `route: "blender"`, the host application or agent must resolve that task against its current capability manifest and route it to the available Blender MCP. This is host-level routing, not an invocation performed by this server. Preserve the asset ID and acceptance requirements in the Blender task. If Blender is unavailable, the host must return a blocked asset result instead of silently substituting CSS or a placeholder.

Use [`examples/blender-asset-task.json`](examples/blender-asset-task.json) as the handoff shape. Include subject, visual intent, camera, composition, materials, lighting, animation, web-ready output formats, performance limits, and acceptance expectations. Web outputs normally include compressed `.glb` or `.gltf` plus a `.png` or `.webp` fallback. Acceptance verifies clean-viewer loading, framing, materials, animations, and performance budgets.

Expected handoff: `design_prepare_references -> assetPlan.route = "blender" -> host application -> Blender MCP -> native site implementation and browser QA`.

Do not replace a declared 3D requirement with CSS or a placeholder without user approval. If Blender is unavailable, report the blocked asset task and retain the declarative handoff.

## Declarative 2D animation workflow

References can also declare animated SVG or Lottie deliverables. The server validates the animation requirements and returns an `assetPlan` route. It remains declarative and read-only with respect to asset authoring: it does not create asset files or call SVGator, Lottie Creator, Glaxnimate, or the brief-to-Lottie compiler.

Use `kind: "animated-svg"` for a web-native animated SVG, or `kind: "lottie"` when Lottie is the primary delivery format. Set `preferredTool` to `"svgator"` or `"lottie-creator"` when the default route should be overridden. Without an explicit tool, animated SVG routes to SVGator and Lottie routes to Lottie Creator.

The host application resolves each route against its connected capability manifest and preserves the asset ID and acceptance requirements:

- `svgator` means the actual external [SVGator MCP](https://www.svgator.com/mcp-for-ai-animations), not Glaxnimate. Its official endpoint is `https://mcp.svgator.com/mcp`. The host must have at least `create_project`, `edit_part`, and `export_project` available for this authoring handoff. The host owns those calls and keeps authentication outside the handoff and repository.
- `lottie-creator` remains the simple `brief-to-lottie` compiler route for requests that fit its supported shape-layer `SceneSpec`/`MotionSpec`. Complex Lottie work must explicitly set `kind: "lottie"` and `preferredTool: "svgator"` in the input asset requirement. The server does not infer complexity or automatically upgrade the default route.
- Glaxnimate is a separate, explicitly selected host-only route for a complete authored SVG with valid semantic IDs. It is not a `preferredTool` value in this server's schema and must never be an implicit fallback for `svgator` or `lottie-creator`.

If the requested capability is missing or incompatible, the host returns a blocked asset result with the original ID, route, and reason. It must not silently substitute Glaxnimate, handwritten SVG, CSS, or a placeholder.

Animation requirements include duration, loop behavior, trigger, reduced-motion behavior, and file-size or path-count budgets. For the SVGator example, acceptance requires Lottie JSON, a self-contained animated SVG, and a separate static reduced-motion output. The host must validate each exported file before accepting it: parse the JSON and SVG, check playback in the target Lottie player and browser, verify timing and trigger behavior, check that reduced motion shows the static output, and measure the file-size and path-count budgets. A successful export call alone does not establish acceptance.

See [`examples/svgator-asset-task.json`](examples/svgator-asset-task.json) for a complex vector/Lottie task in the host handoff shape. This example is not a direct `design_prepare_references` input: map `assetId` to the input asset requirement's `id`, pass `preferredTool: "svgator"`, and use `delivery: "web"`. Keep `route`, `authoring`, `acceptance`, and output paths in the host handoff, outside the server's strict input schema. The expected flow is `design_prepare_references -> assetPlan.route = "svgator" -> host application -> SVGator MCP -> export validation -> native site implementation and browser motion QA`.
