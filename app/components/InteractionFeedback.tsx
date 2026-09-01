import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBlocker,
  useFetchers,
  useNavigation,
  useRevalidator,
  type BlockerFunction,
} from "react-router";
import { connectionStatusLabel, hasActiveInteraction } from "../lib/interaction-state";

export function GlobalInteractionFeedback() {
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const busy = hasActiveInteraction(
    navigation.state,
    fetchers.map((fetcher) => fetcher.state),
  );
  const wasBusy = useRef(false);
  const [slow, setSlow] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const unsavedRegistry = useRef(new Map<string, string>());
  const [unsavedMessage, setUnsavedMessage] = useState("");

  useEffect(() => {
    const updateUnsavedRegistry = (event: Event) => {
      const detail = (event as CustomEvent<{
        id: string;
        active: boolean;
        message: string;
      }>).detail;
      if (!detail?.id) return;
      if (detail.active) unsavedRegistry.current.set(detail.id, detail.message);
      else unsavedRegistry.current.delete(detail.id);
      setUnsavedMessage([...unsavedRegistry.current.values()].at(-1) ?? "");
    };
    window.addEventListener("itms:unsaved-changes", updateUnsavedRegistry);
    return () => window.removeEventListener("itms:unsaved-changes", updateUnsavedRegistry);
  }, []);

  const blocker = useBlocker(useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => {
    if (!unsavedMessage || navigation.state !== "idle") return false;
    return `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !==
      `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`;
  }, [navigation.state, unsavedMessage]));

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(unsavedMessage || "当前内容尚未保存，确定离开吗？")) {
      const timer = window.setTimeout(() => blocker.proceed(), 0);
      return () => window.clearTimeout(timer);
    }
    else blocker.reset();
  }, [blocker, unsavedMessage]);

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      if (wasBusy.current) {
        setAnnouncement("请求已完成，请查看当前页面结果。");
        const clearTimer = window.setTimeout(() => setAnnouncement(""), 1800);
        wasBusy.current = false;
        return () => window.clearTimeout(clearTimer);
      }
      return;
    }

    wasBusy.current = true;
    setAnnouncement("正在处理请求，请勿重复提交。");
    const slowTimer = window.setTimeout(() => {
      setSlow(true);
      setAnnouncement("请求仍在处理中，完成后页面会自动更新。");
    }, 2000);
    return () => window.clearTimeout(slowTimer);
  }, [busy]);

  return (
    <>
      <div
        className={`interaction-progress${busy ? " is-active" : ""}${slow ? " is-slow" : ""}`}
        role={busy ? "progressbar" : undefined}
        aria-label={busy ? "系统正在处理请求" : undefined}
        aria-hidden={busy ? undefined : true}
      >
        <span />
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {slow && (
        <div className="interaction-slow-notice" role="status">
          正在处理，请勿重复点击；完成后页面会自动更新。
        </div>
      )}
    </>
  );
}

export function ConnectionStatus({ className = "" }: { className?: string }) {
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const fetchers = useFetchers();
  const syncing = navigation.state !== "idle" || revalidator.state !== "idle" ||
    fetchers.some((fetcher) => fetcher.state !== "idle");
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const syncOnlineState = () => setOnline(window.navigator.onLine);
    syncOnlineState();
    window.addEventListener("online", syncOnlineState);
    window.addEventListener("offline", syncOnlineState);
    return () => {
      window.removeEventListener("online", syncOnlineState);
      window.removeEventListener("offline", syncOnlineState);
    };
  }, []);

  const label = connectionStatusLabel({ online, syncing });

  return (
    <span
      className={`${className}${online ? "" : " is-offline"}${syncing ? " is-syncing" : ""}`.trim()}
      role="status"
      aria-live="polite"
    >
      <i aria-hidden="true" />
      {label}
    </span>
  );
}
