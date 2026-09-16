import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Parse and decode a request pathname without allowing malformed percent
 * escapes to escape the HTTP request boundary.
 */
export function safeRequestPathname(requestUrl, host = "localhost") {
  try {
    const pathname = new URL(requestUrl || "/", `http://${host || "localhost"}`).pathname;
    return { kind: "pathname", pathname: decodeURIComponent(pathname) };
  } catch {
    return { kind: "malformed" };
  }
}

/** Resolve a decoded URL pathname and prove that it remains under root. */
export function resolveStaticRequestPath(root, requestUrl, host = "localhost") {
  const parsed = safeRequestPathname(requestUrl, host);
  if (parsed.kind === "malformed") return parsed;

  const candidate = resolve(root, parsed.pathname.replace(/^[/\\]+/, ""));
  const childPath = relative(root, candidate);
  if (childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
    return { kind: "outside-root" };
  }
  return { kind: "candidate", path: candidate, pathname: parsed.pathname };
}
