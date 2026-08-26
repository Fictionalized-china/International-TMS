import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type ScrollSnapshot = {
  scrollY: number;
  htmlOverflow: string;
  bodyOverflow: string;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyRight: string;
  bodyWidth: string;
};

let scrollLockCount = 0;
let scrollSnapshot: ScrollSnapshot | null = null;

function acquirePageScrollLock() {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  scrollLockCount += 1;
  if (scrollLockCount > 1) return;

  const html = document.documentElement;
  const body = document.body;
  scrollSnapshot = {
    scrollY: window.scrollY,
    htmlOverflow: html.style.overflow,
    bodyOverflow: body.style.overflow,
    bodyPosition: body.style.position,
    bodyTop: body.style.top,
    bodyLeft: body.style.left,
    bodyRight: body.style.right,
    bodyWidth: body.style.width,
  };
  html.classList.add("modal-scroll-locked");
  body.classList.add("modal-scroll-locked");
  html.style.overflow = "hidden";
  body.style.overflow = "hidden";
  body.style.position = "fixed";
  body.style.top = `-${scrollSnapshot.scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
}

function releasePageScrollLock() {
  if (typeof document === "undefined" || typeof window === "undefined" || scrollLockCount === 0) return;
  scrollLockCount -= 1;
  if (scrollLockCount > 0 || !scrollSnapshot) return;

  const html = document.documentElement;
  const body = document.body;
  const snapshot = scrollSnapshot;
  html.classList.remove("modal-scroll-locked");
  body.classList.remove("modal-scroll-locked");
  html.style.overflow = snapshot.htmlOverflow;
  body.style.overflow = snapshot.bodyOverflow;
  body.style.position = snapshot.bodyPosition;
  body.style.top = snapshot.bodyTop;
  body.style.left = snapshot.bodyLeft;
  body.style.right = snapshot.bodyRight;
  body.style.width = snapshot.bodyWidth;
  scrollSnapshot = null;
  window.scrollTo(0, snapshot.scrollY);
}

function clearStalePageScrollLock() {
  if (typeof document === "undefined") return;
  if (scrollLockCount > 0) {
    releasePageScrollLock();
    return;
  }
  const html = document.documentElement;
  const body = document.body;
  html.classList.remove("modal-scroll-locked");
  body.classList.remove("modal-scroll-locked");
  html.style.overflow = "";
  body.style.overflow = "";
  body.style.position = "";
  body.style.top = "";
  body.style.left = "";
  body.style.right = "";
  body.style.width = "";
}

export function useModalScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    acquirePageScrollLock();
    return releasePageScrollLock;
  }, [active]);
}

export function useExpandableDialogScrollLock() {
  useEffect(() => {
    let locked = false;
    const syncLock = () => {
      const shouldLock = Boolean(
        document.querySelector("details.expandable[open]:not(.module-inline-create)"),
      );
      if (shouldLock && !locked) {
        acquirePageScrollLock();
        locked = true;
      } else if (!shouldLock && locked) {
        releasePageScrollLock();
        locked = false;
      } else if (!shouldLock) {
        clearStalePageScrollLock();
      }
    };
    const observer = new MutationObserver(syncLock);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    const redirectWheelToDialog = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const targetedDialog = target?.closest<HTMLDetailsElement>(
        "details.expandable[open]:not(.module-inline-create)",
      );
      const openDialogs = Array.from(
        document.querySelectorAll<HTMLDetailsElement>(
          "details.expandable[open]:not(.module-inline-create)",
        ),
      );
      const dialog = targetedDialog ?? openDialogs.at(-1);
      if (!dialog) return;
      const scrollArea = Array.from(dialog.children).find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.tagName !== "SUMMARY",
      );
      if (!scrollArea) return;
      if (scrollArea.scrollHeight <= scrollArea.clientHeight) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const atTop = scrollArea.scrollTop <= 0;
      const atBottom =
        scrollArea.scrollTop + scrollArea.clientHeight >=
        scrollArea.scrollHeight - 1;
      if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      scrollArea.scrollBy({ top: event.deltaY, behavior: "auto" });
    };
    document.addEventListener("wheel", redirectWheelToDialog, {
      capture: true,
      passive: false,
    });
    syncLock();
    return () => {
      observer.disconnect();
      document.removeEventListener("wheel", redirectWheelToDialog, true);
      if (locked) releasePageScrollLock();
    };
  }, []);
}

type ModalProps = {
  title: string;
  triggerLabel?: string;
  children: ReactNode | ((controls: { close: () => void }) => ReactNode);
  closeSignal?: unknown;
  openSignal?: unknown;
  size?: "normal" | "wide" | "xwide";
  triggerClassName?: string;
  onClose?: () => void;
};

export function Modal({ title, triggerLabel, children, closeSignal, openSignal, size = "normal", triggerClassName = "primary", onClose }: ModalProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const modalId = useId();
  useModalScrollLock(open);
  const close = () => {
    setOpen(false);
    onClose?.();
  };

  useEffect(() => {
    if (closeSignal) setOpen(false);
  }, [closeSignal]);

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openDialogs = document.querySelectorAll<HTMLElement>(".modal-backdrop[data-modal-id]");
      const topDialog = openDialogs.item(openDialogs.length - 1);
      if (topDialog?.dataset.modalId !== modalId) return;
      close();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  const dialog =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            className="modal-backdrop"
            data-modal-id={modalId}
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <section
              className={`modal-card ${size === "normal" ? "" : size}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
            >
              <header className="modal-header">
                <h2 id={titleId}>{title}</h2>
                <button
                  type="button"
                  className="modal-close"
                  aria-label="关闭"
                  onClick={close}
                >
                  ×
                </button>
              </header>
              <div className="modal-body">
                {typeof children === "function"
                  ? children({ close })
                  : children}
              </div>
            </section>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {triggerLabel && <button
        type="button"
        className={triggerClassName}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </button>}
      {dialog}
    </>
  );
}
