import Link from "next/link";

import { StatusBadge } from "@/components/StatusBadge";
import { markConversionAsPaid, requireConversion } from "@/lib/conversions";
import { getStripeCheckoutSession } from "@/lib/stripe";

type DownloadPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ session_id?: string }>;
};

export default async function DownloadPage({
  params,
  searchParams
}: DownloadPageProps) {
  const { id } = await params;
  const { session_id: sessionId } = await searchParams;
  const conversion = await requireConversion(id);
  let status = conversion.status;

  if (status !== "paid" && sessionId) {
    const session = await getStripeCheckoutSession(sessionId);
    const conversionId = session.metadata?.conversion_id;
    const paymentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;

    if (session.payment_status === "paid" && conversionId === conversion.id) {
      await markConversionAsPaid(conversion.id, paymentId);
      status = "paid";
    }
  }

  const isPaid = status === "paid";

  return (
    <main className="mx-auto max-w-3xl px-5 py-16">
      <StatusBadge status={status} />
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-ink">
        Download do template Elementor
      </h1>
      <p className="mt-4 text-ink/70">
        {isPaid
          ? "Pagamento confirmado. O template do site Lovable esta pronto para baixar."
          : "O download fica bloqueado enquanto o status estiver pendente."}
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        {isPaid ? (
          <a
            className="rounded-lg bg-moss px-5 py-3 text-sm font-semibold text-white transition hover:bg-moss/90"
            href={`/api/download/${conversion.id}`}
          >
            Baixar template
          </a>
        ) : (
          <Link
            className="rounded-lg bg-coral px-5 py-3 text-sm font-semibold text-white transition hover:bg-coral/90"
            href={`/checkout/${conversion.id}`}
          >
            Pagar agora
          </Link>
        )}
        <Link
          className="rounded-lg border border-ink/15 px-5 py-3 text-sm font-semibold text-ink transition hover:border-ink/30"
          href={`/preview/${conversion.id}`}
        >
          Ver previa do site
        </Link>
      </div>
    </main>
  );
}
