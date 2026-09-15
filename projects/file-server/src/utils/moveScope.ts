import type { UserState } from "../types"

export type MoveScope = "public" | "private"

export type CrossScopeMoveError = {
  name: "CrossScope" | "CrossUser" | "InvalidSource"
  message: string
  status: 400 | 403
}

function toParts(virtualPath: string): string[] {
  return virtualPath.split("/").filter(Boolean)
}

export function getMoveScope(virtualPath: string): MoveScope | null {
  const [scope] = toParts(virtualPath)
  if (scope === "public" || scope === "private") {
    return scope
  }
  return null
}

export function isScopeRoot(virtualPath: string): boolean {
  const parts = toParts(virtualPath)
  return parts.length === 1 && (parts[0] === "public" || parts[0] === "private")
}

export function isPrivateHomeRoot(virtualPath: string): boolean {
  const parts = toParts(virtualPath)
  return parts[0] === "private" && parts.length === 2
}

export function isWithinVirtualPath(root: string, virtualPath: string): boolean {
  return virtualPath === root || virtualPath.startsWith(`${root}/`)
}

/**
 * Private subtree a user may cross scopes with.
 * Auth disabled (anonymous) has no user boundary, so the whole private tree is allowed.
 */
export function getCrossScopePrivateRoot(user: UserState): string {
  return user.type === "authenticated" ? `private/${user.username}` : "private"
}

/**
 * Validates a move that crosses the public/private boundary.
 * Returns null when the move does not cross scopes, or when it is allowed.
 */
export function checkCrossScopeMove(
  user: UserState,
  source: string,
  destination: string,
): CrossScopeMoveError | null {
  const sourceScope = getMoveScope(source)
  const destinationScope = getMoveScope(destination)

  if (sourceScope === destinationScope) {
    return null
  }

  if (!sourceScope || !destinationScope) {
    return {
      name: "CrossScope",
      message: "Cannot move across public and private scopes",
      status: 400,
    }
  }

  // Relaxing the scope boundary must not allow moving a whole scope tree.
  if (isScopeRoot(source) || isPrivateHomeRoot(source)) {
    return {
      name: "InvalidSource",
      message: "Scope roots and home directories cannot be moved across scopes",
      status: 400,
    }
  }

  const privateSide = sourceScope === "private" ? source : destination
  if (!isWithinVirtualPath(getCrossScopePrivateRoot(user), privateSide)) {
    return {
      name: "CrossUser",
      message: "Cannot move across user boundaries",
      status: 403,
    }
  }

  return null
}

/**
 * Destination roots selectable in the move picker for the given source.
 * The first entry is the fallback root used when a destination is clamped.
 */
export function getMovePickerRoots(user: UserState, source: string): string[] {
  const privateRoot = getCrossScopePrivateRoot(user)

  if (getMoveScope(source) === "private") {
    // Admin moving another user's entries stays inside the private tree.
    if (
      user.type === "authenticated" &&
      user.role === "admin" &&
      !isWithinVirtualPath(privateRoot, source)
    ) {
      return ["private"]
    }
    return [privateRoot, "public"]
  }

  return ["public", privateRoot]
}
