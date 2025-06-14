export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthenticationError'
    Object.setPrototypeOf(this, AuthenticationError.prototype)
  }
}

interface Auth {
  login(email: string, password: string): Promise<void>
  logout(email: string): Promise<void>
}

export const auth: Auth = {
  async login(email: string, password: string): Promise<void> {
    if (password !== 'test') {
      throw new AuthenticationError('認証に失敗しました')
    }
  },

  async logout(email: string): Promise<void> {
    // TODO
  },
}
