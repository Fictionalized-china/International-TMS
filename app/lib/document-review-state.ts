export function documentReviewCloseSignal(
  signal: unknown,
  attachmentId: string,
) {
  return typeof signal === "string" && signal.startsWith(`${attachmentId}:`)
    ? signal
    : undefined;
}
