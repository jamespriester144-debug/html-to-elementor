"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleFileChange(file?: File) {
    setError("");

    if (!file) {
      return;
    }

    const isHtml = file.name.toLowerCase().endsWith(".html") || file.type === "text/html";
    const isZip =
      file.name.toLowerCase().endsWith(".zip") ||
      file.type === "application/zip" ||
      file.type === "application/x-zip-compressed";

    if (!isHtml && !isZip) {
      setError("Envie um arquivo .html ou um .zip do build contendo index.html.");
      return;
    }

    setFile(file);
    setFileName(file.name);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (file === null) {
      setError("Selecione um arquivo .html ou .zip antes de converter.");
      return;
    }

    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const request: RequestInit = {
        method: "POST",
        body: formData
      };

      const response = await fetch("/api/convert", request);
      const payload = (await response
        .json()
        .catch(() => ({}))) as { id?: string; error?: string };

      if (!response.ok || !payload.id) {
        throw new Error(payload.error ?? "Nao foi possivel converter o site.");
      }

      router.push(`/preview/${payload.id}`);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message === "Failed to fetch"
            ? "Nao foi possivel conectar com /api/convert. Verifique se o servidor esta rodando e se o .env.local esta configurado."
            : requestError.message
          : "Nao foi possivel converter o site."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <label className="block rounded-lg border border-dashed border-ink/25 bg-white p-6 text-center shadow-soft">
        <span className="block text-sm font-semibold text-ink">
          Enviar build .html ou .zip
        </span>
        <span className="mt-2 block text-sm text-ink/60">
          {fileName || "Escolha o index.html ou um ZIP exportado do build."}
        </span>
        <input
          accept=".html,.zip,text/html,application/zip,application/x-zip-compressed"
          className="sr-only"
          type="file"
          onChange={(event) => handleFileChange(event.target.files?.[0])}
        />
      </label>

      {error ? <p className="text-sm font-medium text-coral">{error}</p> : null}

      <button
        className="rounded-lg bg-moss px-5 py-3 text-sm font-semibold text-white transition hover:bg-moss/90 disabled:cursor-not-allowed disabled:bg-ink/30"
        disabled={isSubmitting || file === null}
        type="submit"
      >
        {isSubmitting ? "Convertendo..." : "Converter site Lovable"}
      </button>
    </form>
  );
}
