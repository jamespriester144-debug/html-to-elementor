import assert from "node:assert/strict";

import {
  createConvertPostHandler,
  type ConvertRouteDependencies
} from "../lib/api/convert-route";
import type { ExportPipelineResult } from "../lib/converter-v3/contracts/output";
import { ContentIntegrityError } from "../lib/converter-v3/validate/content-integrity";
import { VisualValidationError } from "../lib/converter-v3/visual-regression-validator";

function createBaseDependencies(): ConvertRouteDependencies {
  return {
    createConversion: async () =>
      ({
        id: "conversion-id"
      }) as never,
    createConversionKey: () => "conversion-key",
    persistEmbeddedConversionAssets: async (html, elementorJson) => ({
      html,
      elementorJson
    }),
    resolveSourceFromHtml: (html) => ({
      id: "resolved-html",
      sourceKind: "raw-html" as const,
      title: "Resolved HTML",
      html,
      assets: [],
      entryFile: null,
      routeFile: null,
      archiveFileCount: 0,
      notes: ["resolved from html"]
    }),
    resolveSourceFromUpload: async (file) => ({
      id: "resolved-upload",
      sourceKind: "static-html-archive" as const,
      title: file.name,
      html: "<html><body>upload html</body></html>",
      assets: [],
      entryFile: "index.html",
      routeFile: null,
      archiveFileCount: 1,
      notes: ["resolved from upload"]
    }),
    runExportPipelineV3: async () =>
      createExportResult({
        emittedMode: "snapshot",
        selectedMode: "snapshot",
        renderer: "browser",
        snapshotEnabled: true,
        snapshotReason: "Snapshot validado com similaridade 99.50%.",
        snapshotSimilarity: 0.995
      })
  };
}

