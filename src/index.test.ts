import { describe, expect, it } from "vitest";
import {
  AWWWARDS_HOST,
  DESIGN_SITES,
  ExtractTokensInputSchema,
  PrepareReferencesInputSchema,
  buildSiteQuery,
  filterAwwwardsImages,
  filterAwwwardsResults,
  isAwwwardsUrl,
} from "./index.js";

describe("Awwwards source policy", () => {
  it("exposes only Awwwards as a design source", () => {
    expect(DESIGN_SITES).toEqual({ awwwards: AWWWARDS_HOST });
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
  ])("rejects a non-Awwwards URL: %s", (url) => {
    expect(isAwwwardsUrl(url)).toBe(false);
  });

  it("rejects external token and reference URLs at schema boundaries", () => {
    expect(
      ExtractTokensInputSchema.safeParse({ url: "https://example.com" }).success
    ).toBe(false);
    expect(
      PrepareReferencesInputSchema.safeParse({
        references: [
          {
            url: "https://example.com/",
            role: "motion reference",
            captureName: "external-reference",
          },
        ],
      }).success
    ).toBe(false);
  });
});
