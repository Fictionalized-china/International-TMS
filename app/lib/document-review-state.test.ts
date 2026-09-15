import { describe, expect, it } from "vitest";
import { documentReviewCloseSignal } from "./document-review-state";

describe("document review modal close signal", () => {
  it("forwards a successful review signal only to the reviewed attachment", () => {
    const signal = "attachment-1:2026-09-05T12:00:00.000Z";

    expect(documentReviewCloseSignal(signal, "attachment-1")).toBe(signal);
    expect(documentReviewCloseSignal(signal, "attachment-2")).toBeUndefined();
  });

  it("ignores missing and unrelated action results", () => {
    expect(documentReviewCloseSignal(undefined, "attachment-1")).toBeUndefined();
    expect(documentReviewCloseSignal({ success: true }, "attachment-1")).toBeUndefined();
  });
});
