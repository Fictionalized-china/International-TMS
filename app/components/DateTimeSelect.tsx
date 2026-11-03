import { useState } from "react";

const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));

export function splitDateTimeInputValue(value?: string) {
  const match = value?.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  return {
    date: match ? `${match[1]}-${match[2]}-${match[3]}` : "",
    hour: match?.[4] ?? "09",
    minute: match?.[5] ?? "00",
  };
}

/** Date can be picked immediately; hour and minute are click-selectable.
 * Only the hidden combined value is submitted, retaining existing action contracts. */
export function DateTimeSelect({ name, defaultValue, required = false, disabled = false }: {
  name: string;
  defaultValue?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const [parts, setParts] = useState(() => splitDateTimeInputValue(defaultValue));
  const update = (key: keyof typeof parts, value: string) =>
    setParts((current) => ({ ...current, [key]: value }));
  return <span className="date-time-select" role="group" aria-label="选择日期和时间">
    <input className="date-time-select__part date-time-select__date" type="date" aria-label="选择日期" value={parts.date} required={required} disabled={disabled} onChange={(event) => update("date", event.currentTarget.value)} />
    <span className="date-time-select__divider" aria-hidden="true" />
    <select className="date-time-select__part date-time-select__hour" aria-label="选择小时" value={parts.hour} disabled={disabled} onChange={(event) => update("hour", event.currentTarget.value)}>
      {hours.map((hour) => <option key={hour} value={hour}>{hour} 时</option>)}
    </select>
    <span className="date-time-select__separator" aria-hidden="true">:</span>
    <select className="date-time-select__part date-time-select__minute" aria-label="选择分钟" value={parts.minute} disabled={disabled} onChange={(event) => update("minute", event.currentTarget.value)}>
      {minutes.map((minute) => <option key={minute} value={minute}>{minute} 分</option>)}
    </select>
    <input type="hidden" name={name} value={parts.date ? `${parts.date}T${parts.hour}:${parts.minute}` : ""} disabled={disabled} />
  </span>;
}
