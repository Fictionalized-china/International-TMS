import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useNavigation,
  useRevalidator,
} from "react-router";
import { useEffect, useRef } from "react";

import type { Route } from "./+types/root";
import { useExpandableDialogScrollLock } from "./components/Modal";
import "./app.css";

export const links: Route.LinksFunction = () => [];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const location = useLocation();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const warehouseMutation = useRef(false);
  useExpandableDialogScrollLock();
  useEffect(() => {
    if (navigation.state === "idle")
      document
        .querySelectorAll<HTMLDetailsElement>(
          "details.expandable[open]:not(.module-inline-create)",
        )
        .forEach((element) => element.removeAttribute("open"));
  }, [location.pathname, navigation.state]);
  useEffect(() => {
    if (navigation.state === "submitting") {
      const action = navigation.formAction || location.pathname;
      warehouseMutation.current =
        navigation.formMethod?.toUpperCase() !== "GET" &&
        new URL(action, window.location.origin).pathname.startsWith("/warehouse");
      return;
    }
    if (navigation.state !== "idle" || !warehouseMutation.current) return;
    warehouseMutation.current = false;
    const signal = JSON.stringify({ source: "warehouse", occurredAt: Date.now() });
    try {
      if ("BroadcastChannel" in window) {
        const channel = new BroadcastChannel("international-tms-data-sync");
        channel.postMessage(signal);
        channel.close();
      }
    } catch {
      // Cross-tab synchronization is an enhancement. Browsers may expose the
      // API while denying access in restricted/privacy contexts.
    }
    try {
      window.localStorage.setItem("international-tms-data-sync", signal);
    } catch {
      // Do not turn a successful warehouse mutation into a client crash when
      // storage is unavailable or blocked by browser policy.
    }
  }, [location.pathname, navigation.formAction, navigation.formMethod, navigation.state]);
  useEffect(() => {
    if (!location.pathname.startsWith("/admin")) return;
    const refresh = () => {
      if (revalidator.state === "idle") revalidator.revalidate();
    };
    let channel: BroadcastChannel | null = null;
    try {
      channel = "BroadcastChannel" in window
        ? new BroadcastChannel("international-tms-data-sync")
        : null;
    } catch {
      channel = null;
    }
    if (channel) channel.onmessage = refresh;
    const onStorage = (event: StorageEvent) => {
      if (event.key === "international-tms-data-sync") refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    const polling = location.pathname.startsWith("/admin/orders/")
      ? window.setInterval(() => {
          if (document.visibilityState === "visible") refresh();
        }, 2500)
      : null;
    return () => {
      channel?.close();
      if (polling !== null) window.clearInterval(polling);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
    };
  }, [location.pathname, revalidator]);
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "出现错误";
  let details = "系统暂时无法完成请求。";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "错误";
    details =
      error.status === 404
        ? "找不到请求的页面。"
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
