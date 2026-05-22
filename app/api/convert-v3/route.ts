import { NextRequest, NextResponse } from "next/server";

import type { ExportPipelineResult } from "@/lib/converter-v3/contracts/output";
import { VisualValidationError } from "@/lib/converter-v3/visual-regression-validator";
import {
  runExportPipelineV3FromHtml,
  runExportPipelineV3FromUpload
} from "@/lib/converter-v3/orchestration/export-pipeline-v3";

export const runtime = "nodejs";

const MIN_VISUAL_SIMILARITY = 0.99;

function resolveVisualSimilarity(result: ExportPipelineResult) {
  if (result.emittedMode === "pixel-perfect") {
    return 1;
  }

  return result.snapshot?.overallSimilarity ?? 0;
}

function resolveVisualBlockingError(result: ExportPipelineResult) {
  if (result.capture.renderer !== "browser") {
    return BROWSER_CAPTURE_FAILURE_MESSAGE;
  }

  if (result.snapshot?.visualValidationReport?.status === "blocked") {
    return (
      result.snapshot.visualValidationReport.blockingReason ??
      `Conversao bloqueada: similaridade visual final ficou em ${(
        resolveVisualSimilarity(result) * 100
      ).toFixed(2)}%.`
    );
  }

  if (resolveVisualSimilarity(result) < MIN_VISUAL_SIMILARITY) {
    return `Conversao bloqueada: similaridade visual final ficou em ${(
      resolveVisualSimilarity(result) * 100
    ).toFixed(2)}%.`;
  }

  return undefined;
}

const BROWSER_CAPTURE_FAILURE_MESSAGE =
  "Captura visual do navegador falhou. Snapshot não pôde ser gerado.";

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      const pastedHtml = formData.get("html");

      if (file instanceof File) {
        const result = await runExportPipelineV3FromUpload(file, {
          preferBrowser: true
        });

        if (result.capture.renderer !== "browser") {
          return NextResponse.json(
            {
              error: BROWSER_CAPTURE_FAILURE_MESSAGE,
              report: result.report
            },
            { status: 422 }
          );
        }

        const blockingError = resolveVisualBlockingError(result);

        if (blockingError) {
          return NextResponse.json(
            {
              error: blockingError,
              report: result.report,
              validation: result.validation,
              snapshot: result.snapshot
            },
            { status: 422 }
          );
        }

        return NextResponse.json({
          id: result.resolvedSource.id,
          mode: "converter-v3-export",
          sourceKind: result.resolvedSource.sourceKind,
          renderer: result.capture.renderer,
          title: result.elementorDocument.title,
          summary: result.capture.summary,
          selectedMode: result.analysis.selectedMode,
          emittedMode: result.emittedMode,
          fallbackReason: result.fallbackReason,
          warnings: result.report.warnings,
          analysis: result.analysis,
          validation: result.validation,
          snapshot: result.snapshot,
          layout: {
            rootNodeId: result.layout.rootNodeId,
            nodeCount: result.layout.nodeCount,
            sectionIds: result.layout.sectionIds,
            detectedSections: result.layout.detectedSections
          },
          artifacts: {
            capture: result.capture.artifacts,
            export: result.artifacts
          }
        });
      }

      if (typeof pastedHtml === "string" && pastedHtml.trim()) {
        const result = await runExportPipelineV3FromHtml(pastedHtml, {
          preferBrowser: true
        });

        if (result.capture.renderer !== "browser") {
          return NextResponse.json(
            {
              error: BROWSER_CAPTURE_FAILURE_MESSAGE,
              report: result.report
            },
            { status: 422 }
          );
        }

        const blockingError = resolveVisualBlockingError(result);

        if (blockingError) {
          return NextResponse.json(
            {
              error: blockingError,
              report: result.report,
              validation: result.validation,
              snapshot: result.snapshot
            },
            { status: 422 }
          );
        }

        return NextResponse.json({
          id: result.resolvedSource.id,
          mode: "converter-v3-export",
          sourceKind: result.resolvedSource.sourceKind,
          renderer: result.capture.renderer,
          title: result.elementorDocument.title,
          summary: result.capture.summary,
          selectedMode: result.analysis.selectedMode,
          emittedMode: result.emittedMode,
          fallbackReason: result.fallbackReason,
          warnings: result.report.warnings,
          analysis: result.analysis,
          validation: result.validation,
          snapshot: result.snapshot,
          layout: {
            rootNodeId: result.layout.rootNodeId,
            nodeCount: result.layout.nodeCount,
            sectionIds: result.layout.sectionIds,
            detectedSections: result.layout.detectedSections
          },
          artifacts: {
            capture: result.capture.artifacts,
            export: result.artifacts
          }
        });
      }

      return NextResponse.json(
        { error: "Envie um HTML ou um ZIP compativel para a captura v3." },
        { status: 400 }
      );
    }

    const payload = (await request.json()) as { html?: string };

    if (!payload.html?.trim()) {
      return NextResponse.json(
        { error: "Envie um HTML valido para a captura v3." },
        { status: 400 }
      );
    }

    const result = await runExportPipelineV3FromHtml(payload.html, {
      preferBrowser: true
    });

    if (result.capture.renderer !== "browser") {
      return NextResponse.json(
        {
          error: BROWSER_CAPTURE_FAILURE_MESSAGE,
          report: result.report
        },
        { status: 422 }
      );
    }

    const blockingError = resolveVisualBlockingError(result);

    if (blockingError) {
      return NextResponse.json(
        {
          error: blockingError,
          report: result.report,
          validation: result.validation,
          snapshot: result.snapshot
        },
        { status: 422 }
      );
    }

    return NextResponse.json({
      id: result.resolvedSource.id,
      mode: "converter-v3-export",
      sourceKind: result.resolvedSource.sourceKind,
      renderer: result.capture.renderer,
      title: result.elementorDocument.title,
      summary: result.capture.summary,
      selectedMode: result.analysis.selectedMode,
      emittedMode: result.emittedMode,
      fallbackReason: result.fallbackReason,
      warnings: result.report.warnings,
      analysis: result.analysis,
      validation: result.validation,
      snapshot: result.snapshot,
      layout: {
        rootNodeId: result.layout.rootNodeId,
        nodeCount: result.layout.nodeCount,
        sectionIds: result.layout.sectionIds,
        detectedSections: result.layout.detectedSections
      },
      artifacts: {
        capture: result.capture.artifacts,
        export: result.artifacts
      }
    });
  } catch (error) {
    if (error instanceof VisualValidationError) {
      return NextResponse.json(
        {
          error: error.message,
          validation: error.report,
          issues: error.report.issues
        },
        { status: 422 }
      );
    }

    const message =
      error instanceof Error
        ? error.message
        : "Nao foi possivel gerar a captura da converter-v3.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
