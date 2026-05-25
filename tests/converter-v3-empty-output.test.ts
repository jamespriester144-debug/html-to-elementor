import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PageCapture } from "../lib/converter-v3/contracts/capture";
import type { InputPageAnalysis } from "../lib/converter-v3/contracts/input-analysis";
import type { LayoutDocument } from "../lib/converter-v3/contracts/layout";
import type { ContentIntegrityReport } from "../lib/converter-v3/contracts/output";
import { writeConversionDebugBundle } from "../lib/converter-v3/debug/conversion-debug";
import {
  runExportPipelineV3,
  runExportPipelineV3FromHtml,
  shouldRecoverBlockedExportWithSnapshot
} from "../lib/converter-v3/orchestration/export-pipeline-v3";
import { buildExportReport } from "../lib/converter-v3/reports/report-builder";
import { resolveSourceFromLocalFile } from "../lib/converter-v3/resolve/source-resolver";
import {
  assertContentIntegrity,
  ContentIntegrityError,
  validateContentIntegrity
} from "../lib/converter-v3/validate/content-integrity";
import type { ElementorDocument } from "../types/conversion";

if (typeof process.env.FORCE_FULL_PAGE_SNAPSHOT !== "string") {
  process.env.FORCE_FULL_PAGE_SNAPSHOT = "false";
}

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "sites");

function createMockInputAnalysis(
  overrides: Partial<InputPageAnalysis> = {}
): InputPageAnalysis {
  return {
    fileName: overrides.fileName ?? "empty-output-fixture.html",
    sourceKind: overrides.sourceKind ?? "raw-html",
    layoutTypes: overrides.layoutTypes ?? ["static-html"],
    frameworkHints: overrides.frameworkHints ?? [],
    structure: {
      totalElements: 4,
      realSectionCount: 1,
      headers: 0,
      navbars: 0,
      heroSections: 1,
      cards: 0,
      grids: 0,
      buttons: 1,
      images: 1,
      backgrounds: 0,
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
      requiresBrowserRender: false,
      preferVisualSnapshot: false,
      preferFullPageSnapshot: false,
      safeSectionExtraction: true,
      reasons: []
    },
    diagnostics: {
      errors: [],
      warnings: [],
      resources: [],
      htmlRendered: true,
      cssLoaded: true,
      imagesLoaded: true,
      relativeAssetsResolved: true,
      viewportMatched: true,
      rendererUsed: "browser",
      sectionCroppingRisk: false,
      fullPageSnapshotFailed: false
    },
    ...overrides
  };
}

