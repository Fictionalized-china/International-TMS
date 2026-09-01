import { describe, expect, it } from "vitest";
import {
  parseQuotationWorkflowFieldOptions,
  quotationWorkflowDisplayValue,
  quotationWorkflowFieldHasValue,
  quotationWorkflowFieldInputName,
} from "./quotation-workflow-fields";

describe("quotation workflow fields", () => {
  it("uses the immutable field id as the form key", () => {
    expect(quotationWorkflowFieldInputName("field-123")).toBe("workflowField_field-123");
  });

  it("parses select options with stable values and readable labels", () => {
    expect(parseQuotationWorkflowFieldOptions("a|甲\nb|乙,其他")).toEqual([
      { value: "a", label: "甲" },
      { value: "b", label: "乙" },
      { value: "其他", label: "其他" },
    ]);
  });

  it("treats text and attachments as different required-value sources", () => {
    expect(quotationWorkflowFieldHasValue(
      { field_type: "text" },
      { value_text: "已填写", file_name: null },
    )).toBe(true);
    expect(quotationWorkflowFieldHasValue(
      { field_type: "attachment" },
      { value_text: null, file_name: "委托附件.pdf" },
    )).toBe(true);
    expect(quotationWorkflowFieldHasValue(
      { field_type: "attachment" },
      { value_text: "伪文件值", file_name: null },
    )).toBe(false);
  });

  it("renders stored option values as business labels", () => {
    expect(quotationWorkflowDisplayValue(
      { field_type: "select", options_text: "priority|加急\nnormal|普通" },
      { value_text: "priority", file_name: null },
    )).toBe("加急");
    expect(quotationWorkflowDisplayValue(
      { field_type: "multiselect", options_text: "fragile|易碎\ncold|温控" },
      { value_text: '["fragile","cold"]', file_name: null },
    )).toBe("易碎、温控");
  });
});
