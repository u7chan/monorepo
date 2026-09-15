import { alertErrorClassName } from "../uiStyles"

export function FormErrorMessage() {
  return (
    <p
      data-form-error
      role="alert"
      aria-live="polite"
      className={`hidden mt-3 ${alertErrorClassName}`}
    ></p>
  )
}