function createExportResult(params: {
  emittedMode: "snapshot" | "pixel-perfect" | "hybrid" | "editable";
  selectedMode: "snapshot" | "pixel-perfect" | "hybrid" | "editable";
  renderer: "browser" | "server";
  snapshotEnabled: boolean;
  snapshotReason: string;
  snapshotSimilarity?: number;
  viewportResults?: Array<{
    viewport: "desktop" | "tablet" | "mobile";
    passed: boolean;
    similarity: number;
    similarityPercent?: string;
  }>;
  visualValidationStatus?: "passed" | "blocked";
  warnings?: string[];
  fallbackReason?: string;
  previewHtml?: string;
} = {
  emittedMode: "snapshot",
  selectedMode: "snapshot",
  renderer: "browser",
  snapshotEnabled: true,
  snapshotReason: "Snapshot validado com similaridade 99.50%.",
  snapshotSimilarity: 0.995
}): ExportPipelineResult {
  const warnings = params.warnings ?? [];
  const defaultSimilarity = params.snapshotSimilarity ?? 0.995;
  const snapshotPassed =
    params.snapshotSimilarity === undefined || params.snapshotSimilarity >= 0.99;
  const viewportResults: Array<{
    viewport: "desktop" | "tablet" | "mobile";
    passed: boolean;
    similarity: number;
    similarityPercent?: string;
  }> =
    params.viewportResults ??
    (params.snapshotSimilarity !== undefined
      ? (["desktop", "tablet", "mobile"] as const).map((viewport) => ({
          viewport,
          passed: snapshotPassed,
          similarity: defaultSimilarity,
          similarityPercent: `${(defaultSimilarity * 100).toFixed(2)}%`
        }))
      : []);
  const visualValidationStatus =
    params.visualValidationStatus ??
    (viewportResults.every((viewport) => viewport.passed) && snapshotPassed
      ? "passed"
      : "blocked");
  const visualValidationSummary =
    viewportResults.length > 0
      ? [
          "[Visual Validation]",
          ...viewportResults.map((viewport) => {
            const label =
              viewport.viewport === "desktop"
                ? "Desktop"
                : viewport.viewport === "tablet"
                  ? "Tablet"
                  : "Mobile";

            return `${label}: ${(viewport.similarity * 100).toFixed(1)}% - ${
              viewport.passed ? "ok" : "falhou"
            }`;
          }),
          visualValidationStatus === "passed"
            ? "Exportacao liberada"
            : "Exportacao bloqueada"
        ]
      : [];
  const snapshot =
    params.emittedMode === "snapshot" || params.snapshotSimilarity
      ? {
          overallSimilarity: defaultSimilarity,
          threshold: 0.99,
          convertedScreenshotPath: "/tmp/export/snapshot-preview.png",
          originalScreenshotPath: "/tmp/capture/desktop.png",
          viewportSimilarities: {
            desktop: defaultSimilarity,
            tablet: defaultSimilarity,
            mobile: defaultSimilarity
          },
          sectionReports: [],
          visualValidationReport: {
            status: visualValidationStatus,
            modeUsed: "section-snapshot",
            viewportsTested: viewportResults.map((viewport) => viewport.viewport),
            sectionsApproved: [],
            sectionsWithFallback: [],
            linksPreserved: 1,
            totalLinks: 1,
            similarityFinal: defaultSimilarity,
            similarityFinalPercent: `${(defaultSimilarity * 100).toFixed(2)}%`,
            viewportResults,
            issues: [],
            blockingReason:
              visualValidationStatus === "blocked"
                ? `Conversao bloqueada: similaridade visual final ficou em ${(
                    defaultSimilarity * 100
                  ).toFixed(2)}%.`
                : undefined
          },
          totals: {
            htmlSections: 1,
            snapshotSections: 1,
            preservedLinks: 1,
            totalLinks: 1
          }
        }
      : undefined;

  return {
    resolvedSource: {
      id: "resolved-html",
      sourceKind: "raw-html",
      title: "Resolved HTML"
    },
    analysis: {
      score: 1,
      overlappingGroups: 0,
      gridContainers: 0,
      flexContainers: 1,
      absoluteNodes: 0,
      decorativeNodes: 0,
      interactiveNodes: 1,
      selectedMode: params.selectedMode,
      reasons: ["test analysis"]
    },
    emittedMode: params.emittedMode,
    fallbackReason: params.fallbackReason,
    layout: {
      id: "layout-id",
      title: "Resolved HTML Layout",
      sourceKind: "raw-html",
      rootNodeId: "root",
      nodeCount: 2,
      sectionIds: ["root"],
      semanticIndex: {},
      detectedSections: [],
      nodes: []
    },
    report: {
      id: "report-id",
      title: "Resolved HTML",
      sourceKind: "raw-html",
      renderer: params.renderer,
      snapshotEnabled: params.snapshotEnabled,
      snapshotReason: params.snapshotReason,
      selectedMode: params.selectedMode,
      emittedMode: params.emittedMode,
      summary: {
        totalNodes: 2,
        visibleNodes: 2,
        images: 1,
        buttons: 1,
        textBlocks: 1,
        sections: 1
      },
      layout: {
        rootNodeId: "root",
        nodeCount: 2,
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
        selectedMode: params.selectedMode,
        reasons: ["test analysis"]
      },
      validation: {
        passed: snapshotPassed,
        mode: params.emittedMode,
        issueCount: 0,
        issues: [],
        stats: {
          expectedTexts: 1,
          matchedTexts: 1,
          expectedImages: 1,
          matchedImages: 1,
          expectedButtons: 1,
          matchedButtons: 1,
          expectedLinks: 1,
          matchedLinks: 1,
          expectedSections: 1,
          matchedSections: 1,
          expectedCards: 0,
          matchedCards: 0,
          expectedHeaders: 0,
          matchedHeaders: 0,
          expectedFooters: 0,
          matchedFooters: 0,
          expectedPositionedNodes: 2,
          matchedPositionedNodes: 2
        }
      },
      viewportSimilarities:
        params.snapshotSimilarity !== undefined
          ? {
              desktop: params.snapshotSimilarity,
              tablet: params.snapshotSimilarity,
              mobile: params.snapshotSimilarity
            }
          : undefined,
      visualIssues: [],
      visualValidationSummary,
      visualLogs: [
        ...visualValidationSummary,
        "[VISUAL SNAPSHOT] Secao 01 (mock-section) capturada com sucesso",
        "[LINK OVERLAY] 1 links preservados",
        ...(params.snapshotSimilarity !== undefined
          ? [`[VALIDATION] similaridade desktop: ${(params.snapshotSimilarity * 100).toFixed(2)}%`]
          : []),
        snapshotPassed ? "[EXPORT] aprovado" : "[EXPORT] bloqueado: 1 perda(s) detectada(s)"
      ],
      themeLogs: [],
      warnings,
      snapshot
    },
    capture: {
      renderedHtml: "<html><body>rendered primary</body></html>",
      renderer: params.renderer,
      artifacts: {
        outputDir: "/tmp/capture",
        screenshots: {
          desktop: "/tmp/capture/desktop.png",
          mobile: "/tmp/capture/mobile.png"
        }
      }
    },
    elementorDocument: {
      version: "1.0",
      title: "Resolved HTML",
      type: "page",
      content: []
    },
    validation: {
      passed: snapshotPassed,
      mode: params.emittedMode,
      issueCount: 0,
      issues: [],
      stats: {
        expectedTexts: 1,
        matchedTexts: 1,
        expectedImages: 1,
        matchedImages: 1,
        expectedButtons: 1,
        matchedButtons: 1,
        expectedLinks: 1,
        matchedLinks: 1,
        expectedSections: 1,
        matchedSections: 1,
        expectedCards: 0,
        matchedCards: 0,
        expectedHeaders: 0,
        matchedHeaders: 0,
        expectedFooters: 0,
        matchedFooters: 0,
        expectedPositionedNodes: 2,
        matchedPositionedNodes: 2
      }
    },
    contentIntegrity: {
      status: "passed",
      inputFile: "/tmp/source/index.html",
      outputFile: "/tmp/export/elementor-template.json",
      sourceHtmlSize: 64,
      originalHtmlSize: 96,
      renderedHtmlSize: 96,
      outputSize: 512,
      elementorJsonSize: 384,
      previewHtmlSize: 128,
      originalTextCount: 1,
      outputTextCount: 1,
      originalImageCount: 1,
      outputImageCount: 1,
      originalButtonCount: 1,
      outputButtonCount: 1,
      originalLinkCount: 1,
      outputLinkCount: 1,
      originalSectionCount: 1,
      outputSectionCount: 1,
      originalVisibleHeight: 800,
      convertedVisibleHeight: 800,
      visibleContentDetected: true,
      convertedBodyEmpty: false,
      hasRealWidgets: true,
      snapshotGenerated: params.emittedMode === "snapshot",
      overlaysGenerated: params.emittedMode === "snapshot",
      modeUsed:
        params.emittedMode === "snapshot"
          ? "section-snapshot"
          : params.emittedMode === "pixel-perfect"
            ? "pixel-perfect"
            : params.emittedMode === "hybrid"
              ? "hybrid"
              : "editable",
      recommendation: "mock report",
      errorsFound: []
    },
    snapshot,
    previewHtml: params.previewHtml ?? "<html><body>converted preview</body></html>",
    artifacts: {
      elementorTemplatePath: "/tmp/export/elementor-template.json",
      reportPath: "/tmp/export/conversion-report.json",
      previewHtmlPath: "/tmp/export/snapshot-preview.html",
      convertedScreenshotPath: snapshot?.convertedScreenshotPath,
      contentIntegrityReportPath: "/tmp/export/content-integrity-report.json"
    }
  } as unknown as ExportPipelineResult;
}

