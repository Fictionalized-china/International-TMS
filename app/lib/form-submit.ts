export function submitForm(form: HTMLFormElement | null) {
  if (!form) return;

  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return;
  }

  // Older Chromium builds used by some 360 browser releases do not expose
  // requestSubmit. Clicking a temporary submit button preserves validation
  // and submit-event handling, unlike calling form.submit() directly.
  const submitter = document.createElement("button");
  submitter.type = "submit";
  submitter.hidden = true;
  form.appendChild(submitter);
  submitter.click();
  submitter.remove();
}
