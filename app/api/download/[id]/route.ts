import { NextRequest, NextResponse } from "next/server";

import { getConversion, markConversionAsPaid } from "@/lib/conversions";
import { getStripeCheckoutSession } from "@/lib/stripe";

type DownloadRouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, context: DownloadRouteContext) {
  const { id } = await context.params;
  const conversion = await getConversion(id);

  if (!conversion) {
    return NextResponse.json({ error: "Conversao nao encontrada." }, { status: 404 });
  }

  let status = conversion.status;
  const sessionId = _request.nextUrl.searchParams.get("session_id");

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

  if (status !== "paid") {
    return NextResponse.json(
      { error: "Download bloqueado enquanto o status estiver pendente." },
      { status: 403 }
    );
  }

  return new NextResponse(JSON.stringify(conversion.elementor_json, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="elementor-template.json"'
    }
  });
}
