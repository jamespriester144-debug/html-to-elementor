import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import {
  readLearnedFixtureManifest,
  upsertLearnedFixtureManifestEntry
} from "../lib/converter-v3/learning/fixture-manifest";
import { resolveSourceFromLocalPath } from "../lib/converter-v3/resolve/source-resolver";

async function testResolveSourceFromLocalPathSupportsZipArchives() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "converter-v3-learning-zip-"));
  const zipPath = path.join(tempDir, "lovable-site.zip");
  const zip = new JSZip();

  zip.file(
    "index.html",
    "<!doctype html><html><head><title>Zip Fixture</title></head><body><main><h1>Zip Fixture</h1></main></body></html>"
  );

  await writeFile(zipPath, Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));

  const resolvedSource = await resolveSourceFromLocalPath(zipPath);

  assert.equal(resolvedSource.sourceKind, "static-html-archive");
  assert.equal(resolvedSource.sourcePath, path.resolve(zipPath));
  assert.match(resolvedSource.html, /Zip Fixture/);
  assert.equal(resolvedSource.renderContext?.mode, "local-server");
  assert.equal(resolvedSource.notes.some((note) => note.includes("arquivo local")), true);
}

async function testLearnedFixtureManifestCanPersistPromotedFixtures() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "converter-v3-learning-manifest-"));
  const manifestPath = path.join(tempDir, "converter-v3-learned-fixtures.json");

  await upsertLearnedFixtureManifestEntry(
    {
      name: "learned\\new-lovable.html",
      tags: ["lovable", "responsive", "lovable"],
      verifyExport: true,
      preferBrowser: true,
      minSimilarity: 1.5,
      expectedLayoutTypes: ["lovable-export", "tailwind", "tailwind"],
      promotedAt: "2026-05-24T00:00:00.000Z",
      sourceKind: "lovable-react-source"
    },
    manifestPath
  );

  const manifest = await readLearnedFixtureManifest(manifestPath);
  const savedSource = JSON.parse(await readFile(manifestPath, "utf8")) as {
    fixtures: Array<{
      name: string;
      tags: string[];
      minSimilarity?: number;
      expectedLayoutTypes?: string[];
    }>;
  };

  assert.equal(manifest.fixtures.length, 1);
  assert.equal(manifest.fixtures[0]?.name, "learned/new-lovable.html");
  assert.deepEqual(manifest.fixtures[0]?.tags, ["lovable", "responsive"]);
  assert.equal(manifest.fixtures[0]?.minSimilarity, 1);
  assert.deepEqual(manifest.fixtures[0]?.expectedLayoutTypes, [
    "lovable-export",
    "tailwind"
  ]);
  assert.equal(savedSource.fixtures[0]?.name, "learned/new-lovable.html");
}

async function main() {
  await testResolveSourceFromLocalPathSupportsZipArchives();
  await testLearnedFixtureManifestCanPersistPromotedFixtures();
  console.log("converter v3 learning tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
