import { NextRequest, NextResponse } from "next/server";

import { getConversion } from "@/lib/conversions";
import { createStripeCheckoutSession } from "@/lib/stripe";

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const wantsJson = contentType.includes("application/json");
    let conversionId = "";

    if (wantsJson) {
      const body = (await request.json()) as { conversion_id?: string };
      conversionId = body.conversion_id ?? "";
    } else {
      const formData = await request.formData();
      const formConversionId = formData.get("conversion_id");
      conversionId = typeof formConversionId === "string" ? formConversionId : "";
    }

    if (!conversionId) {
      return NextResponse.json(
        { error: "conversion_id e obrigatorio." },
        { status: 400 }
      );
    }

    const conversion = await getConversion(conversionId);

    if (!conversion) {
      return NextResponse.json(
        { error: "Conversao nao encontrada." },
        { status: 404 }
      );
    }

    if (conversion.status === "paid") {
      const downloadUrl = new URL(`/download/${conversionId}`, request.url).toString();

      if (wantsJson) {
        return NextResponse.json({ url: downloadUrl });
      }

      return NextResponse.redirect(downloadUrl);
    }

    const session = await createStripeCheckoutSession(conversionId);

    if (!session.url) {
      return NextResponse.json(
        { error: "Stripe nao retornou URL de checkout." },
        { status: 502 }
      );
    }

    if (wantsJson) {
      return NextResponse.json({ url: session.url });
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
