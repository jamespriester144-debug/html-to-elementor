import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExportPipelineResult } from "@/lib/converter-v3/contracts/output";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import { createElementorNativeExport } from "@/lib/converter-v3/elementor-native-exporter";
import type { CapturePipelineOptions } from "@/lib/converter-v3/orchestration/pipeline-v3";
import { runCapturePipelineV3 } from "@/lib/converter-v3/orchestration/pipeline-v3";
import { buildExportReport } from "@/lib/converter-v3/reports/report-builder";
import { resolveSourceFromHtml, resolveSourceFromUpload } from "@/lib/converter-v3/resolve/source-resolver";
import { buildVisualSectionCaptures } from "@/lib/converter-v3/sections/visual-section-capture";

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function resolveFallbackReason(selectedMode: ExportPipelineResult["analysis"]["selectedMode"]) {
  if (
    selectedMode === "snapshot" ||
    selectedMode === "pixel-perfect" ||
    selectedMode === "hybrid" ||
    selectedMode === "editable"
  ) {
    return undefined;
  }

  return `Emitter ${selectedMode} ainda nao implementado na converter-v3; exportando em pixel-perfect por enquanto.`;
}

export async function runExportPipelineV3(
  resolvedSource: ResolvedSource,
  options: CapturePipelineOptions = {}
): Promise<ExportPipelineResult> {
  const captureResult = await runCapturePipelineV3(resolvedSource, options);
  const outputDir = captureResult.capture.artifacts.outputDir;
  let selectedMode = captureResult.analysis.selectedMode;

  if (captureResult.capture.renderer === "browser") {
    const sections = await buildVisualSectionCaptures({
      capture: captureResult.capture,
      layout: captureResult.layout,
      outputDir
    });

    captureResult.capture.sections = sections;
    captureResult.capture.artifacts.sectionArtifactsPath = path.join(outputDir, "sections.json");
    await writeJson(captureResult.capture.artifacts.sectionArtifactsPath, sections);

    if (sections.length > 0) {
      selectedMode = "snapshot";
      captureResult.analysis = {
        ...captureResult.analysis,
        selectedMode,
        reasons: [
          "Snapshot Elementor habilitado por haver captura real no navegador.",
          ...captureResult.analysis.reasons
        ]
      };
    }
  }

  const exportResult = await createElementorNativeExport({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode,
    outputDir
  });
  const emittedMode = exportResult.emittedMode;
  const fallbackReason = exportResult.fallbackReason ?? resolveFallbackReason(selectedMode);
  const warnings = exportResult.warnings;
  const elementorDocument = exportResult.document;
  const validation = exportResult.validation;
  const previewHtml = exportResult.previewHtml;
  const snapshot = exportResult.snapshot;

  const report = buildExportReport({
    capture: captureResult.capture,
    layout: captureResult.layout,
    analysis: captureResult.analysis,
    emittedMode,
    validation,
    fallbackReason,
    warnings,
    snapshot
  });
  const elementorTemplatePath = path.join(outputDir, "elementor-template.json");
  const reportPath = path.join(outputDir, "conversion-report.json");
  const previewHtmlPath = previewHtml ? path.join(outputDir, "snapshot-preview.html") : undefined;

  await writeJson(elementorTemplatePath, elementorDocument);
  await writeJson(reportPath, report);

  if (previewHtmlPath && previewHtml) {
    await writeFile(previewHtmlPath, previewHtml, "utf8");
  }

  return {
    ...captureResult,
    emittedMode,
    fallbackReason,
    elementorDocument,
    validation,
    report,
    snapshot,
    artifacts: {
      elementorTemplatePath,
      reportPath,
      previewHtmlPath,
      convertedScreenshotPath: snapshot?.convertedScreenshotPath,
      snapshotSectionsPath: captureResult.capture.artifacts.sectionArtifactsPath || undefined
    }
  };
}

export async function runExportPipelineV3FromUpload(
  file: File,
  options: CapturePipelineOptions = {}
): Promise<ExportPipelineResult> {
  const resolvedSource = await resolveSourceFromUpload(file);
  return runExportPipelineV3(resolvedSource, options);
}

export async function runExportPipelineV3FromHtml(
  html: string,
  options: CapturePipelineOptions = {}
): Promise<ExportPipelineResult> {
  const resolvedSource = resolveSourceFromHtml(html);
  return runExportPipelineV3(resolvedSource, options);
}
