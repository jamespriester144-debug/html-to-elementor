import assert from "node:assert/strict";

import {
  createConvertPostHandler,
  type ConvertRouteDependencies
} from "../lib/api/convert-route";
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
  warnings?: string[];
  fallbackReason?: string;
} = {
  emittedMode: "snapshot",
  selectedMode: "snapshot",
  renderer: "browser",
  snapshotEnabled: true,
  snapshotReason: "Snapshot validado com similaridade 99.50%.",
  snapshotSimilarity: 0.995
}) {
  const warnings = params.warnings ?? [];
  const snapshot =
    params.emittedMode === "snapshot" || params.snapshotSimilarity
      ? {
          overallSimilarity: params.snapshotSimilarity ?? 0.995,
          threshold: 0.99,
          convertedScreenshotPath: "/tmp/export/snapshot-preview.png",
          originalScreenshotPath: "/tmp/capture/desktop.png",
          sectionReports: [],
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
        passed: true,
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
      passed: true,
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
    snapshot,
    artifacts: {
      elementorTemplatePath: "/tmp/export/elementor-template.json",
      reportPath: "/tmp/export/conversion-report.json",
      previewHtmlPath: "/tmp/export/snapshot-preview.html",
      convertedScreenshotPath: snapshot?.convertedScreenshotPath
    }
  } as never;
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
    assert.equal(html, "<html><body>rendered primary</body></html>");
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
  assert.deepEqual(payload.screenshots, {
    desktop: "/tmp/capture/desktop.png",
    mobile: "/tmp/capture/mobile.png"
  });
  assert.deepEqual(payload.warnings, []);
  assert.equal(
    (payload.artifacts as { capture: { outputDir: string } }).capture.outputDir,
    "/tmp/capture"
  );
  assert.equal(persistedHtml, "<html><body>rendered primary</body></html>");
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

async function main() {
  await testConvertRouteUsesV3ForRawHtmlAndForcesBrowserCapture();
  await testConvertRouteUsesV3ResolverForUploadAndAllowsPixelPerfect();
  await testConvertRouteBlocksWhenBrowserCaptureFallsBackToServer();
  await testConvertRouteBlocksWhenSimilarityFallsBelowThreshold();
  await testConvertRouteReturns500WhenV3Fails();
  await testConvertRouteBlocksWhenValidationFails();
  console.log("convert route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