async function testConvertRouteUsesV3ForRawHtmlAndForcesBrowserCapture() {
  const calls = {
    resolveHtml: 0,
    runV3: 0
  };
  let persistedHtml = "";

  const deps = createBaseDependencies();
  deps.resolveSourceFromHtml = (html) => {
    calls.resolveHtml += 1;
    assert.equal(html, "<main><h1>Route HTML</h1></main>");

    return {
      id: "resolved-html",
      sourceKind: "raw-html",
      title: "Route HTML",
      html,
      assets: [],
      entryFile: null,
      routeFile: null,
      archiveFileCount: 0,
      notes: []
    };
  };
  deps.runExportPipelineV3 = async (resolvedSource, options) => {
    calls.runV3 += 1;
    assert.equal(resolvedSource.id, "resolved-html");
    assert.deepEqual(options, { preferBrowser: true });

    return createExportResult({
      emittedMode: "snapshot",
      selectedMode: "snapshot",
      renderer: "browser",
      snapshotEnabled: true,
      snapshotReason: "Snapshot validado com similaridade 99.50%.",
      snapshotSimilarity: 0.995
    });
  };
  deps.persistEmbeddedConversionAssets = async (html, elementorJson, key) => {
    persistedHtml = html;
    assert.equal(key, "conversion-key");

    return {
      html,
      elementorJson
    };
  };
  deps.createConversion = async (html, elementorJson) => {
    assert.equal(html, "<html><body>converted preview</body></html>");
    assert.equal(elementorJson.title, "Resolved HTML");

    return {
      id: "conversion-v3"
    } as never;
  };

  const handler = createConvertPostHandler(deps);
  const response = await handler(
    new Request("http://localhost/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        html: "<main><h1>Route HTML</h1></main>"
      })
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(payload.id, "conversion-v3");
  assert.equal(payload.status, "success");
  assert.equal(payload.selectedMode, "snapshot");
  assert.equal(payload.emittedMode, "snapshot");
  assert.equal(payload.snapshotEnabled, true);
  assert.equal(payload.snapshotReason, "Snapshot validado com similaridade 99.50%.");
  assert.deepEqual(payload.visualValidationSummary, [
    "[Visual Validation]",
    "Desktop: 99.5% - ok",
    "Tablet: 99.5% - ok",
    "Mobile: 99.5% - ok",
    "Exportacao liberada"
  ]);
  assert.deepEqual(
    (payload.report as { visualValidationSummary: string[] }).visualValidationSummary,
    payload.visualValidationSummary
  );
  assert.deepEqual(payload.screenshots, {
    desktop: "/tmp/capture/desktop.png",
    mobile: "/tmp/capture/mobile.png"
  });
  assert.deepEqual(payload.warnings, []);
  assert.equal(
    (payload.artifacts as { capture: { outputDir: string } }).capture.outputDir,
    "/tmp/capture"
  );
  assert.equal(persistedHtml, "<html><body>converted preview</body></html>");
  assert.equal(calls.resolveHtml, 1);
  assert.equal(calls.runV3, 1);
}

