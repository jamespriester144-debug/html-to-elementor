import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExportPipelineResult } from "@/lib/converter-v3/contracts/output";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import { auditThemeConsistency } from "@/lib/converter-v3/analyze/theme-detector";
import { buildConvertedPreviewHtml } from "@/lib/converter-v3/debug/conversion-debug";
import { writeConversionDebugBundle } from "@/lib/converter-v3/debug/conversion-debug";
import { createElementorNativeExport } from "@/lib/converter-v3/elementor-native-exporter";
import type { CapturePipelineOptions } from "@/lib/converter-v3/orchestration/pipeline-v3";
import { runCapturePipelineV3 } from "@/lib/converter-v3/orchestration/pipeline-v3";
import { buildExportReport } from "@/lib/converter-v3/reports/report-builder";
import { buildUniversalVisualValidationReport } from "@/lib/converter-v3/reports/visual-validation-report";
import { resolveSourceFromHtml, resolveSourceFromUpload } from "@/lib/converter-v3/resolve/source-resolver";
import { buildVisualSectionCaptures } from "@/lib/converter-v3/sections/visual-section-capture";
import {
  assessVisualCloneRisk,
  requiresVisualSafeMode,
  VISUAL_REASON_FALLBACK_PIXEL_PERFECT,
  VISUAL_REASON_FALLBACK_SNAPSHOT,
  VISUAL_REASON_HIGH_RISK,
  shouldPreferUniversalVisualSnapshot,
  shouldForceUniversalFullPageSnapshot
} from "@/lib/converter-v3/visual-clone-policy";
import {
  assertContentIntegrity,
  validateContentIntegrity
} from "@/lib/converter-v3/validate/content-integrity";
import {
  isDebugConversionEnabled,
  isForceFullPageSnapshotEnabled,
  isForceVisualSnapshotEnabled,
  isSafeFullPageFallbackEnabled
} from "@/lib/env";

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function getCriticalVisualAssetFailures(capture: ExportPipelineResult["capture"]) {
  return (capture.inputAnalysis.diagnostics.resources ?? []).filter(
    (resource) => resource.status === "failed" && resource.critical
  );
}

function sanitizeReportFileSegment(value: string) {
  return value
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "input-page";
}

const BROWSER_CAPTURE_FAILURE_MESSAGE =
  "Captura visual do navegador falhou. Snapshot não pôde ser gerado.";

const FALLBACK_TO_SNAPSHOT_TRIGGERED = "fallback to snapshot triggered";
const FALLBACK_TO_PIXEL_PERFECT_TRIGGERED = "fallback to pixel-perfect triggered";

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

function resolveSnapshotStatus(params: {
  renderer: ExportPipelineResult["capture"]["renderer"];
  sectionCount: number;
  emittedMode: ExportPipelineResult["emittedMode"];
  snapshot?: ExportPipelineResult["snapshot"];
}) {
  if (params.renderer !== "browser") {
    return {
      snapshotEnabled: false,
      snapshotReason: BROWSER_CAPTURE_FAILURE_MESSAGE
    };
  }

  if (params.emittedMode === "snapshot" && params.snapshot) {
    if (params.snapshot.visualValidationReport?.status === "blocked") {
      return {
        snapshotEnabled: true,
        snapshotReason:
          params.snapshot.visualValidationReport.blockingReason ??
          `Snapshot visual falhou apos todos os fallbacks com similaridade ${(
            params.snapshot.overallSimilarity * 100
          ).toFixed(2)}%.`
      };
    }

    const renderStrategyLabel =
      params.snapshot.renderStrategy === "full-page-snapshot"
        ? "pagina inteira"
        : params.snapshot.visualValidationReport?.modeUsed === "section-fallback"
          ? "fallback por secao"
          : "secoes";

    return {
      snapshotEnabled: true,
      snapshotReason: `Snapshot visual (${renderStrategyLabel}) validado com similaridade ${(
        params.snapshot.overallSimilarity * 100
      ).toFixed(2)}%.`
    };
  }

  if (params.sectionCount === 0) {
    return {
      snapshotEnabled: false,
      snapshotReason:
        "Captura do navegador concluida, mas nenhuma secao elegivel para snapshot foi detectada."
    };
  }

  if (params.emittedMode === "pixel-perfect") {
    return {
      snapshotEnabled: true,
      snapshotReason:
        "Snapshot foi tentado com captura real do navegador, mas o export final precisou usar pixel-perfect."
    };
  }

  return {
    snapshotEnabled: true,
    snapshotReason: "Captura do navegador disponivel para snapshot visual."
  };
}

