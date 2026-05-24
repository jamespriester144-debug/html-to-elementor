import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto grid min-h-[calc(100vh-73px)] max-w-6xl items-center gap-10 px-5 py-16 lg:grid-cols-[1.05fr_0.95fr]">
      <section>
        <p className="mb-4 text-sm font-semibold uppercase tracking-wide text-coral">
          Lovable para Elementor
        </p>
        <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-ink md:text-6xl">
          Converta sites Lovable baixados do GitHub em templates Elementor.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-ink/70">
          Envie um arquivo HTML exportado ou um ZIP com o build do seu projeto Lovable,
          revise a previa, pague com Stripe e baixe o JSON para importar no Elementor.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            className="rounded-lg bg-moss px-5 py-3 text-sm font-semibold text-white transition hover:bg-moss/90"
            href="/upload"
          >
            Converter site Lovable
          </Link>
          <a
            className="rounded-lg border border-ink/15 px-5 py-3 text-sm font-semibold text-ink transition hover:border-ink/30"
            href="#fluxo"
          >
            Ver fluxo
          </a>
        </div>
      </section>

      <section
        className="rounded-lg border border-ink/10 bg-white p-6 shadow-soft"
        id="fluxo"
      >
        <div className="space-y-4">
          {[
            "Baixe o projeto no GitHub",
            "Gere o build HTML do Lovable",
            "Envie arquivo HTML ou ZIP com index.html",
            "Revise a previa",
            "Pague com Stripe",
            "Baixe o template Elementor"
          ].map((item, index) => (
            <div className="flex items-center gap-4" key={item}>
              <span className="grid size-9 place-items-center rounded-full bg-moss/10 text-sm font-semibold text-moss">
                {index + 1}
              </span>
              <span className="font-medium text-ink">{item}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
