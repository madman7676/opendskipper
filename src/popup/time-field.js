(function initializeTimeField(root) {
  "use strict";

  const { Time } = root.OpenDSkipper;

  function create(input, suffix) {
    let seconds = 0;
    function set(value) {
      seconds = Time.isFiniteMediaTime(value) && value >= 0 ? value : null;
      input.value = seconds === null ? "" : Time.formatTimeInput(seconds);
      const fraction = seconds === null ? 0 : Time.getFractionalSeconds(seconds);
      suffix.textContent = `.${String(Math.floor((fraction + 1e-9) * 1000)).padStart(3, "0")}`;
      input.title = input.value || (seconds === null ? "" : `${seconds} с (понад 24 години)`);
    }
    function acceptNativeEdit() {
      seconds = Time.parseTimeInput(input.value);
      suffix.textContent = ".000";
      input.title = input.value;
    }
    input.addEventListener("input", acceptNativeEdit);
    input.addEventListener("change", acceptNativeEdit);
    return Object.freeze({ set, get: () => seconds });
  }

  function format(seconds) {
    const main = Time.formatTimeInput(seconds);
    if (!main) return `${seconds} с`;
    const fraction = Time.getFractionalSeconds(seconds);
    return `${main} .${String(Math.floor((fraction + 1e-9) * 1000)).padStart(3, "0")}`;
  }

  root.OpenDSkipper.TimeField = Object.freeze({ create, format });
})(globalThis);