function mergeWarnings(...warningGroups: Array<Array<string | undefined>>) {
  return [...new Set(warningGroups.flat().filter((warning): warning is string => Boolean(warning)))];
}

export function shouldRecoverBlockedExportWithPixelPerfect(params: {
  forceVisualSnapshot: boolean;
  emittedMode: ExportPipelineResult["emittedMode"];
  capture: ExportPipelineResult["capture"];
  layout: ExportPipelineResult["layout"];
  contentIntegrity: ExportPipelineResult["contentIntegrity"];
}) {
  if (
    params.forceVisualSnapshot ||
    params.emittedMode === "pixel-perfect" ||
    params.contentIntegrity.status !== "blocked"
  ) {
    return false;
  }

  if (!params.capture.inputAnalysis.diagnostics.htmlRendered) {
    return false;
  }

  const hasMeaningfulSourceContent =
    params.layout.sectionIds.length > 0 ||
    params.layout.detectedSections.length > 0 ||
    params.capture.summary.visibleNodes > 3 ||
    params.capture.summary.textBlocks > 0 ||
    params.capture.summary.images > 0 ||
    params.capture.summary.buttons > 0;

  if (!hasMeaningfulSourceContent) {
    return false;
  }

  return params.capture.renderer !== "browser";
}

export function shouldRecoverBlockedExportWithSnapshot(params: {
  forceVisualSnapshot: boolean;
  emittedMode: ExportPipelineResult["emittedMode"];
  capture: ExportPipelineResult["capture"];
  layout: ExportPipelineResult["layout"];
  contentIntegrity: ExportPipelineResult["contentIntegrity"];
}) {
  if (
    params.forceVisualSnapshot ||
    params.emittedMode === "snapshot" ||
    params.capture.renderer !== "browser" ||
    params.contentIntegrity.status !== "blocked"
  ) {
    return false;
  }

  if (!params.capture.inputAnalysis.diagnostics.htmlRendered) {
    return false;
  }

  const hasMeaningfulSourceContent =
    params.layout.sectionIds.length > 0 ||
    params.layout.detectedSections.length > 0 ||
    params.capture.summary.visibleNodes > 3 ||
    params.capture.summary.textBlocks > 0 ||
    params.capture.summary.images > 0 ||
    params.capture.summary.buttons > 0 ||
    (params.capture.summary.links ?? 0) > 0;

  if (!hasMeaningfulSourceContent) {
    return false;
  }

  return true;
}

function shouldRecoverBlockedSnapshotWithPixelPerfect(params: {
  emittedMode: ExportPipelineResult["emittedMode"];
  capture: ExportPipelineResult["capture"];
  contentIntegrity: ExportPipelineResult["contentIntegrity"];
}) {
  if (
    params.emittedMode !== "snapshot" ||
    params.contentIntegrity.status !== "blocked"
  ) {
    return false;
  }

  return params.capture.inputAnalysis.diagnostics.htmlRendered === true;
}

