import assert from "node:assert/strict";

import {
  createConvertPostHandler,
  type ConvertRouteDependencies
} from "../lib/api/convert-route";

function createBaseDependencies(): ConvertRouteDependencies {
  return {
    createConversion: async () =>
      ({
        id: "conversion-id"
      }) as never,
    createConversionKey: () => "conversion-key",
    extractSourceFromUpload: async () => ({
      html: "<html><body>fallback upload</body></html>",
      sourceKind: "static-html-archive" as const
    }),
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
      ({
        resolvedSource: {
          id: "resolved-html",
          sourceKind: "raw-html",
          title: "Resolved HTML"
        },
        analysis: {
          selectedMode: "editable"
        },
        emittedMode: "editable",
        fallbackReason: undefined,
        report: {
          id: "report-id",
          title: "Resolved HTML",
          sourceKind: "raw-html",
          renderer: "browser",
          selectedMode: "editable",
          emittedMode: "editable",
          summary: {
            totalNodes: 1,
            visibleNodes: 1,
            images: 0,
            buttons: 0,
            textBlocks: 1,
            sections: 1
          },
          layout: {
            rootNodeId: "root",
            nodeCount: 1,
            sectionCount: 1
          },
          analysis: {
            selectedMode: "editable"
          },
          warnings: []
        },
        capture: {
          renderedHtml: "<html><body>rendered v3</body></html>",
          renderer: "browser",
          artifacts: {
            screenshots: {
              desktop: "/tmp/desktop.png"
            }
          }
        },
        elementorDocument: {
          version: "0.4",
          title: "Resolved HTML",
          type: "page",
          content: []
        },
        artifacts: {
          elementorTemplatePath: "/tmp/elementor-template.json",
          reportPath: "/tmp/conversion-report.json"
        }
      }) as never,
    runPixelPerfectConversionPipeline: async () =>
      ({
        cleanHtml: "<html><body>fallback clean</body></html>",
        elementorJson: {
          version: "0.4",
          title: "Fallback",
          type: "page",
          content: []
        },
        report: {
          warnings: [],
          screenshots: {},
          exportBlocked: false,
          status: "success"
        },
        outputDir: null,
        sourceKind: "raw-html",
        strategy: "pixel-perfect-iframe-v2"
      }) as never
  };
}