function createMockCapture(overrides: Partial<PageCapture> = {}): PageCapture {
  return {
    id: "content-integrity-capture",
    sourceKind: "raw-html",
    title: "Content Integrity Fixture",
    sourceHtml:
      "<html><body><main><section><h1>Hero title</h1><p>Body copy</p><a href=\"#buy\">Buy now</a><img src=\"hero.png\" alt=\"Hero\" /></section></main></body></html>",
    renderedHtml:
      "<html><body><main><section><h1>Hero title</h1><p>Body copy</p><a href=\"#buy\">Buy now</a><img src=\"hero.png\" alt=\"Hero\" /></section></main></body></html>",
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width: 1440,
        height: 1200
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [
      {
        id: "capture-node-1",
        tag: "body",
        text: "",
        attributes: {},
        parentId: null,
        childIds: ["capture-node-2"],
        computedStyles: {},
        box: {
          x: 0,
          y: 0,
          top: 0,
          right: 1440,
          bottom: 900,
          left: 0,
          width: 1440,
          height: 900,
          centerX: 720,
          centerY: 450
        },
        viewportStates: {
          desktop: {
            computedStyles: {},
            box: {
              x: 0,
              y: 0,
              top: 0,
              right: 1440,
              bottom: 900,
              left: 0,
              width: 1440,
              height: 900,
              centerX: 720,
              centerY: 450
            },
            isVisible: true
          }
        },
        visualOrder: 1,
        isVisible: true,
        asset: {}
      },
      {
        id: "capture-node-2",
        tag: "h1",
        text: "Hero title",
        attributes: {},
        parentId: "capture-node-1",
        childIds: [],
        computedStyles: {},
        box: {
          x: 32,
          y: 48,
          top: 48,
          right: 640,
          bottom: 128,
          left: 32,
          width: 608,
          height: 80,
          centerX: 336,
          centerY: 88
        },
        viewportStates: {
          desktop: {
            computedStyles: {},
            box: {
              x: 32,
              y: 48,
              top: 48,
              right: 640,
              bottom: 128,
              left: 32,
              width: 608,
              height: 80,
              centerX: 336,
              centerY: 88
            },
            isVisible: true
          }
        },
        visualOrder: 2,
        isVisible: true,
        asset: {}
      },
      {
        id: "capture-node-3",
        tag: "a",
        text: "Buy now",
        attributes: {
          href: "#buy"
        },
        parentId: "capture-node-1",
        childIds: [],
        computedStyles: {},
        box: {
          x: 32,
          y: 220,
          top: 220,
          right: 220,
          bottom: 272,
          left: 32,
          width: 188,
          height: 52,
          centerX: 126,
          centerY: 246
        },
        viewportStates: {
          desktop: {
            computedStyles: {},
            box: {
              x: 32,
              y: 220,
              top: 220,
              right: 220,
              bottom: 272,
              left: 32,
              width: 188,
              height: 52,
              centerX: 126,
              centerY: 246
            },
            isVisible: true
          }
        },
        visualOrder: 3,
        isVisible: true,
        asset: {
          href: "#buy"
        }
      },
      {
        id: "capture-node-4",
        tag: "img",
        text: "",
        attributes: {
          src: "hero.png",
          alt: "Hero"
        },
        parentId: "capture-node-1",
        childIds: [],
        computedStyles: {},
        box: {
          x: 700,
          y: 48,
          top: 48,
          right: 1240,
          bottom: 648,
          left: 700,
          width: 540,
          height: 600,
          centerX: 970,
          centerY: 348
        },
        viewportStates: {
          desktop: {
            computedStyles: {},
            box: {
              x: 700,
              y: 48,
              top: 48,
              right: 1240,
              bottom: 648,
              left: 700,
              width: 540,
              height: 600,
              centerX: 970,
              centerY: 348
            },
            isVisible: true
          }
        },
        visualOrder: 4,
        isVisible: true,
        asset: {
          src: "hero.png",
          alt: "Hero"
        }
      }
    ],
    summary: {
      totalNodes: 4,
      visibleNodes: 4,
      images: 1,
      buttons: 1,
      textBlocks: 2,
      sections: 1
    },
    artifacts: {
      outputDir: path.join(os.tmpdir(), "content-integrity-tests"),
      resolvedSourcePath: "",
      renderedHtmlPath: "",
      domSnapshotPath: "",
      styleSnapshotPath: "",
      boxSnapshotPath: "",
      responsiveSnapshotPath: "",
      layoutPath: "",
      analysisPath: "",
      pageCapturePath: "",
      sectionArtifactsPath: "",
      screenshots: {}
    },
    ...overrides
  };
}

function createMockLayout(): LayoutDocument {
  return {
    id: "content-integrity-layout",
    title: "Content Integrity Layout",
    sourceKind: "raw-html",
    rootNodeId: "root-page",
    nodeCount: 5,
    sectionIds: ["hero-section"],
    semanticIndex: {
      hero: ["hero-section"],
      text: ["hero-title"],
      image: ["hero-image"],
      button: ["hero-button"]
    },
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.99,
        childIds: ["hero-title", "hero-image", "hero-button"],
        anchors: [],
        contains: ["hero", "text", "image", "button"]
      }
    ],
    nodes: [
      {
        id: "root-page",
        kind: "page",
        parentId: null,
        children: ["hero-section"],
        box: { x: 0, y: 0, width: 1440, height: 900 },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "hero-section",
        kind: "section",
        parentId: "root-page",
        children: ["hero-title", "hero-image", "hero-button"],
        box: { x: 0, y: 0, width: 1440, height: 900 },
        visualOrder: 2,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        detection: {
          semanticRole: "hero",
          confidence: 0.99
        },
        responsive: {}
      },
      {
        id: "hero-title",
        kind: "text",
        parentId: "hero-section",
        children: [],
        box: { x: 32, y: 48, width: 608, height: 80 },
        visualOrder: 3,
        layout: {},
        spacing: {},
        style: {},
        content: {
          text: "Hero title"
        },
        flags: {},
        detection: {
          semanticRole: "text",
          confidence: 0.98
        },
        responsive: {}
      },
      {
        id: "hero-image",
        kind: "image",
        parentId: "hero-section",
        children: [],
        box: { x: 700, y: 48, width: 540, height: 600 },
        visualOrder: 4,
        layout: {},
        spacing: {},
        style: {},
        content: {
          src: "hero.png",
          alt: "Hero"
        },
        flags: {},
        detection: {
          semanticRole: "image",
          confidence: 0.98
        },
        responsive: {}
      },
      {
        id: "hero-button",
        kind: "button",
        parentId: "hero-section",
        children: [],
        box: { x: 32, y: 220, width: 188, height: 52 },
        visualOrder: 5,
        layout: {},
        spacing: {},
        style: {},
        content: {
          text: "Buy now",
          href: "#buy"
        },
        flags: {},
        detection: {
          semanticRole: "button",
          confidence: 0.98
        },
        responsive: {}
      }
    ]
  };
}

