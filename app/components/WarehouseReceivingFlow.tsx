import type { ReactNode } from "react";
import { Form } from "react-router";

export type WarehouseReceiptResult = "" | "partial" | "ready" | "exception";

export function WarehouseReceivingScanPanel({
  warehouseId,
  reference,
  inputLabel,
  placeholder,
  submitLabel,
  hint,
  hiddenFields = [],
}: {
  warehouseId: string;
  reference: string;
  inputLabel: string;
  placeholder: string;
  submitLabel: string;
  hint: string;
  hiddenFields?: Array<{ name: string; value: string }>;
}) {
  return (
    <section className="panel acceptance-scan-panel no-print">
      <Form method="get" action="." className="acceptance-scan-form">
        <input type="hidden" name="warehouseId" value={warehouseId} />
        {hiddenFields.filter((field) => field.value).map((field) => (
          <input key={field.name} type="hidden" name={field.name} value={field.value} />
        ))}
        <label className="field scan-field">
          <span>{inputLabel}</span>
          <input
            name="reference"
            data-keyboard-search
            defaultValue={reference}
            autoFocus
            autoComplete="off"
            placeholder={placeholder}
            required
          />
        </label>
        <button className="primary">{submitLabel}</button>
        <small>{hint}</small>
      </Form>
    </section>
  );
}

export function WarehouseReceivingOrderStrip({
  facts,
}: {
  facts: Array<{ label: string; value: ReactNode; detail?: ReactNode }>;
}) {
  return (
    <section className="panel acceptance-order-strip" aria-label="待验收订单摘要">
      {facts.map((fact) => (
        <span key={fact.label}>
          <small>{fact.label}</small>
          <strong>{fact.value}</strong>
          {fact.detail ? <em>{fact.detail}</em> : null}
        </span>
      ))}
    </section>
  );
}

export function WarehouseReceiptResultSelector({
  value,
  onChange,
  showPartial,
  readyLabel,
  readyHint,
  readyDisabled = false,
  required = true,
  exceptionHint = "数量、重量、包装或货况存在异常。",
  exceptionFooter,
}: {
  value: WarehouseReceiptResult;
  onChange: (value: WarehouseReceiptResult) => void;
  showPartial: boolean;
  readyLabel: string;
  readyHint: string;
  readyDisabled?: boolean;
  required?: boolean;
  exceptionHint?: string;
  exceptionFooter: string;
}) {
  return (
    <>
      <fieldset className="acceptance-result">
        <legend>本次验收结果{required ? " *" : ""}</legend>
        {showPartial && (
          <ReceiptResultOption
            value="partial"
            checked={value === "partial"}
            onChange={onChange}
            label="分批正常入库"
            hint="本批货物无异常，订单尚未全部到齐"
            required={required}
          />
        )}
        <ReceiptResultOption
          value="ready"
          checked={value === "ready"}
          onChange={onChange}
          label={readyLabel}
          hint={readyHint}
          required={required}
          disabled={readyDisabled}
        />
        <ReceiptResultOption
          value="exception"
          checked={value === "exception"}
          onChange={onChange}
          label="异常入库"
          hint={exceptionHint}
          required={required}
        />
      </fieldset>
      {value === "exception" && (
        <label className="field span-2 warehouse-exception-note">
          <span>异常说明 *</span>
          <textarea name="exceptionNotes" rows={3} required placeholder={exceptionFooter} />
        </label>
      )}
    </>
  );
}

function ReceiptResultOption({
  value,
  checked,
  onChange,
  label,
  hint,
  required,
  disabled = false,
}: {
  value: Exclude<WarehouseReceiptResult, "">;
  checked: boolean;
  onChange: (value: WarehouseReceiptResult) => void;
  label: string;
  hint: string;
  required: boolean;
  disabled?: boolean;
}) {
  return (
    <label>
      <input
        type="radio"
        name="receiptResult"
        value={value}
        checked={checked}
        required={required}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span><b>{label}</b><small>{hint}</small></span>
    </label>
  );
}
