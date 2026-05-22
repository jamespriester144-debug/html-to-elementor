import crypto from "node:crypto";

import { NextResponse } from "next/server";

import { createConversion } from "@/lib/conversions";
import { persistEmbeddedConversionAssets } from "@/lib/converter-v2/asset-persistence";
import { runPixelPerfectConversionPipeline } from "@/lib/converter-v2/pipeline";
import { extractSourceFromUpload } from "@/lib/converter-v2/source-extractor";
import type { ConversionSourceKind } from "@/lib/converter-v2/types";
import type { ExportPipelineResult } from "@/lib/converter-v3/contracts/output";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import { runExportPipelineV3 } from "@/lib/converter-v3/orchestration/export-pipeline-v3";
import {
  resolveSourceFromHtml,
  resolveSourceFromUpload
} from "@/lib/converter-v3/resolve/source-resolver";
import type { ElementorDocument } from "@/types/conversion";

type ConvertRequest = Pick<Request, "headers" | "formData" | "json">;

type RequestInput =
  | {
      kind: "upload";
      file: File;
    }
  | {
      kind: "html";
      html: string;
    };

type PreparedConversion =
  | {
      kind: "success";
      previewHtml: string;
      elementorDocument: ElementorDocument;
      body: Record<string, unknown>;
    }
  | {
      kind: "response";
      status: number;
      body: Record<string, unknown>;
    };

export type ConvertRouteDependencies = {
  createConversion: typeof createConversion;
  createConversionKey: () => string;
  extractSourceFromUpload: typeof extractSourceFromUpload;
  persistEmbeddedConversionAssets: typeof persistEmbeddedConversionAssets;
  resolveSourceFromHtml: typeof resolveSourceFromHtml;
  resolveSourceFromUpload: typeof resolveSourceFromUpload;
  runExportPipelineV3: typeof runExportPipelineV3;
  runPixelPerfectConversionPipeline: typeof runPixelPerfectConversionPipeline;
};

const defaultDependencies: ConvertRouteDependencies = {
  createConversion,
  createConversionKey: () => crypto.randomUUID(),
  extractSourceFromUpload,
  persistEmbeddedConversionAssets,
  resolveSourceFromHtml,
  resolveSourceFromUpload,
  runExportPipelineV3,
  runPixelPerfectConversionPipeline
};

function getEmptySourceError() {
  return "Envie um HTML exportado ou um ZIP compativel com HTML/Lovable.";
}

function getUnexpectedErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Nao foi possivel converter o site para Elementor.";
}

function appendFallbackReason(warnings: string[], fallbackReason?: string) {
  return [...new Set(fallbackReason ? [fallbackReason, ...warnings] : warnings)];
}

function buildArtifactsFromV3(result: ExportPipelineResult) {
  return {
    capture: result.capture.artifacts,
    export: result.artifacts
  };
}

function buildV3Success(result: ExportPipelineResult): PreparedConversion {
  const warnings = appendFallbackReason(
    result.report.warnings,
    result.fallbackReason
  );
  const status = warnings.length > 0 ? "warning" : "success";

  return {
    kind: "success",
    previewHtml: result.capture.renderedHtml,
    elementorDocument: result.elementorDocument,
    body: {
      message:
        status === "warning"
          ? "Conversao concluida com avisos."
          : "Conversao concluida com sucesso.",
      status,
      sourceKind: result.resolvedSource.sourceKind,
      renderer: result.capture.renderer,
      report: result.report,
      validation: result.validation,
      selectedMode: result.analysis.selectedMode,
      emittedMode: result.emittedMode,
      fallbackReason: result.fallbackReason,
      screenshots: result.capture.artifacts.screenshots,
      warnings,
      artifacts: buildArtifactsFromV3(result)
    }
  };
}

async function extractRequestInput(
  request: ConvertRequest
): Promise<RequestInput | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");
    const pastedHtml = formData.get("html");

    if (file instanceof File) {
      return {
        kind: "upload",
        file
      };
    }

    if (typeof pastedHtml === "string" && pastedHtml.trim()) {
      return {
        kind: "html",
        html: pastedHtml
      };
    }

    return null;
  }

  const payload = (await request.json()) as { html?: string };

  if (!payload.html?.trim()) {
    return null;
  }

  return {
    kind: "html",
    html: payload.html
  };
}

