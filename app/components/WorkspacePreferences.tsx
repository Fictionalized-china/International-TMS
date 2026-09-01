import { useCallback, useEffect, useState } from "react";
import { Modal } from "./Modal";
import { submitForm } from "../lib/form-submit";
import {
  nextDensity,
  nextMotion,
  normalizeDensity,
  normalizeMotion,
  type DensityMode,
  type MotionMode,
} from "../lib/workspace-preferences";

const densityKey = "itms:workspace-density";
const motionKey = "itms:workspace-motion";

function isEditableTarget(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && Boolean(
    target.closest("input,textarea,select,[contenteditable='true']"),
  );
}

function isVisible(element: HTMLElement) {
  return !element.hasAttribute("disabled") && element.getClientRects().length > 0;
}

function findPageSearch() {
  const selectors = [
    "main [data-keyboard-search]",
    "main input[type='search']",
    "main input[name='q']",
    "main input[name='keyword']",
    "main .filters input:not([type='hidden'])",
    "main .warehouse-queue-filter input:not([type='hidden'])",
  ];
  return Array.from(document.querySelectorAll<HTMLElement>(selectors.join(","))).find(isVisible) ?? null;
}

function moveToNextFormControl(target: HTMLElement) {
  const form = target.closest<HTMLFormElement>("form[data-enter-flow]");
  if (!form) return false;
  if (target.matches("textarea,select,[contenteditable='true'],input[list],input[type='file'],input[type='checkbox'],input[type='radio']")) return false;
  if (target.getAttribute("role") === "combobox") return false;
  const controls = Array.from(form.querySelectorAll<HTMLElement>([
    "input:not([type='hidden']):not([disabled]):not([readonly])",
    "select:not([disabled])",
    "textarea:not([disabled]):not([readonly])",
    "button[type='submit']:not([disabled])",
    "button:not([type]):not([disabled])",
    "input[type='submit']:not([disabled])",
  ].join(","))).filter((element) => isVisible(element) && element.tabIndex >= 0);
  const currentIndex = controls.indexOf(target);
  if (currentIndex < 0 || currentIndex >= controls.length - 1) return false;
  controls[currentIndex + 1]?.focus();
  return true;
}

export function WorkspacePreferences() {
  const [density, setDensity] = useState<DensityMode>("compact");
  const [motion, setMotion] = useState<MotionMode>("on");
  const [ready, setReady] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    let storedDensity: DensityMode = "compact";
    let storedMotion: MotionMode = "on";
    try {
      storedDensity = normalizeDensity(window.localStorage.getItem(densityKey));
      storedMotion = normalizeMotion(window.localStorage.getItem(motionKey));
    } catch {
      // Private or locked-down browser profiles may block local storage.
    }
    setDensity(storedDensity);
    setMotion(storedMotion);
    document.documentElement.dataset.density = storedDensity;
    document.documentElement.dataset.motion = storedMotion;
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.density = density;
    document.documentElement.dataset.motion = motion;
    try {
      window.localStorage.setItem(densityKey, density);
      window.localStorage.setItem(motionKey, motion);
    } catch {
      // The preference still applies to the current page session.
    }
  }, [density, motion, ready]);

  const toggleDensity = useCallback(() => {
    const next = nextDensity(density);
    setDensity(next);
    setAnnouncement(next === "compact" ? "已切换为紧凑模式。" : "已切换为舒适模式。");
  }, [density]);

  const toggleMotion = useCallback(() => {
    const next = nextMotion(motion);
    setMotion(next);
    setAnnouncement(next === "off" ? "已关闭界面动效。" : "已开启功能动效。");
  }, [motion]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const editable = isEditableTarget(event.target);

      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && editable) {
        const target = event.target as HTMLElement;
        if (moveToNextFormControl(target)) {
          event.preventDefault();
          setAnnouncement("已进入下一个填写项。");
          return;
        }
      }

      if (event.key === "/" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !editable) {
        const search = findPageSearch();
        if (!search) {
          setAnnouncement("当前页面没有可用的快速查找框。");
          return;
        }
        event.preventDefault();
        search.focus();
        if (search instanceof HTMLInputElement) search.select();
        setAnnouncement("已定位到当前页面的快速查找框。");
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && editable) {
        const form = (event.target as HTMLElement).closest<HTMLFormElement>("form[data-keyboard-submit]");
        const submitter = form?.querySelector<HTMLButtonElement>(
          "button[type='submit']:not([disabled]),button:not([type]):not([disabled]),input[type='submit']:not([disabled])",
        );
        if (!form || !submitter || !(submitter instanceof HTMLButtonElement)) return;
        event.preventDefault();
        submitForm(form, { submitter });
        setAnnouncement("已通过快捷键提交当前表单。");
        return;
      }

      if (event.altKey && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        toggleDensity();
        return;
      }
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        toggleMotion();
        return;
      }
      if (event.key === "?" && !editable && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [toggleDensity, toggleMotion]);

  return (
    <div className="workspace-preferences" aria-label="工作区显示与快捷键">
      <button
        type="button"
        className="workspace-preference-button"
        onClick={toggleDensity}
        title="切换信息密度（Alt+Shift+D）"
        aria-pressed={density === "comfortable"}
      >
        密度：{density === "compact" ? "紧凑" : "舒适"}
      </button>
      <button
        type="button"
        className="workspace-preference-button"
        onClick={toggleMotion}
        title="开关功能动效（Alt+Shift+M）"
        aria-pressed={motion === "on"}
      >
        动效：{motion === "on" ? "开" : "关"}
      </button>
      <button
        type="button"
        className="workspace-preference-button shortcut-help-button"
        onClick={() => setHelpOpen(true)}
        title="查看键盘快捷键（?）"
        aria-label="查看键盘快捷键"
      >
        ?
      </button>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</span>
      <Modal title="键盘快捷键" isOpen={helpOpen} onOpenChange={setHelpOpen}>
        <div className="shortcut-help-list">
          <div><kbd>/</kbd><span><strong>快速查找</strong><small>定位当前页面的关键词输入框</small></span></div>
          <div><kbd>Ctrl</kbd><b>+</b><kbd>Enter</kbd><span><strong>保存当前表单</strong><small>仅在明确支持快捷提交的录入表单中生效</small></span></div>
          <div><kbd>Enter</kbd><span><strong>连续录入</strong><small>在支持的高频表单中进入下一个填写项</small></span></div>
          <div><kbd>Alt</kbd><b>+</b><kbd>Shift</kbd><b>+</b><kbd>D</kbd><span><strong>切换信息密度</strong><small>紧凑与舒适模式即时切换并自动记忆</small></span></div>
          <div><kbd>Alt</kbd><b>+</b><kbd>Shift</kbd><b>+</b><kbd>M</kbd><span><strong>开关功能动效</strong><small>低配电脑可关闭所有非必要过渡</small></span></div>
          <div><kbd>Tab</kbd><span><strong>顺序办理</strong><small>按页面顺序移动焦点，弹窗内焦点不会逃逸</small></span></div>
          <div><kbd>Esc</kbd><span><strong>关闭当前弹窗</strong><small>返回打开弹窗前的操作位置</small></span></div>
        </div>
      </Modal>
    </div>
  );
}
