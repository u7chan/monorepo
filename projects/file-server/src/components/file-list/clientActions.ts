const ACTIVE_TOGGLE_CLASSES =
	"'ring-2', 'ring-purple-400', 'bg-purple-50', 'border-purple-300', 'text-purple-700'"

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
		this.classList.add(${ACTIVE_TOGGLE_CLASSES});
		otherButton.classList.remove(${ACTIVE_TOGGLE_CLASSES});
	} else {
		form.classList.add('hidden');
		this.classList.remove(${ACTIVE_TOGGLE_CLASSES});
	}
`

export const dropZoneDragOverScript = `
	event.preventDefault();
	event.dataTransfer.dropEffect = 'copy';
	this.classList.add('border-purple-500', 'bg-purple-50');
`

export const dropZoneDragLeaveScript = `
	event.preventDefault();
	this.classList.remove('border-purple-500', 'bg-purple-50');
`

export const dropZoneDropScript = `
	event.preventDefault();
	this.classList.remove('border-purple-500', 'bg-purple-50');
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

export const stopPropagationScript = "event.stopPropagation()"

export const renameButtonScript = (renameFormId: string, renameInputId: string) => `
	event.stopPropagation();
	const form = document.getElementById('${renameFormId}');
	const input = document.getElementById('${renameInputId}');
	const container = document.getElementById('file-list-container');
	const shouldOpen = form.classList.contains('hidden');
	container.querySelectorAll('[data-rename-form]').forEach((el) => el.classList.add('hidden'));
	container.querySelectorAll('[data-rename-button]').forEach((el) => el.classList.remove(${ACTIVE_TOGGLE_CLASSES}));
	if (shouldOpen) {
		form.classList.remove('hidden');
		this.classList.add(${ACTIVE_TOGGLE_CLASSES});
		input.focus();
		input.select();
	}
`

export const closeRenameFormScript = (renameFormId: string) => `
	event.stopPropagation();
	document.getElementById('${renameFormId}').classList.add('hidden');
	document.querySelectorAll('[data-rename-button]').forEach((el) => el.classList.remove(${ACTIVE_TOGGLE_CLASSES}));
`
