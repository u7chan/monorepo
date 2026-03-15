const formErrorClassName =
	"hidden mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"

export function FormErrorMessage() {
	return (
		<p
			data-form-error
			role="alert"
			aria-live="polite"
			className={formErrorClassName}
		></p>
	)
}
