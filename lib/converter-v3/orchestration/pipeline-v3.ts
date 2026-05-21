import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CapturePipelineResult } from "@/lib/converter-v3/contracts/capture";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import { analyzeLayoutComplexity } from "@/lib/converter-v3/analyze/complexity-analyzer";
import { buildPageCapture } from "@/lib/converter-v3/capture/page-capture";
import { normalizeCaptureToLayoutDocument } from "@/lib/converter-v3/normalize/layout-normalizer";
import {
  type BrowserRenderOptions,
  renderResolvedSourceForCapture
} from "@/lib/converter-v3/render/browser-renderer";
import { resolveSourceFromHtml, resolveSourceFromUpload } from "@/lib/converter-v3/resolve/source-resolver";

export type CapturePipelineOptions = BrowserRenderOptions & {
  outputRoot?: string;
};

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function runCapturePipelineV3(
  resolvedSource: ResolvedSource,
  options: CapturePipelineOptions = {}
): Promise<CapturePipelineResult> {
  const outputRoot = options.outputRoot ?? path.join(process.cwd(), ".tmp", "converter-v3");
  const outputDir = path.join(outputRoot, resolvedSource.id);
  await mkdir(outputDir, { recursive: true });

  const rendered = await renderResolvedSourceForCapture(resolvedSource, outputDir, {
    preferBrowser: options.preferBrowser
  });
  const capture = buildPageCapture(resolvedSource, rendered, outputDir);
  const layout = normalizeCaptureToLayoutDocument(capture);
  const analysis = analyzeLayoutComplexity(layout);

  const resolvedSourcePath = path.join(outputDir, "resolved-source.json");
  const renderedHtmlPath = path.join(outputDir, "rendered.html");
  const domSnapshotPath = path.join(outputDir, "dom-snapshot.json");
  const styleSnapshotPath = path.join(outputDir, "style-snapshot.json");
  const boxSnapshotPath = path.join(outputDir, "box-snapshot.json");
  const responsiveSnapshotPath = path.join(outputDir, "responsive-snapshot.json");
  const layoutPath = path.join(outputDir, "layout.json");
  const analysisPath = path.join(outputDir, "analysis.json");
  const pageCapturePath = path.join(outputDir, "page-capture.json");

  capture.artifacts = {
    ...capture.artifacts,
    outputDir,
    resolvedSourcePath,
    renderedHtmlPath,
    domSnapshotPath,
    styleSnapshotPath,
    boxSnapshotPath,
    responsiveSnapshotPath,
    layoutPath,
    analysisPath,
    pageCapturePath
  };

  await writeJson(resolvedSourcePath, {
    id: resolvedSource.id,
    sourceKind: resolvedSource.sourceKind,
    title: resolvedSource.title,
    entryFile: resolvedSource.entryFile,
    routeFile: resolvedSource.routeFile,
    archiveFileCount: resolvedSource.archiveFileCount,
    assets: resolvedSource.assets,
    notes: resolvedSource.notes
  });
  await writeFile(renderedHtmlPath, capture.renderedHtml, "utf8");
  await writeJson(domSnapshotPath, capture.domSnapshot);
  await writeJson(styleSnapshotPath, capture.styleSnapshot);
  await writeJson(boxSnapshotPath, capture.boxSnapshot);
  await writeJson(responsiveSnapshotPath, capture.responsiveSnapshot);
  await writeJson(layoutPath, layout);
  await writeJson(analysisPath, analysis);
  await writeJson(pageCapturePath, capture);

  return {
    resolvedSource: {
      id: resolvedSource.id,
      sourceKind: resolvedSource.sourceKind,
      title: resolvedSource.title
    },
    capture,
    layout,
    analysis
  };
}

export async function runCapturePipelineV3FromUpload(
  file: File,
  options: CapturePipelineOptions = {}
): Promise<CapturePipelineResult> {
  const resolvedSource = await resolveSourceFromUpload(file);
  return runCapturePipelineV3(resolvedSource, options);
}

export async function runCapturePipelineV3FromHtml(
  html: string,
  options: CapturePipelineOptions = {}
): Promise<CapturePipelineResult> {
  const resolvedSource = resolveSourceFromHtml(html);
  return runCapturePipelineV3(resolvedSource, options);
}
