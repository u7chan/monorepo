declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { create?: boolean })
    exec(sql: string): void
    close(): void
  }
}

declare module 'bun' {
  function $(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): {
    quiet(): { nothrow(): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> }
    nothrow(): { quiet(): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> }
  }
}

interface BunSpawnOptions {
  stdout?: 'pipe'
  stderr?: 'pipe'
}

interface BunSubprocess {
  stdout: { getReader(): ReadableStreamDefaultReader<Uint8Array> }
  stderr: { getReader(): ReadableStreamDefaultReader<Uint8Array> }
  kill(): void
  exited: Promise<number>
  readonly exitCode: number | null
}

declare var Bun: {
  spawn(cmd: string[], options?: BunSpawnOptions): BunSubprocess
}
