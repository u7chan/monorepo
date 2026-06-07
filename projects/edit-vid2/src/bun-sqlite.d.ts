declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { create?: boolean })
    exec(sql: string): void
    close(): void
  }
}

declare module 'bun' {
  export function $(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): {
    quiet(): { nothrow(): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> }
    nothrow(): { quiet(): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> }
  }
}