async function testConvertRouteUsesV3ResolverForUploadAndAllowsPixelPerfect() {
  let resolveUploadCalls = 0;
  let runV3Calls = 0;

  const deps = createBaseDependencies();
  deps.resolveSourceFromUpload = async (file) => {
    resolveUploadCalls += 1;
    assert.equal(file.name, "site.zip");

    return {
      id: "resolved-upload",
      sourceKind: "static-html-archive",
      title: "ZIP upload",
      html: "<html><body>upload html</body></html>",
      assets: [],
      entryFile: "index.html",
      routeFile: null,
      archiveFileCount: 3,
      notes: []
    };
  };
  deps.runExportPipelineV3 = async (_resolvedSource, options) => {
    runV3Calls += 1;
    assert.deepEqual(options, { preferBrowser: true });

    return createExportResult({
      emittedMode: "pixel-perfect",
      selectedMode: "pixel-perfect",
      renderer: "browser",
      snapshotEnabled: false,
      snapshotReason:
        "Captura do navegador concluida, mas nenhuma secao elegivel para snapshot foi detectada."
    });
  };
  deps.createConversion = async () =>
    ({
      id: "conversion-upload"
    }) as never;

  const formData = new FormData();
  formData.append(
    "file",
    new File(["zip-content"], "site.zip", {
      type: "application/zip"
    })
  );

  const handler = createConvertPostHandler(deps);
  const response = await handler(
    new Request("http://localhost/api/convert", {
      method: "POST",
      body: formData
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(payload.id, "conversion-upload");
  assert.equal(payload.selectedMode, "pixel-perfect");
  assert.equal(payload.emittedMode, "pixel-perfect");
  assert.equal(payload.snapshotEnabled, false);
  assert.equal(
    payload.snapshotReason,
    "Captura do navegador concluida, mas nenhuma secao elegivel para snapshot foi detectada."
  );
  assert.deepEqual(payload.visualValidationSummary, []);
  assert.equal(resolveUploadCalls, 1);
  assert.equal(runV3Calls, 1);
}

async function testConvertRouteBlocksWhenBrowserCaptureFallsBackToServer() {
  let createConversionCalls = 0;

  const deps = createBaseDependencies();
  deps.runExportPipelineV3 = async (_resolvedSource, options) => {
    assert.deepEqual(options, { preferBrowser: true });

    return createExportResult({
      emittedMode: "pixel-perfect",
      selectedMode: "pixel-perfect",
      renderer: "server",
      snapshotEnabled: false,
      snapshotReason:
        "Captura visual do navegador falhou. Snapshot não pôde ser gerado."
    });
  };
  deps.createConversion = async () => {
    createConversionCalls += 1;
    return {
      id: "should-not-happen"
    } as never;
  };

  const handler = createConvertPostHandler(deps);
  const response = await handler(
    new Request("http://localhost/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        html: "<main>fallback me</main>"
      })
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 422);
  assert.equal(
    payload.error,
    "Captura visual do navegador falhou. Snapshot não pôde ser gerado."
  );
  assert.equal(payload.renderer, "server");
  assert.equal(payload.snapshotEnabled, false);
  assert.equal(
    payload.snapshotReason,
    "Captura visual do navegador falhou. Snapshot não pôde ser gerado."
  );
  assert.deepEqual(payload.visualValidationSummary, []);
  assert.equal(createConversionCalls, 0);
}

async function testConvertRouteBlocksWhenSimilarityFallsBelowThreshold() {
  const deps = createBaseDependencies();
  deps.runExportPipelineV3 = async () =>
    createExportResult({
      emittedMode: "snapshot",
      selectedMode: "snapshot",
      renderer: "browser",
      snapshotEnabled: true,
      snapshotReason: "Snapshot validado com similaridade 98.40%.",
      snapshotSimilarity: 0.984
    });

  const handler = createConvertPostHandler(deps);
  const response = await handler(
    new Request("http://localhost/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        html: "<main>low similarity</main>"
      })
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 422);
  assert.match(String(payload.error), /similaridade visual final ficou em 98\.40%/);
  assert.deepEqual(payload.visualValidationSummary, [
    "[Visual Validation]",
    "Desktop: 98.4% - falhou",
    "Tablet: 98.4% - falhou",
    "Mobile: 98.4% - falhou",
    "Exportacao bloqueada"
  ]);
  assert.deepEqual(
    (payload.report as { visualValidationSummary: string[] }).visualValidationSummary,
    payload.visualValidationSummary
  );
}

async function testConvertRouteBlocksWhenAnyViewportFailsAboveThreshold() {
  const deps = createBaseDependencies();
  deps.runExportPipelineV3 = async () => {
    const result = createExportResult({
      emittedMode: "snapshot",
      selectedMode: "snapshot",
      renderer: "browser",
      snapshotEnabled: true,
      snapshotReason: "Snapshot validado com similaridade 99.50%.",
      snapshotSimilarity: 0.995,
      viewportResults: [
        {
          viewport: "desktop",
          passed: true,
          similarity: 0.995,
          similarityPercent: "99.50%"
        },
        {
          viewport: "tablet",
          passed: false,
          similarity: 0.991,
          similarityPercent: "99.10%"
        },
        {
          viewport: "mobile",
          passed: true,
          similarity: 0.997,
          similarityPercent: "99.70%"
        }
      ],
      visualValidationStatus: "passed"
    });

    result.snapshot!.visualValidationReport!.viewportResults[1]!.passed = false;
    result.report.visualValidationSummary = [
      "[Visual Validation]",
      "Desktop: 99.5% - ok",
      "Tablet: 99.1% - falhou",
      "Problema: cards ficaram desalinhados",
      "Mobile: 99.7% - ok",
      "Exportacao bloqueada"
    ];

    return result;
  };

  const handler = createConvertPostHandler(deps);
  const response = await handler(
    new Request("http://localhost/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        html: "<main>failed viewport</main>"
      })
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 422);
  assert.match(
    String(payload.error),
    /validacao visual falhou nos viewports tablet \(99\.10%\)/i
  );
  assert.deepEqual(payload.visualValidationSummary, [
    "[Visual Validation]",
    "Desktop: 99.5% - ok",
    "Tablet: 99.1% - falhou",
    "Problema: cards ficaram desalinhados",
    "Mobile: 99.7% - ok",
    "Exportacao bloqueada"
  ]);
}