export async function runExportPipelineV3(
  resolvedSource: ResolvedSource,
  options: CapturePipelineOptions = {}
): Promise<ExportPipelineResult> {
  const forceFullPageSnapshot = isForceFullPageSnapshotEnabled();
  const forceVisualSnapshot = isForceVisualSnapshotEnabled();
  const safeFullPageFallback = isSafeFullPageFallbackEnabled();
  const captureResult = await runCapturePipelineV3(resolvedSource, options);
  const forceUniversalFullPageSnapshot = shouldForceUniversalFullPageSnapshot(
    captureResult.capture,
    captureResult.layout
  );
  const visualCloneRisk = assessVisualCloneRisk(captureResult.capture, captureResult.layout);
  const visualSafeModeRequired = requiresVisualSafeMode(visualCloneRisk);
  const preferUniversalVisualSnapshot = shouldPreferUniversalVisualSnapshot(
    captureResult.capture,
    captureResult.layout
  );
  const outputDir = captureResult.capture.artifacts.outputDir;
  let selectedMode = captureResult.analysis.selectedMode;

  if (captureResult.capture.renderer === "browser") {
    const sections = await buildVisualSectionCaptures({
      capture: captureResult.capture,
      layout: captureResult.layout,
      outputDir
    });
    const criticalAssetFailures = getCriticalVisualAssetFailures(captureResult.capture);

    captureResult.capture.sections = sections;
    captureResult.capture.artifacts.sectionArtifactsPath = path.join(outputDir, "sections.json");
    await writeJson(captureResult.capture.artifacts.sectionArtifactsPath, sections);

    const preferUniversalSnapshot =
      captureResult.capture.inputAnalysis.renderStrategy.preferVisualSnapshot ||
      captureResult.capture.inputAnalysis.renderStrategy.preferFullPageSnapshot ||
      safeFullPageFallback;

    if (forceFullPageSnapshot || forceUniversalFullPageSnapshot) {
      selectedMode = "snapshot";
      captureResult.analysis = {
        ...captureResult.analysis,
        selectedMode,
        reasons: [
          ...visualCloneRisk.reasons,
          forceFullPageSnapshot
            ? "FORCE_FULL_PAGE_SNAPSHOT ativo: somente o snapshot responsivo da pagina inteira sera usado como saida principal."
            : "Politica universal Lovable-like ativa: somente o snapshot responsivo da pagina inteira sera usado como saida principal.",
          ...captureResult.analysis.reasons
        ]
      };
    } else if (criticalAssetFailures.length > 0) {
      const diagnostics = [
        ...new Set(
          criticalAssetFailures
            .map((resource) => resource.diagnostic)
            .filter(
              (
                diagnostic
              ): diagnostic is NonNullable<(typeof criticalAssetFailures)[number]["diagnostic"]> =>
                Boolean(diagnostic)
            )
        )
      ];

      selectedMode = "snapshot";
      captureResult.analysis = {
        ...captureResult.analysis,
        selectedMode,
        reasons: [
          VISUAL_REASON_HIGH_RISK,
          `Falha critica de fidelidade visual detectada (${diagnostics.join(
            ", "
          )}); snapshot visual foi promovido para preservar backgrounds, overlays e imagens essenciais antes de qualquer fallback pixel-perfect.`,
          ...captureResult.analysis.reasons
        ]
      };
    } else if (forceVisualSnapshot || preferUniversalVisualSnapshot) {
      selectedMode = "snapshot";
      captureResult.analysis = {
        ...captureResult.analysis,
        selectedMode,
        reasons: [
          ...visualCloneRisk.reasons,
          forceVisualSnapshot
            ? sections.length > 0
              ? "FORCE_VISUAL_SNAPSHOT ativo: snapshots visuais por secao/pagina inteira sao o modo principal."
              : "FORCE_VISUAL_SNAPSHOT ativo: secoes nao ficaram prontas, entao o snapshot responsivo da pagina inteira sera o modo principal."
            : sections.length > 0
              ? "Politica visual Lovable-like ativa: snapshots por secao/pagina inteira sao o modo principal."
              : "Politica visual Lovable-like ativa: secoes nao ficaram prontas, entao o snapshot responsivo da pagina inteira sera o modo principal.",
          ...captureResult.analysis.reasons
        ]
      };
    } else {
      selectedMode = selectedMode === "editable" ? "editable" : "hybrid";
      captureResult.analysis = {
        ...captureResult.analysis,
        selectedMode,
        reasons: [
          preferUniversalSnapshot
            ? captureResult.capture.inputAnalysis.renderStrategy.preferFullPageSnapshot
              ? "Analise universal marcou pagina inteira como fallback seguro se a conversao estrutural falhar."
              : captureResult.capture.inputAnalysis.renderStrategy.preferVisualSnapshot
                ? "Analise universal marcou snapshot visual como fallback se a conversao estrutural perder fidelidade."
                : "SAFE_FULL_PAGE_FALLBACK ativo: snapshot visual de pagina inteira permanece disponivel como fallback."
            : "Conversao estrutural do DOM renderizado sera tentada antes de qualquer snapshot visual.",
          ...captureResult.analysis.reasons
        ]
      };
    }
  } else if (
    captureResult.capture.inputAnalysis.diagnostics.htmlRendered === true &&
    visualSafeModeRequired
  ) {
    selectedMode = "pixel-perfect";
    captureResult.analysis = {
      ...captureResult.analysis,
      selectedMode,
      reasons: [
        ...visualCloneRisk.reasons,
        "Renderizacao sem browser real em pagina com shell visual critico: fallback direto para pixel-perfect para evitar clone claro/generico.",
        ...captureResult.analysis.reasons
      ]
    };
  }

  let exportResult = await createElementorNativeExport({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode,
    outputDir
  });
  const sectionCroppingRisk = Boolean(
    captureResult.capture.sections?.some((section) => section.debug?.unsafeSectionBoundary)
  );
  const elementorTemplatePath = path.join(outputDir, "elementor-template.json");
  const reportPath = path.join(outputDir, "conversion-report.json");
  const visualValidationReportFileName = `visual-validation-report-${sanitizeReportFileSegment(
    captureResult.capture.inputAnalysis.fileName
  )}.json`;
  const visualValidationReportPath = path.join(outputDir, visualValidationReportFileName);
  const contentIntegrityReportPath = path.join(outputDir, "content-integrity-report.json");
  let contentIntegrity = await validateContentIntegrity({
    capture: captureResult.capture,
    layout: captureResult.layout,
    document: exportResult.document,
    validation: exportResult.validation,
    emittedMode: exportResult.emittedMode,
    previewHtml: exportResult.previewHtml,
    snapshot: exportResult.snapshot,
    outputFile: elementorTemplatePath,
    failureStage: exportResult.exportStage
  });

  if (
    shouldRecoverBlockedExportWithSnapshot({
      forceVisualSnapshot: forceVisualSnapshot || forceUniversalFullPageSnapshot,
      emittedMode: exportResult.emittedMode,
      capture: captureResult.capture,
      layout: captureResult.layout,
      contentIntegrity
    })
  ) {
    const recoveryReason =
      `${VISUAL_REASON_FALLBACK_SNAPSHOT}: conversao estrutural/geometrica perdeu conteudo detectavel; fallback universal para snapshot visual foi acionado.`;
    const recoveredExport = await createElementorNativeExport({
      capture: captureResult.capture,
      layout: captureResult.layout,
      selectedMode: "snapshot",
      outputDir
    });

    exportResult = {
      ...recoveredExport,
      fallbackReason: recoveryReason,
      warnings: mergeWarnings(
        exportResult.warnings,
        recoveredExport.warnings,
        [contentIntegrity.failureReason, FALLBACK_TO_SNAPSHOT_TRIGGERED, recoveryReason]
      )
    };

    contentIntegrity = await validateContentIntegrity({
      capture: captureResult.capture,
      layout: captureResult.layout,
      document: exportResult.document,
      validation: exportResult.validation,
      emittedMode: exportResult.emittedMode,
      previewHtml: exportResult.previewHtml,
      snapshot: exportResult.snapshot,
      outputFile: elementorTemplatePath,
      failureStage: exportResult.exportStage
    });
  } else if (
    shouldRecoverBlockedExportWithPixelPerfect({
      forceVisualSnapshot: forceVisualSnapshot || forceUniversalFullPageSnapshot,
      emittedMode: exportResult.emittedMode,
      capture: captureResult.capture,
      layout: captureResult.layout,
      contentIntegrity
    })
  ) {
    const recoveryReason =
      `${VISUAL_REASON_FALLBACK_PIXEL_PERFECT}: renderizacao visual nao permitiu snapshot confiavel; fallback final em iframe preservou o DOM completo.`;
    const recoveredExport = await createElementorNativeExport({
      capture: captureResult.capture,
      layout: captureResult.layout,
      selectedMode: "pixel-perfect",
      outputDir
    });

    exportResult = {
      ...recoveredExport,
      fallbackReason: recoveryReason,
      warnings: mergeWarnings(
        exportResult.warnings,
        recoveredExport.warnings,
        [contentIntegrity.failureReason, FALLBACK_TO_PIXEL_PERFECT_TRIGGERED, recoveryReason]
      )
    };

    contentIntegrity = await validateContentIntegrity({
      capture: captureResult.capture,
      layout: captureResult.layout,
      document: exportResult.document,
      validation: exportResult.validation,
      emittedMode: exportResult.emittedMode,
      previewHtml: exportResult.previewHtml,
      snapshot: exportResult.snapshot,
      outputFile: elementorTemplatePath,
      failureStage: exportResult.exportStage
    });
  }

  if (
    shouldRecoverBlockedSnapshotWithPixelPerfect({
      emittedMode: exportResult.emittedMode,
      capture: captureResult.capture,
      contentIntegrity
    })
  ) {
    const recoveryReason =
      `${VISUAL_REASON_FALLBACK_PIXEL_PERFECT}: snapshot visual ainda falhou na auditoria final; fallback final em iframe preservou a aparencia completa.`;
    const recoveredExport = await createElementorNativeExport({
      capture: captureResult.capture,
      layout: captureResult.layout,
      selectedMode: "pixel-perfect",
      outputDir
    });

    exportResult = {
      ...recoveredExport,
      fallbackReason: recoveryReason,
      warnings: mergeWarnings(
        exportResult.warnings,
        recoveredExport.warnings,
        [contentIntegrity.failureReason, FALLBACK_TO_PIXEL_PERFECT_TRIGGERED, recoveryReason]
      )
    };

    contentIntegrity = await validateContentIntegrity({
      capture: captureResult.capture,
      layout: captureResult.layout,
      document: exportResult.document,
      validation: exportResult.validation,
      emittedMode: exportResult.emittedMode,
      previewHtml: exportResult.previewHtml,
      snapshot: exportResult.snapshot,
      outputFile: elementorTemplatePath,
      failureStage: exportResult.exportStage
    });
  }

  const emittedMode = exportResult.emittedMode;
  const fallbackReason = exportResult.fallbackReason ?? resolveFallbackReason(selectedMode);
  const warnings = exportResult.warnings;
  const elementorDocument = exportResult.document;
  const validation = exportResult.validation;
  const previewHtml =
    exportResult.previewHtml ??
    buildConvertedPreviewHtml({
      capture: captureResult.capture,
      document: elementorDocument
    });
  const snapshot = exportResult.snapshot;
  const themeAudit = auditThemeConsistency({
    sourceThemeAnalysis: captureResult.capture.themeAnalysis,
    previewHtml,
    emittedMode
  });
  const fullPageSnapshotFailed =
    snapshot?.renderStrategy === "full-page-snapshot" &&
    snapshot.visualValidationReport?.status === "blocked";
  captureResult.capture.inputAnalysis = {
    ...captureResult.capture.inputAnalysis,
    diagnostics: {
      ...captureResult.capture.inputAnalysis.diagnostics,
      sectionCroppingRisk,
      fullPageSnapshotFailed
    }
  };
  const snapshotStatus = resolveSnapshotStatus({
    renderer: captureResult.capture.renderer,
    sectionCount: captureResult.capture.sections?.length ?? 0,
    emittedMode,
    snapshot
  });

  const debugConversionEnabled = isDebugConversionEnabled();
  const report = buildExportReport({
    capture: captureResult.capture,
    layout: captureResult.layout,
    analysis: captureResult.analysis,
    emittedMode,
    validation,
    snapshotEnabled: snapshotStatus.snapshotEnabled,
    snapshotReason: snapshotStatus.snapshotReason,
    fallbackReason,
    warnings,
    snapshot,
    themeAudit
  });
  const previewHtmlPath = previewHtml ? path.join(outputDir, "snapshot-preview.html") : undefined;
  let artifacts: ExportPipelineResult["artifacts"] = {
    elementorTemplatePath,
    reportPath,
    previewHtmlPath,
    convertedScreenshotPath: snapshot?.convertedScreenshotPath,
    snapshotSectionsPath: captureResult.capture.artifacts.sectionArtifactsPath || undefined,
    visualValidationReportPath,
    contentIntegrityReportPath
  };
  const universalVisualValidationReport = buildUniversalVisualValidationReport({
    ...captureResult,
    emittedMode,
    fallbackReason,
    elementorDocument,
    validation,
    report,
    snapshot,
    contentIntegrity,
    artifacts
  });

  if (debugConversionEnabled) {
    const debugBundle = await writeConversionDebugBundle({
      capture: captureResult.capture,
      layout: captureResult.layout,
      document: elementorDocument,
      validation,
      contentIntegrity,
      report,
      snapshot,
      previewHtml
    });

    contentIntegrity = {
      ...contentIntegrity,
      debugArtifacts: {
        ...contentIntegrity.debugArtifacts,
        originalScreenshotPath: debugBundle.originalScreenshotPath,
        convertedScreenshotPath: debugBundle.convertedScreenshotPath,
        debugConversionDir: debugBundle.debugDir,
        extractedElementsPath: debugBundle.extractedElementsPath,
        detectedSectionsPath: debugBundle.detectedSectionsPath,
        lostElementsPath: debugBundle.lostElementsPath,
        conversionReportPath: debugBundle.conversionReportPath
      }
    };
    artifacts = {
      ...artifacts,
      debugConversionDir: debugBundle.debugDir
    };
  }

  await writeJson(contentIntegrityReportPath, contentIntegrity);
  await writeJson(visualValidationReportPath, universalVisualValidationReport);

  if (snapshot?.visualValidationReport) {
    await writeJson(path.join(outputDir, "visual-validation-report.json"), snapshot.visualValidationReport);
  }

  assertContentIntegrity(contentIntegrity);

  await writeJson(elementorTemplatePath, elementorDocument);
  await writeJson(reportPath, report);

  if (previewHtmlPath && previewHtml) {
    await writeFile(previewHtmlPath, previewHtml, "utf8");
  }

  return {
    ...captureResult,
    emittedMode,
    fallbackReason,
    previewHtml,
    elementorDocument,
    validation,
    report,
    snapshot,
    contentIntegrity,
    artifacts
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
