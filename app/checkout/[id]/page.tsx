import Link from "next/link";

import { CheckoutButton } from "@/components/CheckoutButton";
import { StatusBadge } from "@/components/StatusBadge";
import { requireConversion } from "@/lib/conversions";

type CheckoutPageProps = {
  params: Promise<{ id: string }>;
};

export default async function CheckoutPage({ params }: CheckoutPageProps) {
  const { id } = await params;
  const conversion = await requireConversion(id);

  if (conversion.status === "paid") {
    return (
      <main className="mx-auto max-w-3xl px-5 py-16">
        <StatusBadge status={conversion.status} />
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-ink">
          Pagamento confirmado
        </h1>
        <p className="mt-4 text-ink/70">
          O download deste template Elementor ja esta liberado.
        </p>
        <Link
          className="mt-8 inline-flex rounded-lg bg-moss px-5 py-3 text-sm font-semibold text-white"
          href={`/download/${conversion.id}`}
        >
          Baixar JSON
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-5 py-16">
      <StatusBadge status={conversion.status} />
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-ink">
        Liberar template Elementor
      </h1>
      <p className="mt-4 text-ink/70">
        Clique abaixo para pagar US$9.90 com Stripe Checkout. Apos a confirmacao,
        o JSON do site Lovable convertido sera liberado para download.
      </p>
      <CheckoutButton conversionId={conversion.id} />
      <Link
        className="mt-4 inline-flex text-sm font-semibold text-ink/70 hover:text-ink"
        href={`/preview/${conversion.id}`}
      >
        Voltar para previa do site
      </Link>
    </main>
  );
}
