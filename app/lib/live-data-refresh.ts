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
}) {
  return (
    input.visibilityState === "visible" &&
    input.navigationState === "idle" &&
    input.revalidationState === "idle"
  );
}
