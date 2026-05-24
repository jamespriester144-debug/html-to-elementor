import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ContentIntegrityReport,
  UniversalVisualValidationReport
} from "../lib/converter-v3/contracts/output";
import {
  runCapturePipelineV3
} from "../lib/converter-v3/orchestration/pipeline-v3";
import {
  runExportPipelineV3
} from "../lib/converter-v3/orchestration/export-pipeline-v3";
import { resolveSourceFromLocalPath } from "../lib/converter-v3/resolve/source-resolver";
import {
  assertConverterV3FixtureCoverage,
  CONVERTER_V3_UNIVERSAL_FIXTURES
} from "./support/converter-v3-fixture-matrix";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "sites");

function isForceVisualSnapshotEnabled() {
  const value = String(process.env.FORCE_VISUAL_SNAPSHOT || "").trim().toLowerCase();

  if (!value) {
    return true;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return true;
}

const FIXTURES = CONVERTER_V3_UNIVERSAL_FIXTURES;

async function testUniversalFixtures() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-universal-tests");
  assertConverterV3FixtureCoverage(FIXTURES);

  for (const fixture of FIXTURES) {
    const filePath = path.join(FIXTURE_DIR, fixture.name);
    console.log(`testing universal fixture: ${fixture.name}`);
    const resolvedSource = await resolveSourceFromLocalPath(filePath);
    const preferBrowser =
      ("preferBrowser" in fixture && typeof fixture.preferBrowser === "boolean"
        ? fixture.preferBrowser
        : false) || ("verifyExport" in fixture && fixture.verifyExport);
    const captureResult = await runCapturePipelineV3(resolvedSource, {
      preferBrowser,
      outputRoot
    });

    if (preferBrowser) {
      assert.equal(captureResult.capture.renderer, "browser");
    }
    assert.ok(captureResult.capture.artifacts.visibleElementsPath);
    await access(captureResult.capture.artifacts.visibleElementsPath as string);
    assert.ok(captureResult.capture.artifacts.geometryGroupsPath);
    await access(captureResult.capture.artifacts.geometryGroupsPath as string);
    assert.equal(captureResult.capture.inputAnalysis.layoutTypes.length > 0, true);
    assert.equal(captureResult.layout.sectionIds.length >= 1, true);
    assert.equal(captureResult.capture.inputAnalysis.diagnostics.htmlRendered, true);

    if (!("verifyExport" in fixture) || !fixture.verifyExport) {
      if (fixture.name === "mobile-heavy.html") {
        assert.ok(captureResult.capture.artifacts.screenshots.mobile);
        await access(captureResult.capture.artifacts.screenshots.mobile as string);
      }

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
        viewportSimilarities: undefined,
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
        visualIssues: [],
        learningNotes: [],
        logs: [],
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
    assert.ok(result.artifacts.contentIntegrityReportPath);
    await access(result.artifacts.contentIntegrityReportPath as string);

    const report = JSON.parse(
      await readFile(result.artifacts.visualValidationReportPath, "utf8")
    ) as UniversalVisualValidationReport;
    const contentIntegrity = JSON.parse(
      await readFile(result.artifacts.contentIntegrityReportPath as string, "utf8")
    ) as ContentIntegrityReport;

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
        report.modeUsed === "section-snapshot" ||
          report.modeUsed === "full-page-snapshot" ||
          report.modeUsed === "pixel-perfect",
        true
      );
    }

    assert.equal(contentIntegrity.status, "passed");
    assert.equal(contentIntegrity.convertedBodyEmpty, false);
    assert.equal(contentIntegrity.hasRealWidgets, true);
    assert.equal(contentIntegrity.outputSectionCount >= 1, true);
    assert.ok(contentIntegrity.debugArtifacts?.visibleElementsPath);
    await access(contentIntegrity.debugArtifacts?.visibleElementsPath as string);
    assert.ok(contentIntegrity.debugArtifacts?.geometryGroupsPath);
    await access(contentIntegrity.debugArtifacts?.geometryGroupsPath as string);
    assert.equal(result.elementorDocument.content.length >= 1, true);

    if (isForceVisualSnapshotEnabled()) {
      assert.equal(
        contentIntegrity.snapshotGenerated || report.modeUsed === "pixel-perfect",
        true
      );
    }

    fixture.assertResult(report);

    if (
      fixture.name === "vite-react-export.html" &&
      isForceVisualSnapshotEnabled() &&
      report.modeUsed !== "pixel-perfect"
    ) {
      assert.equal(contentIntegrity.modeUsed, "full-page-snapshot");
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
