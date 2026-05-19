"use client";

import { useState } from "react";

type CheckoutButtonProps = {
  conversionId: string;
};

export function CheckoutButton({ conversionId }: CheckoutButtonProps) {
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleCheckout() {
    setError("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ conversion_id: conversionId })
      });

      const payload = (await response
        .json()
        .catch(() => ({}))) as { url?: string; error?: string };

      if (!response.ok || !payload.url) {
        throw new Error(payload.error ?? "Nao foi possivel abrir o checkout.");
      }

      window.location.href = payload.url;
    } catch (checkoutError) {
      setError(
        checkoutError instanceof Error
          ? checkoutError.message
          : "Nao foi possivel abrir o checkout."
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div>
      <button
        className="mt-8 rounded-lg bg-moss px-5 py-3 text-sm font-semibold text-white transition hover:bg-moss/90 disabled:cursor-not-allowed disabled:bg-ink/30"
        disabled={isLoading}
        type="button"
        onClick={handleCheckout}
      >
        {isLoading ? "Abrindo checkout..." : "Pagar com Stripe"}
      </button>
      {error ? <p className="mt-3 text-sm font-medium text-coral">{error}</p> : null}
    </div>
  );
}
