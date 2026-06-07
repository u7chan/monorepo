declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { create?: boolean })
    exec(sql: string): void
    close(): void
  }
}

declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void
  export function test(name: string, fn: () => void | Promise<void>): void
  export function expect(value: unknown): {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: string): void
    toHaveLength(length: number): void
    toBeGreaterThan(value: number): void
    toBeLessThan(value: number): void
    toBeCloseTo(value: number, digits?: number): void
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
  serve(options: { fetch: (request: Request) => Response | Promise<Response>; port?: number }): unknown
}