async function testConvertRouteBlocksWhenVisualValidationStatusIsBlocked() {
  const deps = createBaseDependencies();
  deps.runExportPipelineV3 = async () => {
    const result = createExportResult({
      emittedMode: "snapshot",
      selectedMode: "snapshot",
      renderer: "browser",
      snapshotEnabled: true,
      snapshotReason: "Snapshot visual bloqueado por perda na Hero.",
      snapshotSimilarity: 0.995,
      visualValidationStatus: "blocked"
    });

    result.snapshot!.visualValidationReport!.blockingReason =
      "Conversao bloqueada: secao Hero perdeu 2 imagens no desktop.";
    result.snapshot!.visualValidationReport!.issues = [
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
        convertedScreenshotPath: "/tmp/export/snapshot-preview.png",
        diffScreenshotPath: "/tmp/export/full-page-diff.png",
        message:
          "Viewport desktop; secao hero-1 (hero-section) tipo Hero; similaridade 98.40%; perda detectada: image; fallback usado: full-page-snapshot."
      }
    ];
    result.report.visualIssues = [
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
        convertedScreenshotPath: "/tmp/export/snapshot-preview.png",
        diffScreenshotPath: "/tmp/export/full-page-diff.png",
        fallbackStage: "full-page-snapshot",
        message: "Hero perdeu 2 imagens."
      }
    ];
    result.report.visualValidationSummary = [
      "[Visual Validation]",
      "Desktop: 98.4% - falhou",
      "Problema: secao Hero perdeu 2 imagens",
      "Tablet: 99.5% - ok",
      "Mobile: 99.5% - ok",
      "Exportacao bloqueada"
    ];

    return result;
  };

  const handler = createConvertPostHandler(deps);
  const response = await handler(
    new Request("http://localhost/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        html: "<main>blocked validation status</main>"
      })
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 422);
  assert.equal(
    payload.error,
    "Conversao bloqueada: secao Hero perdeu 2 imagens no desktop."
  );
  assert.equal(
    (payload.report as { visualIssues: Array<{ sectionTypeLabel?: string }> }).visualIssues[0]
      ?.sectionTypeLabel,
    "Hero"
  );
  assert.deepEqual(
    (payload.report as { visualIssues: Array<{ bbox?: { x: number; y: number; width: number; height: number } }> }).visualIssues[0]?.bbox,
    {
      x: 24,
      y: 32,
      width: 180,
      height: 120
    }
  );
}

