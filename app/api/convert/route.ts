import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { createConversion } from "@/lib/conversions";
import { persistEmbeddedConversionAssets } from "@/lib/converter-v2/asset-persistence";
import { runPixelPerfectConversionPipeline } from "@/lib/converter-v2/pipeline";
import { extractSourceFromUpload } from "@/lib/converter-v2/source-extractor";
import type { ConversionSourceKind } from "@/lib/converter-v2/types";

export const runtime = "nodejs";

type RequestSourcePayload = {
  html: string;
  sourceKind: ConversionSourceKind;
};

async function extractRequestSource(request: NextRequest): Promise<RequestSourcePayload> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");
    const pastedHtml = formData.get("html");

    if (file instanceof File) {
      return extractSourceFromUpload(file);
    }

    if (typeof pastedHtml === "string" && pastedHtml.trim()) {
      return {
        html: pastedHtml,
        sourceKind: "raw-html"
      };
    }

    return { html: "", sourceKind: "raw-html" };
  }

  const payload = (await request.json()) as { html?: string };
  return {
    html: payload.html ?? "",
    sourceKind: "raw-html"
  };
}

export async function POST(request: NextRequest) {
  try {
    const source = await extractRequestSource(request);

    if (!source.html.trim()) {
      return NextResponse.json(
        { error: "Envie um HTML exportado ou um ZIP compativel com HTML/Lovable." },
        { status: 400 }
      );
    }

    const pipeline = await runPixelPerfectConversionPipeline(
      source.html,
      source.sourceKind
    );

    if (pipeline.report.exportBlocked) {
      return NextResponse.json(
        {
          error:
            "A conversao foi bloqueada porque o template Elementor pixel-perfect nao preservou todo o conteudo esperado.",
          report: pipeline.report,
          strategy: pipeline.strategy,
          sourceKind: pipeline.sourceKind,
          outputDir: pipeline.outputDir
        },
        { status: 422 }
      );
    }

    const persisted = await persistEmbeddedConversionAssets(
      pipeline.cleanHtml,
      pipeline.elementorJson,
      crypto.randomUUID()
    );
    const conversion = await createConversion(
      persisted.html,
      persisted.elementorJson
    );

    return NextResponse.json({
      id: conversion.id,
      message:
        pipeline.report.status === "warning"
          ? "Conversao concluida com avisos."
          : "Conversao concluida com sucesso.",
      status: pipeline.report.status,
      warnings: pipeline.report.warnings,
      report: pipeline.report,
      strategy: pipeline.strategy,
      sourceKind: pipeline.sourceKind,
      outputDir: pipeline.outputDir
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Nao foi possivel converter o site para Elementor.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
