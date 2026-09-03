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
import { isSqliteSchemaMismatchError } from "./lib/d1-errors";
import { useEffect, useRef } from "react";

import type { Route } from "./+types/root";
import { GlobalInteractionFeedback } from "./components/InteractionFeedback";
import { useExpandableDialogScrollLock } from "./components/Modal";
import "./app.css";

const sessionSlotBootstrap = `(() => {
  const param = "itmsTab";
  const storageKey = "international-tms-tab-session";
  const valid = value => typeof value === "string" && /^[a-zA-Z0-9_-]{12,64}$/.test(value);
  const current = new URL(window.location.href);
  let slot = current.searchParams.get(param);
  if (!valid(slot)) {
    try { slot = window.sessionStorage.getItem(storageKey); } catch { slot = null; }
  }
  if (!valid(slot)) return;
  try { window.sessionStorage.setItem(storageKey, slot); } catch {}
  if (current.searchParams.get(param) !== slot) {
    current.searchParams.set(param, slot);
    window.history.replaceState(window.history.state, "", current.pathname + current.search + current.hash);
  }
  const addSlot = value => {
    if (value == null || value === "") return value;
    try {
      const url = new URL(String(value), window.location.href);
      if (url.origin !== window.location.origin) return value;
      url.searchParams.set(param, slot);
      return url.pathname + url.search + url.hash;
    } catch { return value; }
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (state, unused, url) => original(state, unused, addSlot(url));
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    try {
      const target = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (target.origin === window.location.origin) {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
        headers.set("X-ITMS-Tab", slot);
        init = { ...init, headers };
      }
    } catch {}
    return originalFetch(input, init);
  };
})();`;

export const links: Route.LinksFunction = () => [];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0d263b" />
        <script dangerouslySetInnerHTML={{ __html: sessionSlotBootstrap }} />
        <Meta />
        <Links />
      </head>
      <body>
        <div className="legacy-browser-warning" role="alert">
          当前为 360 兼容模式，系统需要现代浏览器内核。请切换到“极速模式”后继续使用。
        </div>
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
    if (navigation.state === "idle") {
      document
        .querySelectorAll<HTMLDetailsElement>(
          "details.expandable[open]:not(.module-inline-create)",
        )
        .forEach((element) => element.removeAttribute("open"));
    }
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
      // 跨标签同步是增强能力，隐私模式拒绝该 API 时不能影响主业务提交。
    }
    try {
      window.localStorage.setItem("international-tms-data-sync", signal);
    } catch {
      // 本地存储不可用时保留本次服务端提交结果。
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

  return (
    <>
      <GlobalInteractionFeedback />
      <Outlet />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "系统暂时无法完成请求";
  let details = "当前页面发生异常。您可以重试、返回上一页，或回到工作台继续处理其他任务。";

  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "找不到该页面" : `请求失败（${error.status}）`;
    details = error.status === 404
      ? "页面地址可能已变更，请返回工作台重新进入。"
      : error.statusText || details;
  } else if (error instanceof Error) {
    console.error("Unhandled application error", error);
    if (isSqliteSchemaMismatchError(error)) {
      title = "系统正在同步数据库升级";
      details = "当前程序与数据库版本暂时不同步。系统已停止本次操作以保护数据，请稍后重试；若持续出现，请重新启动服务完成自动迁移。";
    }
  }

  return (
    <main className="error-boundary" role="alert">
      <p className="eyebrow">SYSTEM RECOVERY</p>
      <h1>{title}</h1>
      <p>{details}</p>
      <div className="button-row">
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          重试当前页面
        </button>
        <button type="button" className="secondary" onClick={() => window.history.back()}>
          返回上一页
        </button>
        <a className="text-button" href="/admin">回到工作台</a>
      </div>
      <small>表单内容是否已保存以页面提示为准；请勿连续重复提交。</small>
    </main>
  );
}
