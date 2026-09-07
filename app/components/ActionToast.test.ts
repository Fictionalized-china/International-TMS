import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionToast } from "./ActionToast";

describe("ActionToast", () => {
  it("renders successful action feedback as a non-layout status notification", () => {
    const markup = renderToStaticMarkup(createElement(ActionToast, { data: { success: "保存成功" } }));
    expect(markup).toContain('class="action-toast success"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("保存成功");
    expect(markup).toContain("关闭提示");
  });

  it("gives errors assertive alert semantics", () => {
    const markup = renderToStaticMarkup(createElement(ActionToast, { data: { formError: "资料不完整" } }));
    expect(markup).toContain('class="action-toast error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
  });

  it("renders nothing when there is no operation feedback", () => {
    expect(renderToStaticMarkup(createElement(ActionToast, { data: {} }))).toBe("");
  });
});