async function withVisualFallbackEnv(callback: () => Promise<void>) {
  const previous = {
    force: process.env.FORCE_VISUAL_SNAPSHOT,
    universal: process.env.UNIVERSAL_INPUT_ANALYSIS,
    safe: process.env.SAFE_FULL_PAGE_FALLBACK
  };

  process.env.FORCE_VISUAL_SNAPSHOT = "true";
  process.env.UNIVERSAL_INPUT_ANALYSIS = "true";
  process.env.SAFE_FULL_PAGE_FALLBACK = "true";

  try {
    await callback();
  } finally {
    process.env.FORCE_VISUAL_SNAPSHOT = previous.force;
    process.env.UNIVERSAL_INPUT_ANALYSIS = previous.universal;
    process.env.SAFE_FULL_PAGE_FALLBACK = previous.safe;
  }
}

async function withDebugConversionEnv(callback: () => Promise<void>) {
  const previous = process.env.DEBUG_CONVERSION;
  process.env.DEBUG_CONVERSION = "true";

  try {
    await callback();
  } finally {
    process.env.DEBUG_CONVERSION = previous;
  }
}

async function testValidateContentIntegrityBlocksEmptyOutput() {
  const report = await validateContentIntegrity({
    capture: createMockCapture(),
    layout: createMockLayout(),
    document: {
      version: "1.0",
      title: "Empty Export",
      type: "page",
      content: []
    },
    emittedMode: "editable",
    outputFile: path.join(os.tmpdir(), "elementor-empty.json"),
    failureStage: "editable-emitter"
  });

  assert.equal(report.status, "blocked");
  assert.equal(report.failureStage, "editable-emitter");
  assert.equal(report.convertedBodyEmpty, true);
  assert.equal(report.hasRealWidgets, false);
  assert.equal(report.outputSectionCount, 0);
  assert.match(report.failureReason ?? "", /Elementor JSON foi gerado sem secoes\/widgets reais/);
  assert.throws(() => assertContentIntegrity(report), (error: unknown) => {
    assert.equal(error instanceof ContentIntegrityError, true);
    assert.equal(
      (error as ContentIntegrityError).message,
      "Exportação bloqueada: saída convertida sem conteúdo detectável."
    );
    return true;
  });
}

