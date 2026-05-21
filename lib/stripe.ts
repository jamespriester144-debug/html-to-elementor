import Stripe from "stripe";

import { getRequiredEnv, getSiteUrl } from "@/lib/env";

export function createStripeClient() {
  return new Stripe(getRequiredEnv("STRIPE_SECRET_KEY").trim());
}

export function getStripeWebhookSecret() {
  return getRequiredEnv("STRIPE_WEBHOOK_SECRET").trim();
}

export async function createStripeCheckoutSession(conversionId: string) {
  const stripe = createStripeClient();
  const siteUrl = getSiteUrl();

  return stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "Lovable site to Elementor template"
          },
          unit_amount: 990
        },
        quantity: 1
      }
    ],
    metadata: {
      conversion_id: conversionId
    },
    success_url: `${siteUrl}/download/${conversionId}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/preview/${conversionId}`
  });
}

export async function getStripeCheckoutSession(sessionId: string) {
  const stripe = createStripeClient();

  return stripe.checkout.sessions.retrieve(sessionId);
}
