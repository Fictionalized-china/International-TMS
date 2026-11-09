const liveDataRoutePatterns = [
  /^\/admin\/(?:portal|quotations|orders|loading|billing|shipments|workbenches|notifications|domestic-tracking|documents|cargo)(?:\/|$)/,
  /^\/warehouse(?:\/(?!login(?:\/|$))[^?]*)?$/,
  /^\/portal(?:\/(?!login(?:\/|$)|register(?:\/|$))[^?]*)?$/,
] as const;

/**
 * Operational pages project data that can be changed by another account on a
 * different browser or machine. BroadcastChannel gives same-browser updates;
 * these routes additionally need a lightweight visible-page refresh loop.
 */
export function isLiveDataRoute(pathname: string) {
  return liveDataRoutePatterns.some((pattern) => pattern.test(pathname));
}

export function canRequestLiveDataRefresh(input: {
  visibilityState: DocumentVisibilityState;
  navigationState: "idle" | "loading" | "submitting";
  revalidationState: "idle" | "loading";
  fetcherStates?: readonly ("idle" | "loading" | "submitting")[];
}) {
  return (
    input.visibilityState === "visible" &&
    input.navigationState === "idle" &&
    input.revalidationState === "idle" &&
    (input.fetcherStates ?? []).every(state => state === "idle")
  );
}

/** Deduplicate delivery channels, not business data. Missing/legacy/malformed
 * ids remain conservative refresh hints. This bounded set lives in one App
 * instance and never suppresses periodic, focus or visibility refreshes. */
export function createLiveDataSignalReceiver(currentSenderId: string) {
  const seen = new Set<string>();
  return (signal: unknown) => {
    if (!shouldRefreshForDataMutationSignal(signal, currentSenderId)) return false;
    let payload = signal;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch { return true; }
    }
    if (!payload || typeof payload !== "object") return true;
    const { senderId, signalId } = payload as { senderId?: unknown; signalId?: unknown };
    if (typeof senderId !== "string" || !senderId || senderId.length > 128 ||
        typeof signalId !== "string" || !signalId || signalId.length > 128) return true;
    const key = JSON.stringify([senderId, signalId]);
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 64) seen.delete(seen.values().next().value!);
    return true;
  };
}

export function shouldRefreshForDataMutationSignal(
  signal: unknown,
  currentSenderId: string,
) {
  let payload: unknown = signal;
  if (typeof signal === "string") {
    try {
      payload = JSON.parse(signal);
    } catch {
      return true;
    }
  }
  if (!payload || typeof payload !== "object") return true;
  const senderId = (payload as { senderId?: unknown }).senderId;
  if (typeof senderId !== "string" || !senderId) return true;
  return senderId !== currentSenderId;
}
