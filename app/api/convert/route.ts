import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";

import { createConversion } from "@/lib/conversions";
import { convertHtmlToElementor } from "@/lib/converter";

export const runtime = "nodejs";

async function extractHtmlFromZip(file: File): Promise<string> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(zip.files);
  const htmlFiles = Object.values(zip.files).filter((entry) => {
    const name = entry.name.toLowerCase();

    return !entry.dir && name.endsWith(".html") && !name.includes("__macosx/");
  });

  const selectedFile =
    htmlFiles.find((entry) => entry.name.toLowerCase().endsWith("index.html")) ??
    htmlFiles[0];

  if (!selectedFile) {
    const hasReactSource = entries.some((entry) => {
      const name = entry.name.toLowerCase();

      return (
        !entry.dir &&
        (name.endsWith(".tsx") ||
          name.endsWith(".jsx") ||
          name.endsWith("vite.config.ts") ||
          name.endsWith("vite.config.js") ||
          name.endsWith("package.json"))
      );
    });

    if (hasReactSource) {
      throw new Error(
        "Este .zip parece ser um projeto React/Vite/TanStack, nao um HTML exportado. Rode o build desse projeto e envie um .zip da pasta dist contendo index.html."
      );
    }

    throw new Error("O arquivo .zip nao contem nenhum arquivo .html.");
  }

  return selectedFile.async("text");
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let html = "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      const pastedHtml = formData.get("html");

      if (file instanceof File) {
        const fileName = file.name.toLowerCase();

        if (fileName.endsWith(".zip")) {
          html = await extractHtmlFromZip(file);
        } else {
          html = await file.text();
        }
      } else if (typeof pastedHtml === "string") {
        html = pastedHtml;
      }
    } else {
      const payload = (await request.json()) as { html?: string };
      html = payload.html ?? "";
    }

    if (!html.trim()) {
      return NextResponse.json({ error: "HTML e obrigatorio." }, { status: 400 });
    }

    const elementorJson = convertHtmlToElementor(html);
    const conversion = await createConversion(html, elementorJson);

    return NextResponse.json({ id: conversion.id });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Nao foi possivel converter o HTML.";
    const isUserInputError =
      message.includes(".zip") ||
      message.includes("HTML e obrigatorio") ||
      message.includes("arquivo .html");

    return NextResponse.json(
      {
        error: message
      },
      { status: isUserInputError ? 400 : 500 }
    );
  }
}
