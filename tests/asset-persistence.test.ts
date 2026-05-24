import assert from "node:assert/strict";

import { createEmbeddedConversionAssetPersister } from "../lib/converter-v2/asset-persistence";

async function testPersistEmbeddedConversionAssetsReplacesSnapshotBase64Recursively() {
  const pngDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1sAAAAASUVORK5CYII=";
  const svgDataUrl = "data:image/svg+xml;base64,PHN2Zy8+";
  const uploadCalls: Array<{
    sourcePath: string;
    contentType: string;
    conversionKey: string;
  }> = [];
  const persistEmbeddedConversionAssets = createEmbeddedConversionAssetPersister(
    {
      uploadConversionAsset: async ({
        conversionKey,
        sourcePath,
        contentType
      }) => {
        uploadCalls.push({
          sourcePath,
          contentType,
          conversionKey
        });

        return `https://cdn.example.com/${sourcePath}`;
      }
    }
  );
  const elementorDocument = {
    version: "1.0",
    title: "Snapshot Export",
    type: "page" as const,
    content: [
      {
        id: "section-1",
        elType: "container" as const,
        settings: {
          background_image: {
            url: pngDataUrl
          }
        },
        elements: [
          {
            id: "widget-1",
            elType: "widget" as const,
            widgetType: "html",
            settings: {
              html: `<div class="converter-v3-snapshot-section" style="background-image:url('${pngDataUrl}')"><img src="${svgDataUrl}" alt="snapshot" /></div>`
            },
            elements: []
          }
        ]
      }
    ]
  };

  const persisted = await persistEmbeddedConversionAssets(
    `<html><body><img src="${pngDataUrl}" /><section style="background-image:url('${svgDataUrl}')"></section></body></html>`,
    elementorDocument,
    "conversion-key"
  );
  const persistedJsonText = JSON.stringify(persisted.elementorJson, null, 2);

  assert.equal(uploadCalls.length, 2);
  assert.ok(uploadCalls.every((call) => call.conversionKey === "conversion-key"));
  assert.match(persisted.html, /https:\/\/cdn\.example\.com\/embedded-1\.png/);
  assert.match(persisted.html, /https:\/\/cdn\.example\.com\/embedded-2\.svg/);
  assert.doesNotMatch(persisted.html, /data:image\//);
  assert.doesNotMatch(persistedJsonText, /data:image\//);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(persisted.elementorJson)));
  assert.doesNotThrow(() => JSON.parse(persistedJsonText));
}

async function testPersistEmbeddedConversionAssetsKeepsOriginalDataUrlWhenUploadFails() {
  const pngDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ1sAAAAASUVORK5CYII=";
  const persistEmbeddedConversionAssets = createEmbeddedConversionAssetPersister(
    {
      uploadConversionAsset: async () => {
        throw new Error("Bad Request");
      }
    }
  );
  const originalWarn = console.warn;
  const warnings: string[] = [];

  console.warn = (message?: unknown, ...optionalParams: unknown[]) => {
    warnings.push([message, ...optionalParams].join(" "));
  };

  try {
    const persisted = await persistEmbeddedConversionAssets(
      `<html><body><img src="${pngDataUrl}" /></body></html>`,
      {
        content: [
          {
            settings: {
              image: {
                url: pngDataUrl
              }
            }
          }
        ]
      },
      "conversion-key"
    );

    assert.match(persisted.html, /data:image\/png;base64/);
    assert.match(JSON.stringify(persisted.elementorJson), /data:image\/png;base64/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Mantendo data URL original/);
    assert.match(warnings[0], /Bad Request/);
  } finally {
    console.warn = originalWarn;
  }
}

async function main() {
  await testPersistEmbeddedConversionAssetsReplacesSnapshotBase64Recursively();
  await testPersistEmbeddedConversionAssetsKeepsOriginalDataUrlWhenUploadFails();
  console.log("asset persistence tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
