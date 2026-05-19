import type { ConversionStatus } from "@/types/conversion";

type StatusBadgeProps = {
  status: ConversionStatus;
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const isPaid = status === "paid";

  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
        isPaid ? "bg-moss/10 text-moss" : "bg-coral/10 text-coral"
      }`}
    >
      {isPaid ? "Pago" : "Pendente"}
    </span>
  );
}
