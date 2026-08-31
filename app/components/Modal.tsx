import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  if (typeof document === "undefined" || scrollLockCount > 0) return;
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
      const dialog = targetedDialog ?? openDialogs[openDialogs.length - 1];
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
        scrollArea.scrollTop + scrollArea.clientHeight >= scrollArea.scrollHeight - 1;
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

const focusableSelector = [
  "[data-autofocus]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type ModalProps = {
  title: string;
  triggerLabel?: string;
  children: ReactNode | ((controls: { close: () => void }) => ReactNode);
  closeSignal?: unknown;
  openSignal?: unknown;
  isOpen?: boolean;
  size?: "normal" | "wide" | "xwide";
  dialogClassName?: string;
  triggerClassName?: string;
  closeOnBackdrop?: boolean;
  dismissible?:boolean;
  dirty?: boolean;
  discardMessage?: string;
  initialFocusSelector?: string;
  onClose?: () => void;
  onOpenChange?: (open: boolean) => void;
};

export function Modal({
  title,
  triggerLabel,
  children,
  closeSignal,
  openSignal,
  isOpen,
  size = "normal",
  dialogClassName = "",
  triggerClassName = "primary",
  closeOnBackdrop = false,
  dismissible = true,
  dirty = false,
  discardMessage = "当前内容尚未保存，确定放弃本次修改吗？",
  initialFocusSelector,
  onClose,
  onOpenChange,
}: ModalProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isOpen ?? uncontrolledOpen;
  const titleId = useId();
  const modalId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useModalScrollLock(open);

  const updateOpen = useCallback((nextOpen: boolean) => {
    if (isOpen === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [isOpen, onOpenChange]);

  const close = useCallback((force = false) => {
    if(!force&&!dismissible)return;
    if (!force && dirty && typeof window !== "undefined" && !window.confirm(discardMessage)) return;
    updateOpen(false);
    onClose?.();
  }, [dirty, dismissible, discardMessage, onClose, updateOpen]);

  useEffect(() => {
    if (!closeSignal) return;
    close(true);
  }, [closeSignal, close]);

  useEffect(() => {
    if (openSignal) updateOpen(true);
  }, [openSignal, updateOpen]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : triggerRef.current;
    const frame = window.requestAnimationFrame(() => {
      const preferred = initialFocusSelector
        ? dialogRef.current?.querySelector<HTMLElement>(initialFocusSelector)
        : null;
      const first = preferred ?? dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
      first?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      window.requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, [initialFocusSelector, open]);

  useEffect(() => {
    if (!open) return;
    const keepFocusInside = (event: KeyboardEvent) => {
      const openDialogs = document.querySelectorAll<HTMLElement>(".modal-backdrop[data-modal-id]");
      const topDialog = openDialogs.item(openDialogs.length - 1);
      if (topDialog?.dataset.modalId !== modalId) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keepFocusInside, true);
    return () => document.removeEventListener("keydown", keepFocusInside, true);
  }, [close, modalId, open]);

  const dialog = open && typeof document !== "undefined"
    ? createPortal(
        <div
          className="modal-backdrop"
          data-modal-id={modalId}
          role="presentation"
          onMouseDown={(event) => {
            if (closeOnBackdrop && event.target === event.currentTarget) close();
          }}
        >
          <section
            className={`modal-card ${size === "normal" ? "" : size} ${dialogClassName}`.trim()}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
          >
            <header className="modal-header">
              <h2 id={titleId}>{title}</h2>
              {dismissible&&<button
                  type="button"
                  className="modal-close"
                  aria-label="关闭"
                  onClick={() => close()}
                >
                  ×
                </button>}
            </header>
            <div className="modal-body">
              {typeof children === "function" ? children({ close: () => close() }) : children}
            </div>
          </section>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {triggerLabel && (
        <button
          ref={triggerRef}
          type="button"
          className={triggerClassName}
          onClick={() => updateOpen(true)}
        >
          {triggerLabel}
        </button>
      )}
      {dialog}
    </>
  );
}
