import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useFetchers,
  useLocation,
  useNavigation,
  useRevalidator,
} from "react-router";
import { isSqliteSchemaMismatchError } from "./lib/d1-errors";
import { useEffect, useRef, useState } from "react";

import type { Route } from "./+types/root";
import { GlobalInteractionFeedback } from "./components/InteractionFeedback";
import { useExpandableDialogScrollLock } from "./components/Modal";
import {
  canRequestLiveDataRefresh,
  isLiveDataRoute,
  shouldRefreshForDataMutationSignal,
} from "./lib/live-data-refresh";
import { normalizeSessionSlot, withSessionSlot } from "./lib/session-slot";
import "./app.css";

type DataMutationSource = {
  source: "warehouse" | "admin" | "portal";
  path: string;
  intent: string;
};

const DATA_SYNC_CHANNEL = "international-tms-data-sync";

function resolveDataMutation({
  method,
  action,
  currentPath,
  formData,
}: {
  method?: string;
  action?: string;
  currentPath: string;
  formData?: FormData;
}): DataMutationSource | null {
  if (!method || method.toUpperCase() === "GET") return null;
  const actionPath = new URL(action || currentPath, window.location.origin).pathname;
  const source = (["warehouse", "admin", "portal"] as const).find((item) =>
    actionPath.startsWith(`/${item}`),
  );
  if (!source) return null;
  return {
    source,
    path: actionPath,
    intent: String(formData?.get("intent") || ""),
  };
}

