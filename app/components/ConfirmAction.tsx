import { useRef, useState } from "react";
import { Modal } from "./Modal";
import { submitForm } from "../lib/form-submit";

type ConfirmActionProps = {
  title: string;
  description: string;
  triggerLabel: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmationKeyword?: string;
  className?: string;
  confirmClassName?: string;
  formId?: string;
  name?: string;
  value?: string;
  pending?: boolean;
  pendingLabel?: string;
  formNoValidate?: boolean;
  disabled?: boolean;
};

export function ConfirmAction({
  title,
  description,
  triggerLabel,
  confirmLabel = "确认执行",
  cancelLabel = "取消",
  confirmationKeyword,
  className = "text-button danger",
  confirmClassName = "danger",
  formId,
  name,
  value,
  pending = false,
  pendingLabel = "正在处理…",
  formNoValidate = true,
  disabled = false,
}: ConfirmActionProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [error, setError] = useState("");
  const canConfirm = !confirmationKeyword || keyword === confirmationKeyword;

  const submit = () => {
    const form = formId
      ? document.getElementById(formId) as HTMLFormElement | null
      : triggerRef.current?.form ?? null;
    if (!form) {
      setError("未找到需要提交的表单，请刷新页面后重试。");
      return;
    }

    const submitter = document.createElement("button");
    submitter.type = "submit";
    submitter.hidden = true;
    submitter.formNoValidate = formNoValidate;
    if (name) submitter.name = name;
    if (value !== undefined) submitter.value = value;
    form.appendChild(submitter);
    submitForm(form, { submitter });
    submitter.remove();
    setOpen(false);
    setKeyword("");
    setError("");
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        disabled={disabled || pending}
        aria-haspopup="dialog"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        {pending ? pendingLabel : triggerLabel}
      </button>
      <Modal
        title={title}
        isOpen={open}
        onOpenChange={setOpen}
        initialFocusSelector={confirmationKeyword ? "[data-confirm-keyword]" : "[data-confirm-action]"}
      >
        <div className="confirm-action-content">
          <p>{description}</p>
          {confirmationKeyword && (
            <label className="field">
              <span>请输入“{confirmationKeyword}”以继续</span>
              <input
                data-confirm-keyword
                value={keyword}
                autoComplete="off"
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
          )}
          {error && <div className="alert error" role="alert">{error}</div>}
          <div className="confirm-action-buttons">
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={confirmClassName}
              data-confirm-action
              disabled={disabled || !canConfirm || pending}
              onClick={submit}
            >
              {pending ? pendingLabel : confirmLabel}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
