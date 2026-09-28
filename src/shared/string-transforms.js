(function initializeStringTransforms(root) {
  "use strict";

  const POSITION = Object.freeze({ START: "start", END: "end", ANYWHERE: "anywhere" });
  const TYPE = Object.freeze({
    TRUNCATE_AFTER: "truncateAfter",
    TRUNCATE_AFTER_LAST: "truncateAfterLast",
    REMOVE_EXACT: "removeExact",
    REPLACE_EXACT: "replaceExact",
    TAKE_AFTER_FIRST: "takeAfterFirst",
    TAKE_AFTER_LAST: "takeAfterLast",
    LAST_NON_EMPTY_PART: "lastNonEmptyPart",
    QUERY_PARAMETER: "queryParameter"
  });

  function apply(value, transform) {
    if (typeof value !== "string" || !transform || typeof transform.value !== "string" ||
        transform.value.length === 0) return value;
    const needle = transform.value;
    if (transform.type === TYPE.TRUNCATE_AFTER || transform.type === TYPE.TRUNCATE_AFTER_LAST) {
      const index = transform.type === TYPE.TRUNCATE_AFTER
        ? value.indexOf(needle) : value.lastIndexOf(needle);
      return index === -1 ? value : value.slice(0, index);
    }
    if (transform.type === TYPE.LAST_NON_EMPTY_PART) {
      return value.split(needle).filter((part) => part.length > 0).at(-1) || "";
    }
    if (transform.type === TYPE.TAKE_AFTER_FIRST || transform.type === TYPE.TAKE_AFTER_LAST) {
      const index = transform.type === TYPE.TAKE_AFTER_FIRST
        ? value.indexOf(needle) : value.lastIndexOf(needle);
      return index === -1 ? "" : value.slice(index + needle.length);
    }
    if (transform.type === TYPE.QUERY_PARAMETER) {
      try { return new URL(value).searchParams.get(needle) || ""; }
      catch { return ""; }
    }
    if (transform.type !== TYPE.REMOVE_EXACT && transform.type !== TYPE.REPLACE_EXACT) return value;
    const replacement = transform.type === TYPE.REPLACE_EXACT
      ? (typeof transform.replacement === "string" ? transform.replacement : "") : "";
    if (transform.position === POSITION.START) {
      return value.startsWith(needle) ? replacement + value.slice(needle.length) : value;
    }
    if (transform.position === POSITION.END) {
      return value.endsWith(needle) ? value.slice(0, -needle.length) + replacement : value;
    }
    if (transform.position === POSITION.ANYWHERE) return value.split(needle).join(replacement);
    return value;
  }

  function applyAll(value, transforms) {
    return Array.isArray(transforms)
      ? transforms.reduce((current, transform) => apply(current, transform), value) : value;
  }

  root.OpenDSkipper.StringTransforms = Object.freeze({ TYPE, POSITION, apply, applyAll });
})(globalThis);
