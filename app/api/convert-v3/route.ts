import { NextRequest, NextResponse } from "next/server";

import {
  runExportPipelineV3FromHtml,
  runExportPipelineV3FromUpload
} from "@/lib/converter-v3/orchestration/export-pipeline-v3";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      const pastedHtml = formData.get("html");

      if (file instanceof File) {
        const result = await runExportPipelineV3FromUpload(file);

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
          layout: {
            rootNodeId: result.layout.rootNodeId,
            nodeCount: result.layout.nodeCount,
            sectionIds: result.layout.sectionIds
          },
          artifacts: {
            capture: result.capture.artifacts,
            export: result.artifacts
          }
        });
      }

      if (typeof pastedHtml === "string" && pastedHtml.trim()) {
        const result = await runExportPipelineV3FromHtml(pastedHtml);

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
          layout: {
            rootNodeId: result.layout.rootNodeId,
            nodeCount: result.layout.nodeCount,
            sectionIds: result.layout.sectionIds
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

    const result = await runExportPipelineV3FromHtml(payload.html);

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
      layout: {
        rootNodeId: result.layout.rootNodeId,
        nodeCount: result.layout.nodeCount,
        sectionIds: result.layout.sectionIds
      },
      artifacts: {
        capture: result.capture.artifacts,
        export: result.artifacts
      }
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Nao foi possivel gerar a captura da converter-v3.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
