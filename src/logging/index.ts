import type { LogLevel, LogEntry, LogContext } from "./types.ts";
import * as v from "valibot";

const LOG_LEVELS = ["debug", "info", "warn", "error"];

const currentLevel = process.env.LOG_LEVEL || "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(currentLevel);
}

function emit(entry: LogEntry): void {
  const output = JSON.stringify(entry);

  if (entry.level === "error" || entry.level === "warn") {
    console.error(output);
  } else {
    console.log(output);
  }
}

export const log = {
  debug(tag: string, msg: string, ctx?: LogContext): void {
    if (!shouldLog("debug")) return;
    emit({ ts: new Date().toISOString(), level: "debug", tag, msg, ...ctx });
  },

  info(tag: string, msg: string, ctx?: LogContext): void {
    if (!shouldLog("info")) return;
    emit({ ts: new Date().toISOString(), level: "info", tag, msg, ...ctx });
  },

  warn(tag: string, msg: string, ctx?: LogContext): void {
    if (!shouldLog("warn")) return;
    emit({ ts: new Date().toISOString(), level: "warn", tag, msg, ...ctx });
  },

  error(tag: string, msg: string, cause?: unknown, ctx?: LogContext): void {
    if (!shouldLog("error")) return;

    const errorCtx: LogContext = { ...ctx };

    if (cause instanceof Error) {
      errorCtx.error = cause.message;
      errorCtx.error_stack = cause.stack;
    } else if (v.is(v.string(), cause)) {
      errorCtx.error = cause;
    } else if (cause !== undefined && cause !== null) {
      errorCtx.error = JSON.stringify(cause);
    }

    emit({ ts: new Date().toISOString(), level: "error", tag, msg, ...errorCtx });
  },
};

export function logHandlerError(tag: string, filePath: string, cause: unknown): void {
  if (cause instanceof Error && cause.message.includes("Executable not found")) {
    log.debug(tag, "External tool not available", { file: filePath, tool: cause.message });

    return;
  }

  log.error(tag, "Handler failed", cause, { file: filePath });
}
