# design-inspiration

MCP server that searches Awwwards.com for UI design inspiration. It works with Claude Code and other MCP clients.

Uses the [Serper API](https://serper.dev) with a `site:awwwards.com` filter. It can also extract design tokens from Awwwards.com pages with a headless browser.

Find inspiration, then extract exact tokens from sites you like.

## Why

I wanted Claude to pull design references while building UI without leaving the terminal. The search tools return image URLs and Awwwards.com page links that can be reviewed directly.

The search side wraps Serper's image and web search endpoints with pre-configured site filters. Simple.

The token extraction tool reads an Awwwards.com page and reports its colors, fonts, spacing, borders, and shadows.

## Tools

**`design_search_images`** — Search Awwwards.com for image references. Returns image URLs, dimensions, and Awwwards.com page links.

**`design_search_references`** — Search Awwwards.com pages. Returns article titles, snippets, and links for case studies and design write-ups.

**`design_search_styles`** — Search Awwwards.com for a specific aesthetic direction. It combines image and web results for color, typography, layout, or animation queries.

**`design_extract_tokens`** — Extract design tokens from an Awwwards.com page. Supports `dark_mode` and `mobile` flags. Requires `dembrandt` installed globally (`npm install -g dembrandt`).

The three search tools always query Awwwards.com. They accept a `num` parameter to control result count.

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

Each search tool appends `(site:awwwards.com)` to the query. It then calls Serper's `/images` or `/search` endpoint and filters the returned page links to Awwwards.com.

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

You can download a returned image URL and have Claude view it directly:

```bash
curl -sL "https://example-cdn.invalid/reference.jpg" -o /tmp/reference.jpg
```

Then ask Claude to read the image file — it can see and describe the design.

## License

MIT

## Declarative 3D asset workflow

References can declare that a site concept needs 3D assets. `design_prepare_references` validates the requirement and returns an `assetPlan`; it does not create files, call Blender, or invoke another MCP.

When an asset plan contains `route: "blender"`, the host application or agent must route that task to the available Blender MCP. This is host-level routing, not an invocation performed by this server. Preserve the asset ID and acceptance requirements in the Blender task.

Use [`examples/blender-asset-task.json`](examples/blender-asset-task.json) as the handoff shape. Include subject, visual intent, camera, composition, materials, lighting, animation, web-ready output formats, performance limits, and acceptance expectations. Web outputs normally include compressed `.glb` or `.gltf` plus a `.png` or `.webp` fallback. Acceptance verifies clean-viewer loading, framing, materials, animations, and performance budgets.

Expected handoff: `design_prepare_references -> assetPlan.route = "blender" -> host application -> Blender MCP -> native site implementation and browser QA`.

Do not replace a declared 3D requirement with CSS or a placeholder without user approval. If Blender is unavailable, report the blocked asset task and retain the declarative handoff.

## Declarative 2D animation workflow

References can also declare animated SVG or Lottie deliverables. The server validates the animation requirements and returns an `assetPlan` route; it does not call SVGator or Lottie Creator itself.

Use `kind: "animated-svg"` for a web-native animated SVG, or `kind: "lottie"` when Lottie is the primary delivery format. Set `preferredTool` to `"svgator"` or `"lottie-creator"` when the default route should be overridden. Without an explicit tool, animated SVG routes to SVGator and Lottie routes to Lottie Creator.

Animation requirements can include duration, loop behavior, trigger, reduced-motion behavior, and file or path budgets. The host application must route `assetPlan.route = "svgator"` to the connected SVGator MCP or `assetPlan.route = "lottie-creator"` to Lottie Creator MCP, then preserve the asset ID and acceptance requirements during implementation.

See [`examples/svgator-asset-task.json`](examples/svgator-asset-task.json) for a complete handoff shape. The expected flow is `design_prepare_references -> assetPlan.route = "svgator" -> host application -> SVGator MCP -> export -> native site implementation and browser motion QA`.
