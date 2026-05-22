import crypto from "node:crypto";

import { NextResponse } from "next/server";

import { createConversion } from "@/lib/conversions";
import { persistEmbeddedConversionAssets } from "@/lib/converter-v2/asset-persistence";
import type { ExportPipelineResult } from "@/lib/converter-v3/contracts/output";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import { runExportPipelineV3 } from "@/lib/converter-v3/orchestration/export-pipeline-v3";
import {
  resolveSourceFromHtml,
  resolveSourceFromUpload
} from "@/lib/converter-v3/resolve/source-resolver";
import { VisualValidationError } from "@/lib/converter-v3/visual-regression-validator";
import {
  InvalidElementorJsonError,
  stringifyValidatedElementorJson
} from "@/lib/elementor-json";
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
  persistEmbeddedConversionAssets: typeof persistEmbeddedConversionAssets;
  resolveSourceFromHtml: typeof resolveSourceFromHtml;
  resolveSourceFromUpload: typeof resolveSourceFromUpload;
  runExportPipelineV3: typeof runExportPipelineV3;
};

const defaultDependencies: ConvertRouteDependencies = {
  createConversion,
  createConversionKey: () => crypto.randomUUID(),
  persistEmbeddedConversionAssets,
  resolveSourceFromHtml,
  resolveSourceFromUpload,
  runExportPipelineV3
};

const BROWSER_CAPTURE_FAILURE_MESSAGE =
  "Captura visual do navegador falhou. Snapshot não pôde ser gerado.";
const MIN_VISUAL_SIMILARITY = 0.99;

function getEmptySourceError() {
  return "Envie um HTML valido ou um ZIP compativel para conversao.";
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

function buildWarnings(result: ExportPipelineResult) {
  return appendFallbackReason(result.report.warnings, result.fallbackReason);
}

function resolveVisualSimilarity(result: ExportPipelineResult) {
  if (result.emittedMode === "pixel-perfect") {
    return 1;
  }

  return result.snapshot?.overallSimilarity ?? 0;
}

function resolveDownloadEligibilityError(result: ExportPipelineResult) {
  if (result.capture.renderer !== "browser") {
    return BROWSER_CAPTURE_FAILURE_MESSAGE;
  }

  if (
    result.emittedMode !== "snapshot" &&
    result.emittedMode !== "pixel-perfect"
  ) {
    return `Conversao bloqueada: o modo final ${result.emittedMode} nao atende o requisito visual-perfect.`;
  }

  if (resolveVisualSimilarity(result) < MIN_VISUAL_SIMILARITY) {
    return `Conversao bloqueada: similaridade visual final ficou em ${(
      resolveVisualSimilarity(result) * 100
    ).toFixed(2)}%.`;
  }

  return undefined;
}

function buildBlockedResponse(
  result: ExportPipelineResult,
  error: string
): PreparedConversion {
  const warnings = buildWarnings(result);

  return {
    kind: "response",
    status: 422,
    body: {
      error,
      status: "error",
      renderer: result.capture.renderer,
      selectedMode: result.analysis.selectedMode,
      emittedMode: result.emittedMode,
      validation: result.validation,
      report: result.report,
      snapshotEnabled: result.report.snapshotEnabled,
      snapshotReason: result.report.snapshotReason,
      snapshot: result.snapshot,
      warnings,
      artifacts: buildArtifactsFromV3(result)
    }
  };
}

function buildV3Success(result: ExportPipelineResult): PreparedConversion {
  const warnings = buildWarnings(result);
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
      snapshotEnabled: result.report.snapshotEnabled,
      snapshotReason: result.report.snapshotReason,
      snapshot: result.snapshot,
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

async function prepareConversion(
  input: RequestInput,
  deps: ConvertRouteDependencies
): Promise<PreparedConversion> {
  const resolvedSource = await resolveSourceForV3(input, deps);

  if (!resolvedSource.html.trim()) {
    return {
      kind: "response",
      status: 400,
      body: {
        error: getEmptySourceError()
      }
    };
  }

  const result = await deps.runExportPipelineV3(resolvedSource, {
    preferBrowser: true
  });
  const eligibilityError = resolveDownloadEligibilityError(result);

  if (eligibilityError) {
    return buildBlockedResponse(result, eligibilityError);
  }

  return buildV3Success(result);
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
      stringifyValidatedElementorJson(persisted.elementorJson);
      const conversion = await deps.createConversion(
        persisted.html,
        persisted.elementorJson
      );

      return NextResponse.json({
        id: conversion.id,
        ...prepared.body
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

      if (error instanceof InvalidElementorJsonError) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json(
        { error: getUnexpectedErrorMessage(error) },
        { status: 500 }
      );
    }
  };
}
