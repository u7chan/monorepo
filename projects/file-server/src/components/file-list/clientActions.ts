/** Toggle one inline form and mirror the pressed state on the two toolbar buttons. */
export const toggleCreateFormScript = (
  formId: string,
  otherFormId: string,
  otherButtonId: string,
) => `
	const form = document.getElementById('${formId}');
	const otherForm = document.getElementById('${otherFormId}');
	const otherButton = document.getElementById('${otherButtonId}');
	const isHidden = form.classList.contains('hidden');
	if (isHidden) {
		form.classList.remove('hidden');
		otherForm.classList.add('hidden');
		this.setAttribute('aria-pressed', 'true');
		otherButton.setAttribute('aria-pressed', 'false');
	} else {
		form.classList.add('hidden');
		this.setAttribute('aria-pressed', 'false');
	}
`

/**
 * Drop feedback is expressed with `data-dragging` so the Tailwind variants that
 * style it stay in the markup instead of being injected as class names here.
 */
export const dropZoneDragOverScript = `
	event.preventDefault();
	event.dataTransfer.dropEffect = 'copy';
	this.setAttribute('data-dragging', 'true');
`

export const dropZoneDragLeaveScript = `
	event.preventDefault();
	this.removeAttribute('data-dragging');
`

export const dropZoneDropScript = `
	event.preventDefault();
	this.removeAttribute('data-dragging');
	const files = event.dataTransfer.files;
	if (files.length > 0) {
		const input = document.getElementById('drop-upload-input');
		const form = document.getElementById('drop-upload-form');
		const dt = new DataTransfer();
		for (let i = 0; i < files.length; i++) {
			dt.items.add(files[i]);
		}
		input.files = dt.files;
		htmx.trigger(form, 'submit');
	}
`

export const openUploadDialogScript =
  "document.getElementById('drop-upload-input').click()"

export const fileInputChangeScript =
  "if (this.files.length > 0) htmx.trigger(document.getElementById('drop-upload-form'), 'submit')"

export const stopPropagationScript = "event.stopPropagation()"

/** Open one row's rename form, closing any other open one. */
export const renameButtonScript = (
  renameFormId: string,
  renameInputId: string,
) => `
	event.stopPropagation();
	const form = document.getElementById('${renameFormId}');
	const input = document.getElementById('${renameInputId}');
	const container = document.getElementById('file-list-container');
	const shouldOpen = form.classList.contains('hidden');
	container.querySelectorAll('[data-rename-form]').forEach((el) => el.classList.add('hidden'));
	container.querySelectorAll('[data-rename-button]').forEach((el) => el.setAttribute('aria-expanded', 'false'));
	if (shouldOpen) {
		form.classList.remove('hidden');
		this.setAttribute('aria-expanded', 'true');
		input.focus();
		input.select();
	}
`

export const closeRenameFormScript = (renameFormId: string) => `
	event.stopPropagation();
	document.getElementById('${renameFormId}').classList.add('hidden');
	document.querySelectorAll('[data-rename-button]').forEach((el) => el.setAttribute('aria-expanded', 'false'));
`
