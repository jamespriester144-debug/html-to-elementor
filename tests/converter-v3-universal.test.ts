import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ContentIntegrityReport,
  UniversalVisualValidationReport
} from "../lib/converter-v3/contracts/output";
import { buildUniversalVisualValidationReport } from "../lib/converter-v3/reports/visual-validation-report";
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

if (typeof process.env.FORCE_FULL_PAGE_SNAPSHOT !== "string") {
  process.env.FORCE_FULL_PAGE_SNAPSHOT = "false";
}

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

function testUniversalVisualValidationReportIncludesRichIssueMetadata() {
  const report = buildUniversalVisualValidationReport({
    resolvedSource: {
      id: "resolved-source",
      sourceKind: "raw-html",
      title: "Mock Visual Report"
    },
    capture: {
      id: "capture-id",
      sourceKind: "raw-html",
      title: "Mock Capture",
      sourceHtml: "<html></html>",
      renderedHtml: "<html></html>",
      renderer: "browser",
      inputAnalysis: {
        fileName: "mock-visual-report.html",
        sourceKind: "raw-html",
        layoutTypes: ["static-html"],
        frameworkHints: [],
        structure: {
          totalElements: 1,
          realSectionCount: 1,
          headers: 1,
          navbars: 0,
          heroSections: 1,
          cards: 0,
          grids: 0,
          buttons: 1,
          images: 2,
          backgrounds: 1,
          absoluteFixedSticky: 0,
          zIndexNodes: 0,
          iframes: 0,
          scripts: 0,
          lazyLoadElements: 0,
          externalAssets: 0,
          externalFonts: 0,
          links: 1,
          forms: 0,
          carousels: 0,
          transformedElements: 0,
          overflowHiddenElements: 0,
          outOfFlowElements: 0
        },
        sectionCandidates: [],
        assets: {
          found: [],
          total: 0,
          local: 0,
          external: 0,
          embedded: 0,
          images: 0,
          backgrounds: 0,
          stylesheets: 0,
          fonts: 0,
          scripts: 0,
          iframes: 0,
          lazy: 0,
          loaded: 0,
          failed: 0
        },
        renderStrategy: {
          requiresBrowserRender: true,
          preferVisualSnapshot: true,
          preferFullPageSnapshot: false,
          safeSectionExtraction: true,
          reasons: ["Mock visual report."]
        },
        diagnostics: {
          errors: [],
          warnings: [],
          rendererUsed: "browser",
          htmlRendered: true,
          cssLoaded: true,
          imagesLoaded: true,
          relativeAssetsResolved: true,
          viewportMatched: true,
          sectionCroppingRisk: false,
          fullPageSnapshotFailed: false,
          resources: []
        }
      },
      viewports: [
        {
          name: "desktop",
          width: 1440,
          height: 900
        }
      ],
      domSnapshot: [],
      styleSnapshot: [],
      boxSnapshot: [],
      responsiveSnapshot: [],
      nodes: [],
      themeAnalysis: {
        detectedTheme: "dark",
        dominantBackgroundLuminance: 0.021,
        dominantContrast: 15.6,
        colorSamples: [],
        designTokens: {
          globalBackground: "rgb(15, 23, 42)",
          foreground: "rgb(248, 250, 252)",
          cardBackground: "rgb(30, 41, 59)"
        },
        roleCounts: {
          cards: 1,
          buttons: 1,
          inputs: 0,
          headers: 1,
          footers: 0,
          sections: 1
        },
        messages: ["dark theme detected"]
      },
      summary: {
        totalNodes: 1,
        visibleNodes: 1,
        links: 1,
        images: 2,
        buttons: 1,
        textBlocks: 2,
        sections: 1
      },
      artifacts: {
        outputDir: "/tmp/capture",
        resolvedSourcePath: "/tmp/source.html",
        renderedHtmlPath: "/tmp/rendered.html",
        domSnapshotPath: "/tmp/dom.json",
        styleSnapshotPath: "/tmp/style.json",
        boxSnapshotPath: "/tmp/box.json",
        responsiveSnapshotPath: "/tmp/responsive.json",
        layoutPath: "/tmp/layout.json",
        analysisPath: "/tmp/analysis.json",
        pageCapturePath: "/tmp/capture.json",
        sectionArtifactsPath: "/tmp/sections.json",
        screenshots: {
          desktop: "/tmp/capture/desktop.png"
        }
      }
    },
    layout: {
      id: "layout-id",
      title: "Mock Layout",
      sourceKind: "raw-html",
      rootNodeId: "page",
      nodeCount: 1,
      sectionIds: ["hero-section"],
      semanticIndex: {},
      detectedSections: [
        {
          id: "hero-section",
          type: "hero",
          confidence: 0.99,
          childIds: [],
          anchors: [],
          contains: ["hero"]
        }
      ],
      nodes: [
        {
          id: "hero-section",
          kind: "section",
          parentId: null,
          children: [],
          box: {
            x: 12,
            y: 24,
            width: 320,
            height: 180
          },
          visualOrder: 0,
          layout: {},
          spacing: {},
          style: {},
          content: {},
          flags: {},
          responsive: {}
        }
      ]
    },
    analysis: {
      score: 1,
      overlappingGroups: 0,
      gridContainers: 0,
      flexContainers: 1,
      absoluteNodes: 0,
      decorativeNodes: 0,
      interactiveNodes: 1,
      selectedMode: "snapshot",
      reasons: ["Mock analysis."]
    },
    emittedMode: "snapshot",
    fallbackReason: "Mock fallback reason.",
    previewHtml: "<html><body>preview</body></html>",
    elementorDocument: {
      version: "1.0",
      title: "Mock Visual Report",
      type: "page",
      content: []
    },
    validation: {
      passed: false,
      mode: "snapshot",
      issueCount: 1,
      issues: [],
      stats: {
        expectedTexts: 2,
        matchedTexts: 1,
        expectedImages: 2,
        matchedImages: 0,
        expectedButtons: 1,
        matchedButtons: 1,
        expectedLinks: 1,
        matchedLinks: 1,
        expectedSections: 1,
        matchedSections: 1,
        expectedCards: 0,
        matchedCards: 0,
        expectedHeaders: 1,
        matchedHeaders: 1,
        expectedFooters: 0,
        matchedFooters: 0,
        expectedPositionedNodes: 2,
        matchedPositionedNodes: 1
      }
    },
    report: {
      id: "report-id",
      title: "Mock Visual Report",
      sourceKind: "raw-html",
      renderer: "browser",
      snapshotEnabled: true,
      snapshotReason: "Mock snapshot reason.",
      selectedMode: "snapshot",
      emittedMode: "snapshot",
      fallbackReason: "Mock fallback reason.",
      summary: {
        totalNodes: 1,
        visibleNodes: 1,
        links: 1,
        images: 2,
        buttons: 1,
        textBlocks: 2,
        sections: 1
      },
      layout: {
        rootNodeId: "page",
        nodeCount: 1,
        sectionCount: 1
      },
      analysis: {
        score: 1,
        overlappingGroups: 0,
        gridContainers: 0,
        flexContainers: 1,
        absoluteNodes: 0,
        decorativeNodes: 0,
        interactiveNodes: 1,
        selectedMode: "snapshot",
        reasons: ["Mock analysis."]
      },
      validation: {
        passed: false,
        mode: "snapshot",
        issueCount: 1,
        issues: [],
        stats: {
          expectedTexts: 2,
          matchedTexts: 1,
          expectedImages: 2,
          matchedImages: 0,
          expectedButtons: 1,
          matchedButtons: 1,
          expectedLinks: 1,
          matchedLinks: 1,
          expectedSections: 1,
          matchedSections: 1,
          expectedCards: 0,
          matchedCards: 0,
          expectedHeaders: 1,
          matchedHeaders: 1,
          expectedFooters: 0,
          matchedFooters: 0,
          expectedPositionedNodes: 2,
          matchedPositionedNodes: 1
        }
      },
      warnings: [],
      contentMetrics: {
        detectedTexts: 2,
        detectedImages: 2,
        detectedButtons: 1,
        detectedLinks: 1,
        detectedVisualContainers: 0,
        detectedGeometryGroups: 0,
        createdSections: 1
      },
      viewportSimilarities: {
        desktop: 0.984
      },
      visualIssues: [
        {
          sectionId: "hero-section",
          sectionName: "hero-1",
          sectionType: "hero",
          sectionTypeLabel: "Hero",
          severity: "critical",
          viewport: "desktop",
          similarity: 0.984,
          similarityPercent: "98.40%",
          lossType: "image",
          estimatedLossCount: 2,
          estimatedLosses: {
            total: 2,
            images: 2,
            texts: 0,
            buttons: 0,
            links: 0,
            backgrounds: 0
          },
          bbox: {
            x: 24,
            y: 32,
            width: 180,
            height: 120
          },
          originalScreenshotPath: "/tmp/capture/desktop.png",
          convertedScreenshotPath: "/tmp/export/desktop.png",
          diffScreenshotPath: "/tmp/export/desktop-diff.png",
          fallbackStage: "full-page-snapshot",
          message: "Hero perdeu 2 imagens."
        }
      ],
      visualValidationSummary: [
        "[Visual Validation]",
        "Desktop: 98.4% - falhou",
        "Problema: secao Hero perdeu 2 imagens",
        "Exportacao bloqueada"
      ],
      visualLogs: [
        "[Visual Validation]",
        "Desktop: 98.4% - falhou",
        "Problema: secao Hero perdeu 2 imagens",
        "Exportacao bloqueada",
        "[THEME] dark theme detected",
        "[THEME] light theme detected",
        "[THEME] dark theme lost"
      ],
      themeAnalysis: {
        detectedTheme: "dark",
        dominantBackgroundLuminance: 0.021,
        dominantContrast: 15.6,
        colorSamples: [],
        designTokens: {
          globalBackground: "rgb(15, 23, 42)",
          foreground: "rgb(248, 250, 252)",
          cardBackground: "rgb(30, 41, 59)"
        },
        roleCounts: {
          cards: 1,
          buttons: 1,
          inputs: 0,
          headers: 1,
          footers: 0,
          sections: 1
        },
        messages: ["dark theme detected"]
      },
      themeAudit: {
        passed: false,
        sourceTheme: "dark",
        convertedTheme: "light",
        sourceTokens: {
          globalBackground: "rgb(15, 23, 42)"
        },
        convertedTokens: {
          globalBackground: "rgb(255, 255, 255)"
        },
        issues: [
          {
            type: "theme-mismatch",
            severity: "critical",
            message: "dark theme lost",
            originalValue: "rgb(15, 23, 42)",
            convertedValue: "rgb(255, 255, 255)"
          }
        ],
        messages: ["dark theme detected", "light theme detected", "dark theme lost"]
      },
      themeLogs: [
        "[THEME] dark theme detected",
        "[THEME] light theme detected",
        "[THEME] dark theme lost"
      ],
      learningNotes: [],
      fallbackTrail: [],
      snapshot: {
        renderStrategy: "full-page-snapshot",
        overallSimilarity: 0.984,
        threshold: 0.99,
        convertedScreenshotPath: "/tmp/export/desktop.png",
        originalScreenshotPath: "/tmp/capture/desktop.png",
        viewportSimilarities: {
          desktop: 0.984
        },
        sectionReports: [],
        visualValidationReport: {
          status: "blocked",
          modeUsed: "full-page-snapshot",
          viewportsTested: ["desktop"],
          sectionsApproved: [],
          sectionsWithFallback: [],
          linksPreserved: 1,
          totalLinks: 1,
          similarityFinal: 0.984,
          similarityFinalPercent: "98.40%",
          viewportResults: [
            {
              viewport: "desktop",
              passed: false,
              similarity: 0.984,
              similarityPercent: "98.40%",
              bbox: {
                x: 24,
                y: 32,
                width: 180,
                height: 120
              },
              originalScreenshotPath: "/tmp/capture/desktop.png",
              convertedScreenshotPath: "/tmp/export/desktop.png",
              diffScreenshotPath: "/tmp/export/desktop-diff.png"
            }
          ],
          issues: [
            {
              viewport: "desktop",
              sectionId: "hero-section",
              sectionName: "hero-1",
              sectionType: "hero",
              sectionTypeLabel: "Hero",
              severity: "critical",
              similarity: 0.984,
              similarityPercent: "98.40%",
              lossType: "image",
              estimatedLossCount: 2,
              estimatedLosses: {
                total: 2,
                images: 2,
                texts: 0,
                buttons: 0,
                links: 0,
                backgrounds: 0
              },
              bbox: {
                x: 24,
                y: 32,
                width: 180,
                height: 120
              },
              fallbackStage: "full-page-snapshot",
              fallbackUsed: "full-page-snapshot",
              originalScreenshotPath: "/tmp/capture/desktop.png",
              convertedScreenshotPath: "/tmp/export/desktop.png",
              diffScreenshotPath: "/tmp/export/desktop-diff.png",
              message: "Hero perdeu 2 imagens."
            }
          ],
          blockingReason: "Conversao bloqueada: secao Hero perdeu 2 imagens."
        },
        totals: {
          htmlSections: 0,
          snapshotSections: 1,
          preservedLinks: 1,
          totalLinks: 1
        }
      }
    },
    snapshot: {
      renderStrategy: "full-page-snapshot",
      overallSimilarity: 0.984,
      threshold: 0.99,
      convertedScreenshotPath: "/tmp/export/desktop.png",
      originalScreenshotPath: "/tmp/capture/desktop.png",
      viewportSimilarities: {
        desktop: 0.984
      },
      sectionReports: [],
      visualValidationReport: {
        status: "blocked",
        modeUsed: "full-page-snapshot",
        viewportsTested: ["desktop"],
        sectionsApproved: [],
        sectionsWithFallback: [],
        linksPreserved: 1,
        totalLinks: 1,
        similarityFinal: 0.984,
        similarityFinalPercent: "98.40%",
        viewportResults: [
          {
            viewport: "desktop",
            passed: false,
            similarity: 0.984,
            similarityPercent: "98.40%",
            bbox: {
              x: 24,
              y: 32,
              width: 180,
              height: 120
            },
            originalScreenshotPath: "/tmp/capture/desktop.png",
            convertedScreenshotPath: "/tmp/export/desktop.png",
            diffScreenshotPath: "/tmp/export/desktop-diff.png"
          }
        ],
        issues: [
          {
            viewport: "desktop",
            sectionId: "hero-section",
            sectionName: "hero-1",
            sectionType: "hero",
            sectionTypeLabel: "Hero",
            severity: "critical",
            similarity: 0.984,
            similarityPercent: "98.40%",
            lossType: "image",
            estimatedLossCount: 2,
            estimatedLosses: {
              total: 2,
              images: 2,
              texts: 0,
              buttons: 0,
              links: 0,
              backgrounds: 0
            },
            bbox: {
              x: 24,
              y: 32,
              width: 180,
              height: 120
            },
            fallbackStage: "full-page-snapshot",
            fallbackUsed: "full-page-snapshot",
            originalScreenshotPath: "/tmp/capture/desktop.png",
            convertedScreenshotPath: "/tmp/export/desktop.png",
            diffScreenshotPath: "/tmp/export/desktop-diff.png",
            message: "Hero perdeu 2 imagens."
          }
        ],
        blockingReason: "Conversao bloqueada: secao Hero perdeu 2 imagens."
      },
      totals: {
        htmlSections: 0,
        snapshotSections: 1,
        preservedLinks: 1,
        totalLinks: 1
      }
    },
    contentIntegrity: {
      status: "passed",
      inputFile: "/tmp/source.html",
      outputFile: "/tmp/export.json",
      sourceHtmlSize: 10,
      originalHtmlSize: 10,
      renderedHtmlSize: 10,
      outputSize: 10,
      elementorJsonSize: 10,
      previewHtmlSize: 10,
      originalTextCount: 2,
      outputTextCount: 2,
      originalImageCount: 2,
      outputImageCount: 2,
      originalButtonCount: 1,
      outputButtonCount: 1,
      originalLinkCount: 1,
      outputLinkCount: 1,
      originalSectionCount: 1,
      outputSectionCount: 1,
      originalVisibleHeight: 180,
      convertedVisibleHeight: 180,
      visibleContentDetected: true,
      convertedBodyEmpty: false,
      hasRealWidgets: true,
      snapshotGenerated: true,
      overlaysGenerated: true,
      modeUsed: "full-page-snapshot",
      recommendation: "Mock content integrity.",
      errorsFound: []
    },
    artifacts: {
      elementorTemplatePath: "/tmp/export.json",
      reportPath: "/tmp/report.json"
    }
  } as never);

  assert.equal(report.modeUsed, "full-page-snapshot");
  assert.equal(report.finalSimilarity, 0.984);
  assert.equal(report.visualIssues.length, 1);
  assert.equal(report.visualIssues[0]?.sectionTypeLabel, "Hero");
  assert.equal(report.visualIssues[0]?.estimatedLossCount, 2);
  assert.deepEqual(report.visualIssues[0]?.bbox, {
    x: 24,
    y: 32,
    width: 180,
    height: 120
  });
  assert.equal(report.logs[0], "[Visual Validation]");
  assert.equal(report.themeDetected, "dark");
  assert.equal(report.themeAudit?.passed, false);
  assert.equal(report.logs.includes("[THEME] dark theme lost"), true);
  assert.equal(
    report.errors.includes("dark theme lost"),
    true
  );
  assert.equal(
    report.errors.includes("Conversao bloqueada: secao Hero perdeu 2 imagens."),
    true
  );
}

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

    if (
      fixture.tags.includes("lovable") &&
      result.snapshot?.visualValidationReport &&
      report.modeUsed !== "pixel-perfect"
    ) {
      assert.equal(result.snapshot.visualValidationReport.status, "passed");
      assert.deepEqual(result.snapshot.visualValidationReport.viewportsTested, [
        "desktop",
        "tablet",
        "mobile"
      ]);
      assert.equal(result.capture.summary.textBlocks === 0 || contentIntegrity.outputTextCount > 0 || contentIntegrity.snapshotGenerated, true);
      assert.equal(result.capture.summary.images === 0 || contentIntegrity.outputImageCount > 0 || contentIntegrity.snapshotGenerated, true);
      assert.equal(result.capture.summary.buttons === 0 || contentIntegrity.outputButtonCount > 0 || contentIntegrity.snapshotGenerated, true);
      assert.equal((result.capture.summary.links ?? 0) === 0 || contentIntegrity.outputLinkCount > 0 || contentIntegrity.overlaysGenerated, true);
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
  testUniversalVisualValidationReportIncludesRichIssueMetadata();
  await testUniversalFixtures();
  console.log("converter v3 universal fixture tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
