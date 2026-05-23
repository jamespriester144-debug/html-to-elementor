import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CapturePipelineResult } from "@/lib/converter-v3/contracts/capture";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import { analyzeLayoutComplexity } from "@/lib/converter-v3/analyze/complexity-analyzer";
import { buildPageCapture } from "@/lib/converter-v3/capture/page-capture";
import { detectLayoutDocument } from "@/lib/converter-v3/layout-detector";
import { classifySections } from "@/lib/converter-v3/section-classifier";
import { buildVisualHierarchy } from "@/lib/converter-v3/visual-hierarchy";
import {
  type BrowserRenderOptions,
  renderResolvedSourceForCapture
} from "@/lib/converter-v3/render/browser-renderer";
import { isUniversalInputAnalysisEnabled } from "@/lib/env";
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
  const detectedLayout = detectLayoutDocument(capture);
  const visualHierarchy = buildVisualHierarchy(detectedLayout);
  const layout = classifySections(visualHierarchy);
  const universalAnalysisEnabled = isUniversalInputAnalysisEnabled();
  const realSectionCount = layout.detectedSections.length || layout.sectionIds.length;
  capture.inputAnalysis = {
    ...capture.inputAnalysis,
    structure: {
      ...capture.inputAnalysis.structure,
      realSectionCount
    }
  };

  let analysis = analyzeLayoutComplexity(layout);

  if (universalAnalysisEnabled && capture.renderer === "browser") {
    const preferVisualSnapshot = capture.inputAnalysis.renderStrategy.preferVisualSnapshot;
    const preferFullPageSnapshot = capture.inputAnalysis.renderStrategy.preferFullPageSnapshot;

    if (preferVisualSnapshot || preferFullPageSnapshot) {
      analysis = {
        ...analysis,
        selectedMode: "snapshot",
        reasons: [
          preferFullPageSnapshot
            ? "Analise universal indicou snapshot visual de pagina inteira como fallback mais seguro."
            : "Analise universal indicou snapshot visual por seguranca estrutural.",
          ...analysis.reasons
        ]
      };
    }
  }

  const resolvedSourcePath = path.join(outputDir, "resolved-source.json");
  const renderedHtmlPath = path.join(outputDir, "rendered.html");
  const domSnapshotPath = path.join(outputDir, "dom-snapshot.json");
  const styleSnapshotPath = path.join(outputDir, "style-snapshot.json");
  const boxSnapshotPath = path.join(outputDir, "box-snapshot.json");
  const responsiveSnapshotPath = path.join(outputDir, "responsive-snapshot.json");
  const layoutPath = path.join(outputDir, "layout.json");
  const analysisPath = path.join(outputDir, "analysis.json");
  const inputAnalysisPath = path.join(outputDir, "input-analysis.json");
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
    notes: resolvedSource.notes,
    sourcePath: resolvedSource.sourcePath,
    renderContext: resolvedSource.renderContext,
    inputAnalysis: resolvedSource.inputAnalysis
  });
  await writeFile(renderedHtmlPath, capture.renderedHtml, "utf8");
  await writeJson(domSnapshotPath, capture.domSnapshot);
  await writeJson(styleSnapshotPath, capture.styleSnapshot);
  await writeJson(boxSnapshotPath, capture.boxSnapshot);
  await writeJson(responsiveSnapshotPath, capture.responsiveSnapshot);
  await writeJson(layoutPath, layout);
  await writeJson(analysisPath, analysis);
  await writeJson(inputAnalysisPath, capture.inputAnalysis);
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
