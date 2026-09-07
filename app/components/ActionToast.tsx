import { useEffect, useMemo, useState } from "react";

type ActionToastTone = "success" | "error";

type ActionToastProps = {
  data?: unknown;
  message?: string | null;
  tone?: ActionToastTone;
  duration?: number;
};

function readActionFeedback(data: unknown): { message: string | null; tone: ActionToastTone } {
  if (!data || typeof data !== "object") return { message: null, tone: "success" };
  const record = data as Record<string, unknown>;
  if (typeof record.formError === "string" && record.formError.trim()) {
    return { message: record.formError, tone: "error" };
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return { message: record.error, tone: "error" };
  }
  if (typeof record.success === "string" && record.success.trim()) {
    return { message: record.success, tone: "success" };
  }
  return { message: null, tone: "success" };
}

export function ActionToast({ data, message, tone, duration = 4200 }: ActionToastProps) {
  const feedback = useMemo(() => readActionFeedback(data), [data]);
  const resolvedMessage = message?.trim() || feedback.message;
  const resolvedTone = tone ?? feedback.tone;
  const [visible, setVisible] = useState(Boolean(resolvedMessage));

  useEffect(() => {
    if (!resolvedMessage) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), duration);
    return () => window.clearTimeout(timer);
  }, [data, duration, resolvedMessage, resolvedTone]);

  if (!resolvedMessage || !visible) return null;
  return (
    <aside
      className={`action-toast ${resolvedTone}`}
      role={resolvedTone === "error" ? "alert" : "status"}
      aria-live={resolvedTone === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <div>
        <strong>{resolvedTone === "error" ? "操作未完成" : "操作成功"}</strong>
        <p>{resolvedMessage}</p>
      </div>
      <button type="button" aria-label="关闭提示" onClick={() => setVisible(false)}>×</button>
    </aside>
  );
}