async function testConvertRouteReturns500WhenV3Fails() {
  const deps = createBaseDependencies();
  deps.runExportPipelineV3 = async () => {
    throw new Error("Puppeteer capture crashed");
  };

  const handler = createConvertPostHandler(deps);
  const response = await handler(
    new Request("http://localhost/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        html: "<main>fallback me</main>"
      })
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 500);
  assert.equal(payload.error, "Puppeteer capture crashed");
}

async function testConvertRouteBlocksWhenValidationFails() {
  const deps = createBaseDependencies();
  deps.runExportPipelineV3 = async () => {
    throw new VisualValidationError({
      passed: false,
      mode: "hybrid",
      issueCount: 2,
      issues: [
        {
          type: "missing-card",
          nodeId: "card-1",
          message: "Card visivel perdido: card-1."
        },
        {
          type: "missing-footer",
          nodeId: "footer-1",
          message: "Footer visivel perdido: footer-1."
        }
      ],
      stats: {
        expectedTexts: 4,
        matchedTexts: 4,
        expectedImages: 1,
        matchedImages: 1,
        expectedButtons: 2,
        matchedButtons: 2,
        expectedLinks: 2,
        matchedLinks: 2,
        expectedSections: 3,
        matchedSections: 3,
        expectedCards: 2,
        matchedCards: 1,
        expectedHeaders: 1,
        matchedHeaders: 1,
        expectedFooters: 1,
        matchedFooters: 0,
        expectedPositionedNodes: 12,
        matchedPositionedNodes: 10
      }
    });
  };

  const handler = createConvertPostHandler(deps);
  const response = await handler(
    new Request("http://localhost/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        html: "<main>validation failure</main>"
      })
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 422);
  assert.match(String(payload.error), /Exportacao bloqueada pela validacao visual/);
  assert.equal((payload.validation as { issueCount: number }).issueCount, 2);
  assert.equal((payload.issues as Array<{ nodeId: string }>)[0]?.nodeId, "card-1");
}

