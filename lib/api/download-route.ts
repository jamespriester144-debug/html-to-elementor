import { NextResponse } from "next/server";

import { getConversion, markConversionAsPaid } from "@/lib/conversions";
import {
  InvalidElementorJsonError,
  stringifyValidatedElementorJson
} from "@/lib/elementor-json";
import { getStripeCheckoutSession } from "@/lib/stripe";

type DownloadRouteContext = {
  params: Promise<{ id: string }>;
};

export type DownloadRouteDependencies = {
  getConversion: typeof getConversion;
  markConversionAsPaid: typeof markConversionAsPaid;
  getStripeCheckoutSession: typeof getStripeCheckoutSession;
};

const defaultDependencies: DownloadRouteDependencies = {
  getConversion,
  markConversionAsPaid,
  getStripeCheckoutSession
};

export function createDownloadGetHandler(
  deps: DownloadRouteDependencies = defaultDependencies
) {
  return async function handleDownloadGet(
    request: Request,
    context: DownloadRouteContext
  ) {
    try {
      const { id } = await context.params;
      const conversion = await deps.getConversion(id);

      if (!conversion) {
        return NextResponse.json(
          { error: "Conversao nao encontrada." },
          { status: 404 }
        );
      }

      let status = conversion.status;
      const sessionId = new URL(request.url).searchParams.get("session_id");

      if (status !== "paid" && sessionId) {
        const session = await deps.getStripeCheckoutSession(sessionId);
        const conversionId = session.metadata?.conversion_id;
        const paymentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id;

        if (session.payment_status === "paid" && conversionId === conversion.id) {
          await deps.markConversionAsPaid(conversion.id, paymentId);
          status = "paid";
        }
      }

      if (status !== "paid") {
        return NextResponse.json(
          { error: "Download bloqueado enquanto o status estiver pendente." },
          { status: 403 }
        );
      }

      const jsonText = stringifyValidatedElementorJson(conversion.elementor_json);

      return new NextResponse(jsonText, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": 'attachment; filename="elementor-template.json"'
        }
      });
    } catch (error) {
      if (error instanceof InvalidElementorJsonError) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const message =
        error instanceof Error
          ? error.message
          : "Nao foi possivel preparar o download do template Elementor.";

      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}