function createDataMutationSenderId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    // Fall back for older or restricted browsers.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function publishDataMutation(mutation: DataMutationSource, senderId: string) {
  const sessionSlot = new URL(window.location.href).searchParams.get("itmsTab");
  const signal = JSON.stringify({ ...mutation, sessionSlot, senderId, occurredAt: Date.now() });
  try {
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(DATA_SYNC_CHANNEL);
      channel.postMessage(signal);
      channel.close();
    }
  } catch {
    // Cross-tab refresh is an enhancement; a restricted browser must not break the mutation itself.
  }
  try {
    window.localStorage.setItem(DATA_SYNC_CHANNEL, signal);
  } catch {
    // Keep the successful server mutation when local storage is unavailable.
  }
}

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
  document.addEventListener("click", event => {
    const target = event.target;
    const anchor = target && typeof target.closest === "function"
      ? target.closest("a[href]")
      : null;
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;
    const next = addSlot(href);
    if (typeof next === "string" && next !== href) anchor.setAttribute("href", next);
  }, true);
  document.addEventListener("submit", event => {
    const form = event.target;
    if (!form || form.tagName !== "FORM") return;
    const action = form.getAttribute("action") || window.location.href;
    const next = addSlot(action);
    if (typeof next === "string") form.setAttribute("action", next);
  }, true);
  const originalOpen = window.open.bind(window);
  window.open = (url, target, features) => originalOpen(addSlot(url), target, features);
})();`;

function SessionSlotHydrator() {
  useEffect(() => {
    const current = new URL(window.location.href);
    if (normalizeSessionSlot(current.searchParams.get("itmsTab"))) return;
    let slot: string | null = null;
    try {
      slot = normalizeSessionSlot(
        window.sessionStorage.getItem("international-tms-tab-session"),
      );
    } catch {
      return;
    }
    if (!slot) return;
    window.history.replaceState(
      window.history.state,
      "",
      withSessionSlot(`${current.pathname}${current.search}${current.hash}`, slot),
    );
  }, []);
  return null;
}

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
        <SessionSlotHydrator />
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
  const fetchers = useFetchers();
  const revalidator = useRevalidator();
  const dataMutationSource = useRef<DataMutationSource | null>(null);
  const fetcherMutationSources = useRef(new Map<string, DataMutationSource>());
  const [remoteMutationVersion, setRemoteMutationVersion] = useState(0);
  const handledRemoteMutationVersion = useRef(0);
  const senderIdRef = useRef<string | null>(null);
  const senderId = senderIdRef.current ?? createDataMutationSenderId();
  senderIdRef.current = senderId;
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
      dataMutationSource.current = resolveDataMutation({
        method: navigation.formMethod,
        action: navigation.formAction,
        currentPath: location.pathname,
        formData: navigation.formData,
      });
      return;
    }
    if (navigation.state !== "idle" || !dataMutationSource.current) return;
    const mutation = dataMutationSource.current;
    dataMutationSource.current = null;
    publishDataMutation(mutation, senderId);
  }, [location.pathname, navigation.formAction, navigation.formData, navigation.formMethod, navigation.state, senderId]);

  useEffect(() => {
    const visibleFetcherKeys = new Set(fetchers.map((fetcher) => fetcher.key));
    for (const fetcher of fetchers) {
      if (fetcher.state === "submitting") {
        const mutation = resolveDataMutation({
          method: fetcher.formMethod,
          action: fetcher.formAction,
          currentPath: location.pathname,
          formData: fetcher.formData,
        });
        if (mutation) fetcherMutationSources.current.set(fetcher.key, mutation);
        continue;
      }
      if (fetcher.state === "idle") {
        const mutation = fetcherMutationSources.current.get(fetcher.key);
        if (mutation) {
          fetcherMutationSources.current.delete(fetcher.key);
          publishDataMutation(mutation, senderId);
        }
      }
    }
    for (const [key, mutation] of fetcherMutationSources.current) {
      if (!visibleFetcherKeys.has(key)) {
        fetcherMutationSources.current.delete(key);
        publishDataMutation(mutation, senderId);
      }
    }
  }, [fetchers, location.pathname, senderId]);

  useEffect(() => {
    if (!isLiveDataRoute(location.pathname)) return;
    const refresh = (signal: unknown) => {
      if (!shouldRefreshForDataMutationSignal(signal, senderId)) return;
      setRemoteMutationVersion((version) => version + 1);
    };
    let channel: BroadcastChannel | null = null;
    try {
      channel = "BroadcastChannel" in window
        ? new BroadcastChannel(DATA_SYNC_CHANNEL)
        : null;
    } catch {
      channel = null;
    }
    if (channel) channel.onmessage = (event) => refresh(event.data);
    const onStorage = (event: StorageEvent) => {
      if (event.key === DATA_SYNC_CHANNEL) refresh(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      channel?.close();
      window.removeEventListener("storage", onStorage);
    };
  }, [location.pathname, senderId]);

  useEffect(() => {
    if (!isLiveDataRoute(location.pathname)) return;
    if (remoteMutationVersion <= handledRemoteMutationVersion.current) return;
    if (!canRequestLiveDataRefresh({
      visibilityState: document.visibilityState,
      navigationState: navigation.state,
      revalidationState: revalidator.state,
    })) return;
    const pendingVersion = remoteMutationVersion;
    const timer = window.setTimeout(() => {
      handledRemoteMutationVersion.current = pendingVersion;
      revalidator.revalidate();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [location.pathname, navigation.state, remoteMutationVersion, revalidator]);

  useEffect(() => {
    if (!isLiveDataRoute(location.pathname)) return;
    const requestRefresh = () => {
      if (!canRequestLiveDataRefresh({
        visibilityState: document.visibilityState,
        navigationState: navigation.state,
        revalidationState: revalidator.state,
      })) return;
      setRemoteMutationVersion((version) => version + 1);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestRefresh();
    };
    window.addEventListener("focus", requestRefresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") requestRefresh();
    }, 10_000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", requestRefresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [location.pathname, navigation.state, revalidator.state]);

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
    const responseMessage = typeof error.data === "string"
      ? error.data.trim()
      : null;
    details = error.status === 404
      ? "页面地址可能已变更，请返回工作台重新进入。"
      : responseMessage || error.statusText || details;
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
