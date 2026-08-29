# Changelog

## Unreleased

- Restrict image search, reference search, style search, token extraction, and reference preparation to Awwwards.com.

## 1.1.0 — 2026-03-01

**New tool: `design_extract_tokens`**

Extracts design tokens (colors, typography, spacing, borders, and shadows) from an Awwwards.com page. Supports dark mode and mobile viewport extraction.

Requires `dembrandt` installed globally (`npm install -g dembrandt`). No new npm dependencies in the project itself — it shells out to the CLI via `child_process`.

## 1.0.0 — 2025-02-20

Initial release with three Awwwards.com search tools:

- `design_search_images` — image search
- `design_search_references` — reference search
- `design_search_styles` — combined image and web search for an aesthetic direction
