declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { create?: boolean })
    exec(sql: string): void
    close(): void
  }
}