async function testConvertRouteUsesV3ForRawHtml() {
  const calls = {
    resolveHtml: 0,
    runV3: 0,
    runV2: 0
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
  deps.runExportPipelineV3 = async (resolvedSource) => {
    calls.runV3 += 1;
    assert.equal(resolvedSource.id, "resolved-html");

    return {
      resolvedSource: {
        id: resolvedSource.id,
        sourceKind: resolvedSource.sourceKind,
        title: resolvedSource.title
      },
      analysis: {
        selectedMode: "editable"
      },
      emittedMode: "editable",
      fallbackReason: undefined,
      report: {
        id: "report-id",
        title: resolvedSource.title,
        sourceKind: resolvedSource.sourceKind,
        renderer: "browser",
        selectedMode: "editable",
        emittedMode: "editable",
        summary: {
          totalNodes: 2,
          visibleNodes: 2,
          images: 0,
          buttons: 0,
          textBlocks: 1,
          sections: 1
        },
        layout: {
          rootNodeId: "root",
          nodeCount: 2,
          sectionCount: 1
        },
        analysis: {
          selectedMode: "editable"
        },
        warnings: []
      },
      capture: {
        renderedHtml: "<html><body>rendered primary</body></html>",
        renderer: "browser",
        artifacts: {
          outputDir: "/tmp/capture",
          screenshots: {
            desktop: "/tmp/capture/desktop.png",
            mobile: "/tmp/capture/mobile.png"
          }
        }
      },
      elementorDocument: {
        version: "0.4",
        title: resolvedSource.title,
        type: "page",
        content: []
      },
      artifacts: {
        elementorTemplatePath: "/tmp/export/elementor-template.json",
        reportPath: "/tmp/export/conversion-report.json"
      }
    } as never;
  };
  deps.runPixelPerfectConversionPipeline = async () => {
    calls.runV2 += 1;
    throw new Error("converter-v2 should not run when converter-v3 succeeds");
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
    assert.equal(elementorJson.title, "Route HTML");

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
  assert.equal(payload.selectedMode, "editable");
  assert.equal(payload.emittedMode, "editable");
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
  assert.equal(calls.runV2, 0);
}

async function testConvertRouteUsesV3ResolverForUpload() {
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
  deps.runExportPipelineV3 = async (resolvedSource) => {
    runV3Calls += 1;
    assert.equal(resolvedSource.sourceKind, "static-html-archive");

    return {
      resolvedSource: {
        id: resolvedSource.id,
        sourceKind: resolvedSource.sourceKind,
        title: resolvedSource.title
      },
      analysis: {
        selectedMode: "hybrid"
      },
      emittedMode: "hybrid",
      fallbackReason: undefined,
      report: {
        id: "report-upload",
        title: resolvedSource.title,
        sourceKind: resolvedSource.sourceKind,
        renderer: "browser",
        selectedMode: "hybrid",
        emittedMode: "hybrid",
        summary: {
          totalNodes: 5,
          visibleNodes: 5,
          images: 1,
          buttons: 1,
          textBlocks: 2,
          sections: 1
        },
        layout: {
          rootNodeId: "root",
          nodeCount: 5,
          sectionCount: 1
        },
        analysis: {
          selectedMode: "hybrid"
        },
        warnings: ["One node required HTML fallback."]
      },
      capture: {
        renderedHtml: "<html><body>rendered upload</body></html>",
        renderer: "browser",
        artifacts: {
          outputDir: "/tmp/upload-capture",
          screenshots: {
            desktop: "/tmp/upload-capture/desktop.png"
          }
        }
      },
      elementorDocument: {
        version: "0.4",
        title: "ZIP upload",
        type: "page",
        content: []
      },
      artifacts: {
        elementorTemplatePath: "/tmp/upload-export/elementor-template.json",
        reportPath: "/tmp/upload-export/conversion-report.json"
      }
    } as never;
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
  assert.equal(payload.selectedMode, "hybrid");
  assert.equal(payload.emittedMode, "hybrid");
  assert.deepEqual(payload.warnings, ["One node required HTML fallback."]);
  assert.equal(resolveUploadCalls, 1);
  assert.equal(runV3Calls, 1);
}

async function testConvertRouteFallsBackToV2WhenV3Fails() {
  let runV2Calls = 0;

  const deps = createBaseDependencies();
  deps.resolveSourceFromHtml = (html) => ({
    id: "resolved-fallback",
    sourceKind: "raw-html",
    title: "Fallback route",
    html,
    assets: [],
    entryFile: null,
    routeFile: null,
    archiveFileCount: 0,
    notes: []
  });
  deps.runExportPipelineV3 = async () => {
    throw new Error("Puppeteer capture crashed");
  };
  deps.runPixelPerfectConversionPipeline = async (html, sourceKind) => {
    runV2Calls += 1;
    assert.equal(html, "<main>fallback me</main>");
    assert.equal(sourceKind, "raw-html");

    return {
      cleanHtml: "<html><body>fallback clean</body></html>",
      elementorJson: {
        version: "0.4",
        title: "Fallback route",
        type: "page",
        content: []
      },
      report: {
        warnings: [],
        screenshots: {},
        exportBlocked: false,
        status: "success"
      },
      outputDir: null,
      sourceKind,
      strategy: "pixel-perfect-iframe-v2"
    } as never;
  };
  deps.createConversion = async () =>
    ({
      id: "conversion-fallback"
    }) as never;

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

  assert.equal(response.status, 200);
  assert.equal(payload.id, "conversion-fallback");
  assert.equal(payload.status, "warning");
  assert.equal(payload.selectedMode, "pixel-perfect");
  assert.equal(payload.emittedMode, "pixel-perfect");
  assert.equal(payload.message, "Conversao concluida com fallback da converter-v2.");
  assert.match(
    String(payload.fallbackReason),
    /Converter-v3 falhou e a rota usou a converter-v2 como fallback: Puppeteer capture crashed/
  );
  assert.deepEqual(payload.warnings, [
    "Converter-v3 falhou e a rota usou a converter-v2 como fallback: Puppeteer capture crashed"
  ]);
  assert.equal(runV2Calls, 1);
}

async function main() {
  await testConvertRouteUsesV3ForRawHtml();
  await testConvertRouteUsesV3ResolverForUpload();
  await testConvertRouteFallsBackToV2WhenV3Fails();
  console.log("convert route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
