import { useEffect, useMemo, useRef, useState } from "react";
import { useFetchers, useNavigation, useRevalidator } from "react-router";
import { connectionStatusLabel, hasActiveInteraction } from "../lib/interaction-state";

export function GlobalInteractionFeedback() {
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const activeFetcherCount = fetchers.filter((fetcher) => fetcher.state !== "idle").length;
  const busy = hasActiveInteraction(
    navigation.state,
    fetchers.map((fetcher) => fetcher.state),
  );
  const wasBusy = useRef(false);
  const [slow, setSlow] = useState(false);
  const [announcement, setAnnouncement] = useState("");

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
  const syncing = navigation.state !== "idle" || revalidator.state !== "idle";
  const [online, setOnline] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

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

  useEffect(() => {
    if (!syncing && online) setLastUpdatedAt(new Date());
  }, [online, syncing]);

  const label = useMemo(
    () => connectionStatusLabel({ online, syncing, lastUpdatedAt }),
    [lastUpdatedAt, online, syncing],
  );

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
