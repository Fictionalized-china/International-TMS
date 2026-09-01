type OrderMarkLabelAvailability = {
  status: string;
  acceptedAt: string | null;
  quoteWithdrawn?: number;
};

export function orderMarkLabelAvailable({
  status,
  acceptedAt,
  quoteWithdrawn = 0,
}: OrderMarkLabelAvailability) {
  return Boolean(acceptedAt) && quoteWithdrawn !== 1 && status !== "cancelled";
}