async function testValidateContentIntegrityThrowsClearFullPageSnapshotError() {
  await withVisualFallbackEnv(async () => {
    const report = await validateContentIntegrity({
      capture: createMockCapture(),
      layout: createMockLayout(),
      document: {
        version: "1.0",
        title: "Broken Full Page Snapshot",
        type: "page",
        content: []
      },
      emittedMode: "snapshot",
      snapshot: {
        renderStrategy: "full-page-snapshot",
        fullPageFallbackReason: "Separacao por secoes falhou; usando snapshot da pagina inteira.",
        overallSimilarity: 0,
        threshold: 0.99,
        sectionReports: [],
        totals: {
          htmlSections: 0,
          snapshotSections: 0,
          preservedLinks: 0,
          totalLinks: 0
        }
      },
      outputFile: path.join(os.tmpdir(), "elementor-full-page-empty.json"),
      failureStage: "full-page-snapshot"
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.modeUsed, "full-page-snapshot");
    assert.equal(report.snapshotGenerated, false);
    assert.equal(report.failureStage, "full-page-snapshot");
    assert.throws(() => assertContentIntegrity(report), (error: unknown) => {
      assert.equal(error instanceof ContentIntegrityError, true);
      assert.equal(
        (error as ContentIntegrityError).message,
        "Falha no full-page snapshot: não foi possível capturar conteúdo visual da página original."
      );
      return true;
    });
  });
}

async function testGenericRecoveryEscalatesBlockedNativeOutput() {
  const capture = createMockCapture();
  const layout = createMockLayout();
  const report = await validateContentIntegrity({
    capture,
    layout,
    document: {
      version: "1.0",
      title: "Blocked Native Export",
      type: "page",
      content: []
    },
    emittedMode: "hybrid",
    outputFile: path.join(os.tmpdir(), "elementor-blocked-native.json"),
    failureStage: "hybrid-emitter"
  });

  assert.equal(report.status, "blocked");
  assert.equal(
    shouldRecoverBlockedExportWithSnapshot({
      forceVisualSnapshot: false,
      emittedMode: "hybrid",
      capture,
      layout,
      contentIntegrity: report
    }),
    true
  );
}

async function testGenericRecoverySkipsWhenOriginalNeverRendered() {
  const capture = createMockCapture({
    inputAnalysis: createMockInputAnalysis({
      diagnostics: {
        errors: ["browser render failed"],
        warnings: [],
        resources: [],
        htmlRendered: false,
        cssLoaded: false,
        imagesLoaded: false,
        relativeAssetsResolved: false,
        viewportMatched: false,
        rendererUsed: "browser",
        sectionCroppingRisk: false,
        fullPageSnapshotFailed: false
      }
    })
  });
  const layout = createMockLayout();
  const report = await validateContentIntegrity({
    capture,
    layout,
    document: {
      version: "1.0",
      title: "Unrendered Native Export",
      type: "page",
      content: []
    },
    emittedMode: "hybrid",
    outputFile: path.join(os.tmpdir(), "elementor-unrendered-native.json"),
    failureStage: "browser-render"
  });

  assert.equal(report.status, "blocked");
  assert.equal(
    shouldRecoverBlockedExportWithSnapshot({
      forceVisualSnapshot: false,
      emittedMode: "hybrid",
      capture,
      layout,
      contentIntegrity: report
    }),
    false
  );
}

async function testVisualFallbackProducesNonEmptyOutputForRuntimeFixture() {
  await withVisualFallbackEnv(async () => {
    const fixturePath = path.join(FIXTURE_DIR, "vite-react-export.html");
    const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-empty-output-tests");
    const resolvedSource = await resolveSourceFromLocalFile(fixturePath);
    const result = await runExportPipelineV3(resolvedSource, {
      preferBrowser: true,
      outputRoot
    });

    assert.equal(result.contentIntegrity.status, "passed");
    assert.equal(
      result.contentIntegrity.snapshotGenerated ||
        result.contentIntegrity.modeUsed === "pixel-perfect",
      true
    );
    assert.equal(
      result.contentIntegrity.modeUsed === "full-page-snapshot" ||
        result.contentIntegrity.modeUsed === "pixel-perfect",
      true
    );
    assert.equal(result.contentIntegrity.visibleContentDetected, true);
    assert.equal(result.contentIntegrity.hasRealWidgets, true);
    assert.equal(result.elementorDocument.content.length >= 1, true);
    assert.ok(result.artifacts.contentIntegrityReportPath);
    await access(result.artifacts.contentIntegrityReportPath as string);

    const report = JSON.parse(
      await readFile(result.artifacts.contentIntegrityReportPath as string, "utf8")
    ) as ContentIntegrityReport;

    assert.equal(report.status, "passed");
    assert.equal(report.snapshotGenerated || report.modeUsed === "pixel-perfect", true);
    assert.equal(
      report.modeUsed === "full-page-snapshot" || report.modeUsed === "pixel-perfect",
      true
    );
  });
}

async function testDebugConversionWritesArtifactsWhenEnabled() {
  await withDebugConversionEnv(async () => {
    const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-debug-tests");
    const result = await runExportPipelineV3FromHtml(
      `<!doctype html>
<html>
  <head>
    <title>Debug Conversion Fixture</title>
  </head>
  <body>
    <section style="display:flex;gap:24px;padding:32px;background:#f6f0e8;">
      <div>
        <h1>Debug hero</h1>
        <p>Track visible content end to end.</p>
        <a href="#cta">Call to action</a>
      </div>
      <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="Debug visual" />
    </section>
  </body>
</html>`,
      {
        preferBrowser: true,
        outputRoot
      }
    );

    assert.equal(result.contentIntegrity.status, "passed");
    assert.ok(result.contentIntegrity.debugArtifacts?.debugConversionDir);
    assert.ok(result.contentIntegrity.debugArtifacts?.originalScreenshotPath);
    assert.ok(result.contentIntegrity.debugArtifacts?.convertedScreenshotPath);
    assert.ok(result.contentIntegrity.debugArtifacts?.extractedElementsPath);
    assert.ok(result.contentIntegrity.debugArtifacts?.detectedSectionsPath);
    assert.ok(result.contentIntegrity.debugArtifacts?.lostElementsPath);
    assert.ok(result.contentIntegrity.debugArtifacts?.conversionReportPath);
    await access(result.contentIntegrity.debugArtifacts?.originalScreenshotPath as string);
    await access(result.contentIntegrity.debugArtifacts?.convertedScreenshotPath as string);
    await access(result.contentIntegrity.debugArtifacts?.extractedElementsPath as string);
    await access(result.contentIntegrity.debugArtifacts?.detectedSectionsPath as string);
    await access(result.contentIntegrity.debugArtifacts?.lostElementsPath as string);
    await access(result.contentIntegrity.debugArtifacts?.conversionReportPath as string);

    const report = JSON.parse(
      await readFile(result.contentIntegrity.debugArtifacts?.conversionReportPath as string, "utf8")
    ) as {
      originalElements: number;
      extractedElements: number;
      convertedElements: number;
      lostElements: number;
      emptyExport: {
        happened: boolean;
      };
    };

    assert.equal(report.originalElements >= report.extractedElements, true);
    assert.equal(report.convertedElements > 0, true);
    assert.equal(report.lostElements, 0);
    assert.equal(report.emptyExport.happened, false);
  });
}

async function testDebugConversionReportExplainsEmptyExport() {
  const capture = createMockCapture({
    id: "content-integrity-debug-empty",
    title: "Debug Empty Export"
  });
  const layout = createMockLayout();
  const validation = {
    passed: false,
    mode: "editable" as const,
    issueCount: 3,
    issues: [
      {
        type: "missing-text" as const,
        nodeId: "hero-title",
        message: 'Texto visivel perdido: "Hero title".'
      },
      {
        type: "missing-image" as const,
        nodeId: "hero-image",
        message: "Imagem ou background visual perdido: hero.png."
      },
      {
        type: "missing-button" as const,
        nodeId: "hero-button",
        message: 'Botao visivel perdido: "Buy now".'
      }
    ],
    stats: {
      expectedTexts: 1,
      matchedTexts: 0,
      expectedImages: 1,
      matchedImages: 0,
      expectedButtons: 1,
      matchedButtons: 0,
      expectedLinks: 1,
      matchedLinks: 0,
      expectedSections: 1,
      matchedSections: 0,
      expectedCards: 0,
      matchedCards: 0,
      expectedHeaders: 0,
      matchedHeaders: 0,
      expectedFooters: 0,
      matchedFooters: 0,
      expectedPositionedNodes: 3,
      matchedPositionedNodes: 0
    }
  };
  const contentIntegrity = await validateContentIntegrity({
    capture,
    layout,
    document: {
      version: "1.0",
      title: "Empty Debug Export",
      type: "page",
      content: []
    },
    emittedMode: "editable",
    outputFile: path.join(os.tmpdir(), "elementor-debug-empty.json"),
    failureStage: "editable-emitter"
  });
  const report = buildExportReport({
    capture,
    layout,
    analysis: {
      score: 1,
      overlappingGroups: 0,
      gridContainers: 0,
      flexContainers: 1,
      absoluteNodes: 0,
      decorativeNodes: 0,
      interactiveNodes: 1,
      selectedMode: "editable",
      reasons: ["debug test"]
    },
    emittedMode: "editable",
    validation,
    snapshotEnabled: false,
    snapshotReason: "Debug conversion test.",
    warnings: contentIntegrity.failureReason ? [contentIntegrity.failureReason] : []
  });
  const debugBundle = await writeConversionDebugBundle({
    capture,
    layout,
    document: {
      version: "1.0",
      title: "Empty Debug Export",
      type: "page",
      content: []
    },
    validation,
    contentIntegrity,
    report
  });

  assert.equal(contentIntegrity.status, "blocked");
  assert.equal(debugBundle.lostElements.length > 0, true);

  const conversionReport = JSON.parse(
    await readFile(debugBundle.conversionReportPath, "utf8")
  ) as {
    convertedElements: number;
    lostElements: number;
    emptyExport: {
      happened: boolean;
      failureStage?: string;
      reason?: string;
    };
  };

  assert.equal(conversionReport.convertedElements, 0);
  assert.equal(conversionReport.lostElements > 0, true);
  assert.equal(conversionReport.emptyExport.happened, true);
  assert.equal(conversionReport.emptyExport.failureStage, "editable-emitter");
  assert.match(
    conversionReport.emptyExport.reason ?? "",
    /body convertido ficou vazio|Elementor JSON foi gerado sem secoes\/widgets reais/i
  );
}

async function main() {
  await testValidateContentIntegrityBlocksEmptyOutput();
  await testValidateContentIntegrityThrowsClearFullPageSnapshotError();
  await testGenericRecoveryEscalatesBlockedNativeOutput();
  await testGenericRecoverySkipsWhenOriginalNeverRendered();
  await testVisualFallbackProducesNonEmptyOutputForRuntimeFixture();
  await testDebugConversionWritesArtifactsWhenEnabled();
  await testDebugConversionReportExplainsEmptyExport();
  console.log("converter v3 empty output tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
