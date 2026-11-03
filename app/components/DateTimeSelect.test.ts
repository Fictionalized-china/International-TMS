import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { splitDateTimeInputValue } from "./DateTimeSelect";
import { DateTimeSelect } from "./DateTimeSelect";

describe("splitDateTimeInputValue", () => {
  it("keeps minute precision and makes an empty date optional", () => {
    expect(splitDateTimeInputValue("2026-10-28T11:10:35")).toEqual({ date: "2026-10-28", hour: "11", minute: "10" });
    expect(splitDateTimeInputValue()).toEqual({ date: "", hour: "09", minute: "00" });
  });

  it("submits the same datetime-local form value without seconds", () => {
    const html = renderToStaticMarkup(createElement(DateTimeSelect, { name: "plannedDepartureAt", defaultValue: "2026-10-29T11:10", required: true }));
    expect(html).toContain('type="date"');
    expect(html).toContain('name="plannedDepartureAt"');
    expect(html).toContain('value="2026-10-29T11:10"');
    expect(html).toContain("required");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="选择日期和时间"');
    expect(html).toContain('class="date-time-select__part date-time-select__hour"');
    expect(html).toContain('class="date-time-select__separator"');
  });
});
