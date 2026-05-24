import { UploadForm } from "@/components/UploadForm";

export default function UploadPage() {
  return (
    <main className="mx-auto max-w-4xl px-5 py-12">
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-coral">
          Novo site Lovable
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink">
          Envie o build do seu site
        </h1>
        <p className="mt-3 max-w-2xl text-ink/70">
          O envio agora acontece somente por arquivo: use um HTML exportado ou um ZIP que
          contenha `index.html`. Projetos Lovable baixados do GitHub precisam ser compilados
          antes do envio.
        </p>
      </div>
      <UploadForm />
    </main>
  );
}