async function testConvertRouteBlocksWhenContentIntegrityFails() {
  const deps = createBaseDependencies();
  deps.runExportPipelineV3 = async () => {
    throw new ContentIntegrityError({
      status: "blocked",
      inputFile: "/tmp/source/runtime-root.html",
      outputFile: "/tmp/export/elementor-template.json",
      sourceHtmlSize: 298,
      originalHtmlSize: 1024,
      renderedHtmlSize: 1024,
      outputSize: 128,
      elementorJsonSize: 96,
      previewHtmlSize: 32,
      originalTextCount: 3,
      outputTextCount: 0,
      originalImageCount: 1,
      outputImageCount: 0,
      originalButtonCount: 1,
      outputButtonCount: 0,
      originalLinkCount: 1,
      outputLinkCount: 0,
      originalSectionCount: 1,
      outputSectionCount: 0,
      originalVisibleHeight: 900,
      convertedVisibleHeight: 0,
      visibleContentDetected: false,
      convertedBodyEmpty: true,
      hasRealWidgets: false,
      snapshotGenerated: false,
      overlaysGenerated: false,
      modeUsed: "full-page-snapshot",
      failureStage: "full-page-snapshot",
      failureReason:
        "Falha no full-page snapshot: nao foi possivel capturar conteudo visual da pagina original.",
      recommendation: "Refaca o full-page snapshot apos estabilizar viewport e assets.",
      errorsFound: [
        "Falha no full-page snapshot: nao foi possivel capturar conteudo visual da pagina original."
      ]
    });
  };

  const handler = createConvertPostHandler(deps);
  const response = await handler(
    new Request("http://localhost/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        html: "<div id=\"root\"></div>"
      })
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 422);
  assert.equal(
    payload.error,
    "Falha no full-page snapshot: não foi possível capturar conteúdo visual da página original."
  );
  assert.equal(
    (payload.contentIntegrity as { failureStage?: string }).failureStage,
    "full-page-snapshot"
  );
}

async function main() {
  await testConvertRouteUsesV3ForRawHtmlAndForcesBrowserCapture();
  await testConvertRouteUsesV3ResolverForUploadAndAllowsPixelPerfect();
  await testConvertRouteBlocksWhenBrowserCaptureFallsBackToServer();
  await testConvertRouteBlocksWhenSimilarityFallsBelowThreshold();
  await testConvertRouteBlocksWhenAnyViewportFailsAboveThreshold();
  await testConvertRouteBlocksWhenVisualValidationStatusIsBlocked();
  await testConvertRouteReturns500WhenV3Fails();
  await testConvertRouteBlocksWhenValidationFails();
  await testConvertRouteBlocksWhenContentIntegrityFails();
  console.log("convert route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
