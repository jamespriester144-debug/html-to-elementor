"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function UploadForm() {
  const router = useRouter();
  const [html, setHtml] = useState("");
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

    if (isHtml) {
      setHtml(await file.text());
    }

    if (isZip) {
      setHtml("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const request: RequestInit =
        file !== null
          ? (() => {
              const formData = new FormData();
              formData.append("file", file);

              if (html.trim()) {
                formData.append("html", html);
              }

              return {
                method: "POST",
                body: formData
              };
            })()
          : {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ html })
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

      <label className="block">
        <span className="mb-2 block text-sm font-semibold text-ink">
          HTML exportado
        </span>
        <textarea
          className="min-h-80 w-full rounded-lg border border-ink/15 bg-white p-4 font-mono text-sm text-ink outline-none transition focus:border-moss focus:ring-4 focus:ring-moss/10"
          placeholder="<main><h1>Site Lovable</h1><p>Cole aqui o HTML exportado...</p></main>"
          value={html}
          onChange={(event) => {
            setFile(null);
            setFileName("");
            setHtml(event.target.value);
          }}
        />
      </label>

      {error ? <p className="text-sm font-medium text-coral">{error}</p> : null}

      <button
        className="rounded-lg bg-moss px-5 py-3 text-sm font-semibold text-white transition hover:bg-moss/90 disabled:cursor-not-allowed disabled:bg-ink/30"
        disabled={isSubmitting || (!html.trim() && file === null)}
        type="submit"
      >
        {isSubmitting ? "Convertendo..." : "Converter site Lovable"}
      </button>
    </form>
  );
}
