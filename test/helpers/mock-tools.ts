import { spyOn, type Mock } from "bun:test";
import { writeFileSync, writeSync } from "node:fs";

type SpawnResult = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  exitCode: number | null;
  kill: () => void;
  pid: number;
};

type CommandOutcome = Error | { readonly exitCode: number; readonly stdout?: string };

type DjvusedScript = "print-meta" | "n";

interface MockConfig {
  djvused?: Partial<Record<DjvusedScript, CommandOutcome>>;
  ddjvu?: Error | { readonly exitCode: number; readonly tiff?: string };
  pdfinfo?: string;
  pdftoppm?: Buffer | Error | "hang" | { readonly exitCode: number };
  magick?: boolean;
}

let spawnSpy: Mock<typeof Bun.spawn> | null = null;

let mockConfig: MockConfig = {};

function createReadableStream(data: string | Buffer): ReadableStream<Uint8Array> {
  const bytes = Buffer.isBuffer(data) ? new Uint8Array(data) : new TextEncoder().encode(data);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function writeStdoutOption(options: any, data: string | Buffer): void {
  if (!Number.isInteger(options?.stdout)) return;

  writeSync(options.stdout, Buffer.isBuffer(data) ? data : Buffer.from(data));
}

function createEmptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function createMockSpawnResult(stdout: string | Buffer, exitCode = 0): SpawnResult {
  return {
    stdout: createReadableStream(stdout),
    stderr: createEmptyStream(),
    exited: Promise.resolve(exitCode),
    exitCode,
    kill: () => {},
    pid: 12345,
  };
}

function createHangingSpawnResult(): SpawnResult {
  let finish!: (exitCode: number) => void;

  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });

  return {
    stdout: createEmptyStream(),
    stderr: createEmptyStream(),
    exited,
    exitCode: null,
    kill: () => finish(143),
    pid: 12345,
  };
}

export function mockPdfInfo(output: string): void {
  mockConfig.pdfinfo = output;
  setupSpawnSpy();
}

export function mockPdfToPpm(imageBuffer: Buffer): void {
  mockConfig.pdftoppm = imageBuffer;
  setupSpawnSpy();
}

export function mockPdfToPpmSpawnFailure(error: Error): void {
  mockConfig.pdftoppm = error;
  setupSpawnSpy();
}

export function mockPdfToPpmExit(exitCode: number): void {
  mockConfig.pdftoppm = { exitCode };
  setupSpawnSpy();
}

export function mockPdfToPpmHangUntilKilled(): void {
  mockConfig.pdftoppm = "hang";
  setupSpawnSpy();
}

export function mockDjvused(script: DjvusedScript, outcome: CommandOutcome): void {
  mockConfig.djvused = { ...mockConfig.djvused, [script]: outcome };
  setupSpawnSpy();
}

/** `tiff` is written to the output path ddjvu was given, so a later reader sees that content. */
export function mockDdjvu(outcome: Error | { readonly exitCode: number; readonly tiff?: string }): void {
  mockConfig.ddjvu = outcome;
  setupSpawnSpy();
}

export function mockImageMagick(success: boolean): void {
  mockConfig.magick = success;
  setupSpawnSpy();
}

function setupSpawnSpy(): void {
  if (spawnSpy) return;

  const originalSpawn = Bun.spawn.bind(Bun);

  spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any, options?: any) => {
    const cmdArray = Array.isArray(cmd) ? cmd : [cmd];
    const command = cmdArray[0];

    // SAFETY: an unknown djvused script reads as undefined in the outcome map and falls through to the real command.
    const djvusedOutcome = command === "djvused" ? mockConfig.djvused?.[cmdArray[3] as DjvusedScript] : undefined;

    if (djvusedOutcome !== undefined) {
      if (djvusedOutcome instanceof Error) throw djvusedOutcome;

      writeStdoutOption(options, djvusedOutcome.stdout ?? "");

      // SAFETY: this fake supplies the stdout/exited/kill fields consumed by process tests only.
      return createMockSpawnResult(djvusedOutcome.stdout ?? "", djvusedOutcome.exitCode) as any;
    }

    if (command === "ddjvu" && mockConfig.ddjvu !== undefined) {
      if (mockConfig.ddjvu instanceof Error) throw mockConfig.ddjvu;

      if (mockConfig.ddjvu.tiff !== undefined) writeFileSync(cmdArray[4], mockConfig.ddjvu.tiff);

      // SAFETY: this fake supplies the stdout/exited/kill fields consumed by process tests only.
      return createMockSpawnResult("", mockConfig.ddjvu.exitCode) as any;
    }

    if (command === "pdfinfo" && mockConfig.pdfinfo !== undefined) {
      writeStdoutOption(options, mockConfig.pdfinfo);

      // SAFETY: this fake supplies the stdout/exited/kill fields consumed by process tests only.
      return createMockSpawnResult(mockConfig.pdfinfo) as any;
    }

    if (command === "pdftoppm" && mockConfig.pdftoppm !== undefined) {
      if (mockConfig.pdftoppm instanceof Error) throw mockConfig.pdftoppm;

      if (mockConfig.pdftoppm === "hang") {
        // SAFETY: this fake supplies the stdout/exited/kill fields consumed by process tests only.
        return createHangingSpawnResult() as any;
      }

      if (!Buffer.isBuffer(mockConfig.pdftoppm)) {
        // SAFETY: this fake supplies the stdout/exited/kill fields consumed by process tests only.
        return createMockSpawnResult("", mockConfig.pdftoppm.exitCode) as any;
      }

      writeStdoutOption(options, mockConfig.pdftoppm);

      // SAFETY: this fake supplies the stdout/exited/kill fields consumed by process tests only.
      return createMockSpawnResult(mockConfig.pdftoppm) as any;
    }

    if (command === "magick" && mockConfig.magick !== undefined) {
      // SAFETY: this fake supplies the stdout/exited/kill fields consumed by process tests only.
      return createMockSpawnResult("", mockConfig.magick ? 0 : 1) as any;
    }

    return originalSpawn(cmdArray, options);
  });
}

export function resetMocks(): void {
  if (spawnSpy) {
    spawnSpy.mockRestore();
    spawnSpy = null;
  }

  mockConfig = {};
}

export function getMockCalls(): string[][] {
  if (!spawnSpy) return [];

  return spawnSpy.mock.calls.map((call) => {
    const cmd = call[0];

    return Array.isArray(cmd) ? cmd : [cmd];
  });
}
