type SubmitFormOptions = {
  submitter?: HTMLButtonElement | null;
};

export function submitForm(form: HTMLFormElement | null, options: SubmitFormOptions = {}) {
  if (!form) return;

  if (typeof form.requestSubmit === "function") {
    form.requestSubmit(options.submitter ?? undefined);
    return;
  }

  // Older Chromium builds used by some 360 browser releases do not expose
  // requestSubmit. Clicking a temporary submit button preserves validation
  // and submit-event handling, unlike calling form.submit() directly.
  const submitter = options.submitter ?? document.createElement("button");
  const temporary = !options.submitter;
  if (temporary) {
    submitter.type = "submit";
    submitter.hidden = true;
    form.appendChild(submitter);
  }
  submitter.click();
  if (temporary) submitter.remove();
}
