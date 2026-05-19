import { UploadForm } from "@/components/UploadForm";

export default function UploadPage() {
  return (
    <main className="mx-auto max-w-4xl px-5 py-12">
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-coral">
          Nova conversao
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink">
          Envie seu HTML
        </h1>
      </div>
      <UploadForm />
    </main>
  );
}
