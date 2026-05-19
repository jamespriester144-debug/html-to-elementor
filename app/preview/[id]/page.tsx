import Link from "next/link";

import { StatusBadge } from "@/components/StatusBadge";
import { requireConversion } from "@/lib/conversions";

type PreviewPageProps = {
  params: Promise<{ id: string }>;
};

export default async function PreviewPage({ params }: PreviewPageProps) {
  const { id } = await params;
  const conversion = await requireConversion(id);

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-coral">
            Previa
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">
            {conversion.elementor_json.title}
          </h1>
        </div>
        <StatusBadge status={conversion.status} />
      </div>

      <iframe
        className="h-[620px] w-full rounded-lg border border-ink/15 bg-white shadow-soft"
        sandbox=""
        srcDoc={conversion.html}
        title="Previa do HTML convertido"
      />

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          className="rounded-lg bg-moss px-5 py-3 text-sm font-semibold text-white transition hover:bg-moss/90"
          href={`/checkout/${conversion.id}`}
        >
          Liberar Download
        </Link>
      </div>
    </main>
  );
}