async function resolveSourceForV3(
  input: RequestInput,
  deps: ConvertRouteDependencies
): Promise<ResolvedSource> {
  return input.kind === "upload"
    ? deps.resolveSourceFromUpload(input.file)
    : deps.resolveSourceFromHtml(input.html);
}

async function buildV2FallbackResponse(
  input: RequestInput,
  deps: ConvertRouteDependencies,
  v3Error: unknown
): Promise<PreparedConversion> {
  const source =
    input.kind === "upload"
      ? await deps.extractSourceFromUpload(input.file)
      : {
          html: input.html,
          sourceKind: "raw-html" as ConversionSourceKind
        };

  if (!source.html.trim()) {
    return {
      kind: "response",
      status: 400,
      body: {
        error: getEmptySourceError()
      }
    };
  }

  const pipeline = await deps.runPixelPerfectConversionPipeline(
    source.html,
    source.sourceKind
  );
  const fallbackReason = `Converter-v3 falhou e a rota usou a converter-v2 como fallback: ${getUnexpectedErrorMessage(v3Error)}`;
  const warnings = appendFallbackReason(
    pipeline.report.warnings,
    fallbackReason
  );
  const status = pipeline.report.exportBlocked
    ? "blocked"
    : warnings.length > 0
      ? "warning"
      : "success";
  const body = {
    status,
    sourceKind: pipeline.sourceKind,
    renderer: "server",
    strategy: pipeline.strategy,
    report: pipeline.report,
    selectedMode: "pixel-perfect",
    emittedMode: "pixel-perfect",
    fallbackReason,
    screenshots: pipeline.report.screenshots,
    warnings,
    artifacts: {
      capture: {
        screenshots: pipeline.report.screenshots
      },
      export: {
        outputDir: pipeline.outputDir
      }
    }
  };

  if (pipeline.report.exportBlocked) {
    return {
      kind: "response",
      status: 422,
      body: {
        error:
          "A conversao foi bloqueada porque o fallback pixel-perfect da converter-v2 nao preservou todo o conteudo esperado.",
        ...body
      }
    };
  }

  return {
    kind: "success",
    previewHtml: pipeline.cleanHtml,
    elementorDocument: pipeline.elementorJson,
    body: {
      message: "Conversao concluida com fallback da converter-v2.",
      ...body
    }
  };
}

async function prepareConversion(
  input: RequestInput,
  deps: ConvertRouteDependencies
): Promise<PreparedConversion> {
  try {
    const resolvedSource = await resolveSourceForV3(input, deps);

    if (!resolvedSource.html.trim()) {
      throw new Error(getEmptySourceError());
    }

    const result = await deps.runExportPipelineV3(resolvedSource);
    return buildV3Success(result);
  } catch (v3Error) {
    return buildV2FallbackResponse(input, deps, v3Error);
  }
}

export function createConvertPostHandler(
  deps: ConvertRouteDependencies = defaultDependencies
) {
  return async function handleConvertPost(request: Request) {
    try {
      const input = await extractRequestInput(request);

      if (!input) {
        return NextResponse.json(
          { error: getEmptySourceError() },
          { status: 400 }
        );
      }

      const prepared = await prepareConversion(input, deps);

      if (prepared.kind === "response") {
        return NextResponse.json(prepared.body, { status: prepared.status });
      }

      const persisted = await deps.persistEmbeddedConversionAssets(
        prepared.previewHtml,
        prepared.elementorDocument,
        deps.createConversionKey()
      );
      const conversion = await deps.createConversion(
        persisted.html,
        persisted.elementorJson
      );

      return NextResponse.json({
        id: conversion.id,
        ...prepared.body
      });
    } catch (error) {
      return NextResponse.json(
        { error: getUnexpectedErrorMessage(error) },
        { status: 500 }
      );
    }
  };
}
