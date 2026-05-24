import assert from "node:assert/strict";

import { readLearnedFixtureManifestSync } from "../../lib/converter-v3/learning/fixture-manifest";
import type { UniversalVisualValidationReport } from "../../lib/converter-v3/contracts/output";

export type ConverterV3FixtureTag =
  | "lovable"
  | "generic-static"
  | "react-export"
  | "layout-stress"
  | "asset-coverage"
  | "responsive"
  | "long-form";

export type ConverterV3UniversalFixture = {
  name: string;
  tags: ConverterV3FixtureTag[];
  verifyExport?: boolean;
  preferBrowser?: boolean;
  assertResult: (report: UniversalVisualValidationReport) => void;
};

const CORE_CONVERTER_V3_UNIVERSAL_FIXTURES: readonly ConverterV3UniversalFixture[] = [
  {
    name: "simple-static.html",
    tags: ["generic-static"],
    verifyExport: true,
    assertResult: (report) => {
      assert.equal(report.sectionsDetected.length >= 1, true);
    }
  },
  {
    name: "lovable-export.html",
    tags: ["lovable"],
    verifyExport: true,
    assertResult: (report) => {
      assert.equal(report.layoutTypesDetected.includes("lovable-export"), true);
      assert.equal(report.layoutTypesDetected.includes("tailwind"), true);
    }
  },
  {
    name: "lovable-alt-layout.html",
    tags: ["lovable", "layout-stress"],
    verifyExport: true,
    preferBrowser: true,
    assertResult: (report) => {
      assert.equal(report.layoutTypesDetected.includes("lovable-export"), true);
      assert.equal(report.htmlRendered, true);
    }
  },
  {
    name: "lovable-editorial-layout.html",
    tags: ["lovable", "layout-stress"],
    verifyExport: true,
    preferBrowser: true,
    assertResult: (report) => {
      assert.equal(report.layoutTypesDetected.includes("lovable-export"), true);
      assert.equal(report.htmlRendered, true);
    }
  },
  {
    name: "vite-react-export.html",
    tags: ["react-export"],
    verifyExport: true,
    preferBrowser: true,
    assertResult: (report) => {
      assert.equal(report.layoutTypesDetected.includes("vite-react-export"), true);
      assert.equal(report.htmlRendered, true);
    }
  },
  {
    name: "absolute-layout.html",
    tags: ["layout-stress"],
    verifyExport: true,
    preferBrowser: true,
    assertResult: (report) => {
      assert.equal(report.htmlRendered, true);
    }
  },
  {
    name: "grid-layout.html",
    tags: ["generic-static", "layout-stress"],
    preferBrowser: false,
    assertResult: (report) => {
      assert.equal(report.sectionsDetected.length >= 1, true);
    }
  },
  {
    name: "lazy-images.html",
    tags: ["asset-coverage"],
    preferBrowser: true,
    assertResult: (report) => {
      assert.equal(report.assetsFound.some((asset) => asset.lazy), true);
    }
  },
  {
    name: "external-assets.html",
    tags: ["asset-coverage"],
    preferBrowser: true,
    assertResult: (report) => {
      assert.equal(report.assetsFound.some((asset) => asset.external), true);
    }
  },
  {
    name: "long-sales-page.html",
    tags: ["long-form", "layout-stress"],
    preferBrowser: false,
    assertResult: (report) => {
      assert.equal(report.sectionsDetected.length >= 4, true);
    }
  },
  {
    name: "mobile-heavy.html",
    tags: ["responsive"],
    preferBrowser: true,
    assertResult: (report) => {
      assert.equal(report.viewportMatched, true);
    }
  }
] as const;

function createLearnedFixtureAssertions(params: {
  expectedLayoutTypes?: string[];
  minSimilarity?: number;
}) {
  return (report: UniversalVisualValidationReport) => {
    assert.equal(report.htmlRendered, true);
    assert.equal(report.sectionsDetected.length >= 1, true);

    (params.expectedLayoutTypes ?? []).forEach((layoutType) => {
      assert.equal(
        report.layoutTypesDetected.some((detectedLayoutType) => detectedLayoutType === layoutType),
        true
      );
    });

    if (typeof params.minSimilarity === "number") {
      assert.equal(
        report.finalSimilarity >= params.minSimilarity || report.modeUsed === "pixel-perfect",
        true
      );
    }
  };
}

const LEARNED_CONVERTER_V3_UNIVERSAL_FIXTURES: readonly ConverterV3UniversalFixture[] =
  readLearnedFixtureManifestSync().fixtures.map((fixture) => ({
    name: fixture.name,
    tags: fixture.tags,
    verifyExport: fixture.verifyExport ?? true,
    preferBrowser: fixture.preferBrowser ?? true,
    assertResult: createLearnedFixtureAssertions({
      expectedLayoutTypes: fixture.expectedLayoutTypes,
      minSimilarity: fixture.minSimilarity
    })
  }));

export const CONVERTER_V3_UNIVERSAL_FIXTURES: readonly ConverterV3UniversalFixture[] = [
  ...CORE_CONVERTER_V3_UNIVERSAL_FIXTURES,
  ...LEARNED_CONVERTER_V3_UNIVERSAL_FIXTURES
];

function countFixturesByTag(
  fixtures: readonly ConverterV3UniversalFixture[],
  tag: ConverterV3FixtureTag
) {
  return fixtures.filter((fixture) => fixture.tags.includes(tag)).length;
}

export function assertConverterV3FixtureCoverage(
  fixtures: readonly ConverterV3UniversalFixture[] = CONVERTER_V3_UNIVERSAL_FIXTURES
) {
  assert.equal(new Set(fixtures.map((fixture) => fixture.name)).size, fixtures.length);
  assert.equal(fixtures.length >= 10, true);
  assert.equal(fixtures.filter((fixture) => fixture.verifyExport).length >= 6, true);
  assert.equal(countFixturesByTag(fixtures, "lovable") >= 3, true);
  assert.equal(countFixturesByTag(fixtures, "generic-static") >= 2, true);
  assert.equal(countFixturesByTag(fixtures, "layout-stress") >= 4, true);
  assert.equal(countFixturesByTag(fixtures, "asset-coverage") >= 2, true);
  assert.equal(countFixturesByTag(fixtures, "responsive") >= 1, true);
  assert.equal(countFixturesByTag(fixtures, "react-export") >= 1, true);
  assert.equal(countFixturesByTag(fixtures, "long-form") >= 1, true);
}
