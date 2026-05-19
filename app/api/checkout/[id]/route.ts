import { NextRequest, NextResponse } from "next/server";

import { getConversion } from "@/lib/conversions";
import { createStripeCheckoutSession } from "@/lib/stripe";

type CheckoutRouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: NextRequest, context: CheckoutRouteContext) {
  try {
    const { id } = await context.params;
    const conversion = await getConversion(id);

    if (!conversion) {
      return NextResponse.json(
        { error: "Conversao nao encontrada." },
        { status: 404 }
      );
    }

    if (conversion.status === "paid") {
      return NextResponse.redirect(new URL(`/download/${id}`, _request.url));
    }

    const session = await createStripeCheckoutSession(id);

    if (!session.url) {
      return NextResponse.json(
        { error: "Stripe nao retornou URL de checkout." },
        { status: 502 }
      );
    }

    return NextResponse.redirect(session.url, { status: 303 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Nao foi possivel criar o checkout."
      },
      { status: 500 }
    );
  }
}
