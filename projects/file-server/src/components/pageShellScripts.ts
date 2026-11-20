/**
 * Why not attach these handlers from the components that render the forms:
 * htmx swaps the list without re-rendering PageShell, so the document-level
 * listeners are installed once per page instead of once per swapped fragment.
 */
export const inlineFormErrorScript = `
(() => {
  const formEndpoints = new Set(["/api/file", "/api/mkdir", "/api/rename", "/api/move"]);

  const getForm = (detail) => {
    const source = detail?.elt instanceof Element ? detail.elt : null;
    if (!source) {
      return null;
    }
    return source.closest("form");
  };

  const getErrorNode = (form) => form?.querySelector("[data-form-error]") ?? null;

  const clearFormError = (form) => {
    const errorNode = getErrorNode(form);
    if (!errorNode) {
      return;
    }
    errorNode.textContent = "";
    errorNode.classList.add("hidden");
  };

  const showFormError = (form, message) => {
    const errorNode = getErrorNode(form);
    if (!errorNode) {
      return;
    }
    errorNode.textContent = message;
    errorNode.classList.remove("hidden");
  };

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const form = target.closest("form[data-inline-error-form]");
    if (form) {
      clearFormError(form);
    }
  });

  document.addEventListener("htmx:beforeRequest", (event) => {
    const form = getForm(event.detail);
    if (form?.matches("[data-inline-error-form]")) {
      clearFormError(form);
    }
  });

  document.addEventListener("htmx:afterRequest", (event) => {
    const form = getForm(event.detail);
    if (!form?.matches("[data-move-form]")) {
      return;
    }
    if (!event.detail?.successful) {
      return;
    }
    const picker = document.getElementById("move-picker-container");
    if (picker) {
      picker.innerHTML = "";
    }
  });

  document.addEventListener("htmx:responseError", (event) => {
    const form = getForm(event.detail);
    if (!form?.matches("[data-inline-error-form]")) {
      return;
    }

    const xhr = event.detail?.xhr;
    if (!xhr || xhr.status !== 400) {
      return;
    }

    const action =
      form.getAttribute("hx-post") || form.getAttribute("action") || "";
    if (!formEndpoints.has(action)) {
      return;
    }

    try {
      const payload = JSON.parse(xhr.responseText);
      if (typeof payload?.error?.message !== "string") {
        return;
      }
      showFormError(form, payload.error.message);
    } catch {
    }
  });
})();
`
