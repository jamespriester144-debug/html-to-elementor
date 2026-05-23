import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { UniversalVisualValidationReport } from "../lib/converter-v3/contracts/output";
import {
  runCapturePipelineV3
} from "../lib/converter-v3/orchestration/pipeline-v3";
import {
  runExportPipelineV3
} from "../lib/converter-v3/orchestration/export-pipeline-v3";
import { resolveSourceFromLocalFile } from "../lib/converter-v3/resolve/source-resolver";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "sites");

function isForceVisualSnapshotEnabled() {
  const value = String(process.env.FORCE_VISUAL_SNAPSHOT || "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

const FIXTURES = [
  {
    name: "simple-static.html",
    verifyExport: true,
    assertResult: (report: UniversalVisualValidationReport) => {
      assert.equal(report.sectionsDetected.length >= 1, true);
    }
  },
  {
    name: "lovable-export.html",
    assertResult: (report: UniversalVisualValidationReport) => {
      assert.equal(report.layoutTypesDetected.includes("lovable-export"), true);
      assert.equal(report.layoutTypesDetected.includes("tailwind"), true);
    }
  },
  {
    name: "vite-react-export.html",
    verifyExport: true,
    assertResult: (report: UniversalVisualValidationReport) => {
      assert.equal(report.layoutTypesDetected.includes("vite-react-export"), true);
      assert.equal(report.htmlRendered, true);
    }
  },
  {
    name: "absolute-layout.html",
    verifyExport: true,
    assertResult: (report: UniversalVisualValidationReport) => {
      assert.equal(
        report.modeUsed === "full-page-snapshot" || report.modeUsed === "section-snapshot",
        true
      );
    }
  },
  {
    name: "grid-layout.html",
    assertResult: (report: UniversalVisualValidationReport) => {
      assert.equal(report.sectionsDetected.length >= 1, true);
    }
  },
  {
    name: "lazy-images.html",
    assertResult: (report: UniversalVisualValidationReport) => {
      assert.equal(report.assetsFound.some((asset) => asset.lazy), true);
    }
  },
  {
    name: "external-assets.html",
    assertResult: (report: UniversalVisualValidationReport) => {
      assert.equal(report.assetsFound.some((asset) => asset.external), true);
    }
  },
  {
    name: "long-sales-page.html",
    assertResult: (report: UniversalVisualValidationReport) => {
      assert.equal(report.sectionsDetected.length >= 4, true);
    }
  },
  {
    name: "mobile-heavy.html",
    verifyExport: true,
    assertResult: (report: UniversalVisualValidationReport) => {
      assert.equal(report.viewportMatched, true);
    }
  }
] as const;

async function testUniversalFixtures() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-universal-tests");

  for (const fixture of FIXTURES) {
    const filePath = path.join(FIXTURE_DIR, fixture.name);
    console.log(`testing universal fixture: ${fixture.name}`);
    const resolvedSource = await resolveSourceFromLocalFile(filePath);
    const captureResult = await runCapturePipelineV3(resolvedSource, {
      preferBrowser: true,
      outputRoot
    });

    assert.equal(captureResult.capture.renderer, "browser");
    assert.equal(captureResult.capture.inputAnalysis.layoutTypes.length > 0, true);
    assert.equal(captureResult.layout.sectionIds.length >= 1, true);
    assert.equal(captureResult.capture.inputAnalysis.diagnostics.htmlRendered, true);

    if (!fixture.verifyExport) {
      fixture.assertResult({
        fileAnalyzed: captureResult.capture.inputAnalysis.fileName,
        title: captureResult.capture.title,
        sourceKind: captureResult.capture.sourceKind,
        renderer: captureResult.capture.renderer,
        layoutTypesDetected: captureResult.capture.inputAnalysis.layoutTypes,
        assetsFound: captureResult.capture.inputAnalysis.assets.found,
        assetsLoaded: captureResult.capture.inputAnalysis.diagnostics.resources,
        sectionsDetected:
          captureResult.layout.detectedSections.length > 0
            ? captureResult.layout.detectedSections.map((section) => ({
                id: section.id,
                type: section.type,
                confidence: section.confidence
              }))
            : captureResult.layout.sectionIds.map((sectionId) => ({
                id: sectionId,
                type: "section"
              })),
        modeUsed: "editable",
        fallbackReason: undefined,
        linksPreserved: 0,
        finalSimilarity: 0,
        htmlRendered: captureResult.capture.inputAnalysis.diagnostics.htmlRendered ?? false,
        cssLoaded: captureResult.capture.inputAnalysis.diagnostics.cssLoaded ?? false,
        imagesLoaded: captureResult.capture.inputAnalysis.diagnostics.imagesLoaded ?? false,
        relativeAssetsResolved:
          captureResult.capture.inputAnalysis.diagnostics.relativeAssetsResolved ?? false,
        viewportMatched:
          captureResult.capture.inputAnalysis.diagnostics.viewportMatched ?? false,
        sectionCroppingRisk:
          captureResult.capture.inputAnalysis.diagnostics.sectionCroppingRisk ?? false,
        fullPageSnapshotFailed:
          captureResult.capture.inputAnalysis.diagnostics.fullPageSnapshotFailed ?? false,
        errors: captureResult.capture.inputAnalysis.diagnostics.errors
      });
      continue;
    }

    const result = await runExportPipelineV3(resolvedSource, {
      preferBrowser: true,
      outputRoot
    });

    assert.ok(result.artifacts.visualValidationReportPath);
    await access(result.artifacts.visualValidationReportPath);

    const report = JSON.parse(
      await readFile(result.artifacts.visualValidationReportPath, "utf8")
    ) as UniversalVisualValidationReport;

    assert.equal(report.fileAnalyzed.includes(path.basename(fixture.name)), true);
    assert.equal(report.layoutTypesDetected.length > 0, true);
    assert.equal(Array.isArray(report.assetsFound), true);
    assert.equal(Array.isArray(report.assetsLoaded), true);
    assert.equal(Array.isArray(report.sectionsDetected), true);
    assert.equal(report.finalSimilarity >= 0, true);
    assert.equal(
      [
        "editable",
        "hybrid",
        "pixel-perfect",
        "section-snapshot",
        "full-page-snapshot"
      ].includes(report.modeUsed),
      true
    );

    if (isForceVisualSnapshotEnabled()) {
      assert.equal(
        report.modeUsed === "section-snapshot" || report.modeUsed === "full-page-snapshot",
        true
      );
    }

    fixture.assertResult(report);

    if (fixture.name === "mobile-heavy.html") {
      assert.ok(result.capture.artifacts.screenshots.mobile);
      await access(result.capture.artifacts.screenshots.mobile as string);
    }
  }
}

async function main() {
  await testUniversalFixtures();
  console.log("converter v3 universal fixture tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
