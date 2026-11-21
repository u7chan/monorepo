import type { UserConfig } from "../../types"
import { MASTER_ADMIN_USERNAME } from "../../utils/auth"
import {
  compactDangerButtonClassName,
  compactSecondaryButtonClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from "../buttonStyles"
import {
  alertErrorClassName,
  alertSuccessClassName,
  compactFieldClassName,
  fieldClassName,
  labelClassName,
  sectionClassName,
  sectionTitleClassName,
} from "../uiStyles"

interface AdminUsersPageProps {
  users: UserConfig[]
  currentUsername: string
  error?: string
  success?: string
}

export function AdminUsersPage({
  users,
  currentUsername,
  error,
  success,
}: AdminUsersPageProps) {
  return (
    <div className="space-y-8 pb-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">
          User Management
        </h2>
        <a href="/" className={secondaryButtonClassName}>
          ← Back
        </a>
      </div>

      {error && <div className={alertErrorClassName}>{error}</div>}
      {success && <div className={alertSuccessClassName}>{success}</div>}

      <section className={sectionClassName}>
        <h3 className={`mb-3 ${sectionTitleClassName}`}>Change My Password</h3>
        <form
          action="/admin/change-password"
          method="post"
          className="flex flex-wrap items-end gap-3"
        >
          <div className="min-w-36 max-w-sm flex-1">
            <label for="change-current-password" className={labelClassName}>
              Current password
            </label>
            <input
              id="change-current-password"
              name="currentPassword"
              type="password"
              required
              className={fieldClassName}
            />
          </div>
          <div className="min-w-36 max-w-sm flex-1">
            <label for="change-new-password" className={labelClassName}>
              New password
            </label>
            <input
              id="change-new-password"
              name="newPassword"
              type="password"
              required
              className={fieldClassName}
            />
          </div>
          <button type="submit" className={primaryButtonClassName}>
            Change
          </button>
        </form>
      </section>

      <section className={sectionClassName}>
        <h3 className={`mb-3 ${sectionTitleClassName}`}>Users</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
                <th className="pr-4 pb-2">Username</th>
                <th className="pr-4 pb-2">Role</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((user) => (
                <tr key={user.username}>
                  <td className="py-3 pr-4 font-medium text-slate-800">
                    {user.username}
                    {user.username === currentUsername && (
                      <span className="ml-2 text-xs text-slate-400">(you)</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-slate-600">{user.role}</td>
                  <td className="py-3">
                    {user.username === MASTER_ADMIN_USERNAME ? (
                      <span className="text-xs text-slate-400">Protected</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <form
                          action={`/admin/users/${user.username}/role`}
                          method="post"
                          className="flex items-center gap-2"
                        >
                          <select
                            name="role"
                            aria-label={`Role for ${user.username}`}
                            className={compactFieldClassName}
                          >
                            <option
                              value="user"
                              selected={user.role === "user"}
                            >
                              user
                            </option>
                            <option
                              value="admin"
                              selected={user.role === "admin"}
                            >
                              admin
                            </option>
                          </select>
                          <button
                            type="submit"
                            className={compactSecondaryButtonClassName}
                          >
                            Change Role
                          </button>
                        </form>
                        {user.username !== currentUsername && (
                          <form
                            action={`/admin/users/${user.username}/password`}
                            method="post"
                            className="flex items-center gap-2"
                          >
                            <input
                              name="newPassword"
                              type="password"
                              required
                              placeholder="New password"
                              aria-label={`New password for ${user.username}`}
                              className={compactFieldClassName}
                            />
                            <button
                              type="submit"
                              className={compactSecondaryButtonClassName}
                            >
                              Reset PW
                            </button>
                          </form>
                        )}
                        <form
                          action={`/admin/users/${user.username}/delete`}
                          method="post"
                        >
                          <button
                            type="submit"
                            className={compactDangerButtonClassName}
                          >
                            Delete
                          </button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={sectionClassName}>
        <h3 className={`mb-3 ${sectionTitleClassName}`}>Create User</h3>
        <form
          action="/admin/users"
          method="post"
          className="flex flex-wrap items-end gap-3"
        >
          <div className="min-w-32 max-w-sm flex-1">
            <label for="create-username" className={labelClassName}>
              Username
            </label>
            <input
              id="create-username"
              name="username"
              type="text"
              required
              className={fieldClassName}
            />
          </div>
          <div className="min-w-32 max-w-sm flex-1">
            <label for="create-password" className={labelClassName}>
              Password
            </label>
            <input
              id="create-password"
              name="password"
              type="password"
              required
              className={fieldClassName}
            />
          </div>
          <div>
            <label for="create-role" className={labelClassName}>
              Role
            </label>
            <select id="create-role" name="role" className={fieldClassName}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button type="submit" className={primaryButtonClassName}>
            Create User
          </button>
        </form>
      </section>
    </div>
  )
}
