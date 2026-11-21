export const closePickerScript =
  "document.getElementById('move-picker-container').innerHTML = '';"

interface PickerCrumb {
  label: string
  path: string
}

export function buildPickerBreadcrumbs(
  pickerRoot: string,
  currentDest: string,
): PickerCrumb[] {
  const rootParts = pickerRoot.split("/").filter(Boolean)
  const currentParts = currentDest.split("/").filter(Boolean)
  const rootLabel = rootParts[rootParts.length - 1] ?? pickerRoot
  const crumbs: PickerCrumb[] = [{ label: rootLabel, path: pickerRoot }]

  let acc = pickerRoot
  for (let i = rootParts.length; i < currentParts.length; i++) {
    const part = currentParts[i]
    acc = acc ? `${acc}/${part}` : part
    crumbs.push({ label: part, path: acc })
  }

  return crumbs
}

export function pickerHref(source: string, dest: string): string {
  return `/api/move/picker?source=${encodeURIComponent(source)}&dest=${encodeURIComponent(dest)}`
}

export function isInsideSource(source: string, destination: string): boolean {
  return source === destination || destination.startsWith(`${source}/`)
}
