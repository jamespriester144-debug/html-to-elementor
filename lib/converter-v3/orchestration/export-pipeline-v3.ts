import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExportPipelineResult } from "@/lib/converter-v3/contracts/output";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import { createElementorNativeExport } from "@/lib/converter-v3/elementor-native-exporter";
import type { CapturePipelineOptions } from "@/lib/converter-v3/orchestration/pipeline-v3";
import { runCapturePipelineV3 } from "@/lib/converter-v3/orchestration/pipeline-v3";
import { buildExportReport } from "@/lib/converter-v3/reports/report-builder";
import { resolveSourceFromHtml, resolveSourceFromUpload } from "@/lib/converter-v3/resolve/source-resolver";

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function resolveFallbackReason(selectedMode: ExportPipelineResult["analysis"]["selectedMode"]) {
  if (selectedMode === "pixel-perfect" || selectedMode === "hybrid" || selectedMode === "editable") {
    return undefined;
  }

  return `Emitter ${selectedMode} ainda nao implementado na converter-v3; exportando em pixel-perfect por enquanto.`;
}

export async function runExportPipelineV3(
  resolvedSource: ResolvedSource,
  options: CapturePipelineOptions = {}
): Promise<ExportPipelineResult> {
  const captureResult = await runCapturePipelineV3(resolvedSource, options);
  const selectedMode = captureResult.analysis.selectedMode;
  const exportResult = createElementorNativeExport({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode
  });
  const emittedMode = exportResult.emittedMode;
  const fallbackReason = exportResult.fallbackReason ?? resolveFallbackReason(selectedMode);
  const warnings = exportResult.warnings;
  const elementorDocument = exportResult.document;
  const validation = exportResult.validation;

  const report = buildExportReport({
    capture: captureResult.capture,
    layout: captureResult.layout,
    analysis: captureResult.analysis,
    emittedMode,
    validation,
    fallbackReason,
    warnings
  });
  const outputDir = captureResult.capture.artifacts.outputDir;
  const elementorTemplatePath = path.join(outputDir, "elementor-template.json");
  const reportPath = path.join(outputDir, "conversion-report.json");

  await writeJson(elementorTemplatePath, elementorDocument);
  await writeJson(reportPath, report);

  return {
    ...captureResult,
    emittedMode,
    fallbackReason,
    elementorDocument,
    validation,
    report,
    artifacts: {
      elementorTemplatePath,
      reportPath
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
