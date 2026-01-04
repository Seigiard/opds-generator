type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(currentLevel);
}

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export const logger = {
  debug(tag: string, message: string, context?: Record<string, unknown>): void {
    if (shouldLog("debug")) {
      const ctx = context ? ` ${JSON.stringify(context)}` : "";
      console.log(`[${formatTimestamp()}] [DEBUG] [${tag}] ${message}${ctx}`);
    }
  },

  info(tag: string, message: string, context?: Record<string, unknown>): void {
    if (shouldLog("info")) {
      const ctx = context ? ` ${JSON.stringify(context)}` : "";
      console.log(`[${formatTimestamp()}] [INFO] [${tag}] ${message}${ctx}`);
    }
  },

  warn(tag: string, message: string, context?: Record<string, unknown>): void {
    if (shouldLog("warn")) {
      const ctx = context ? ` ${JSON.stringify(context)}` : "";
      console.warn(`[${formatTimestamp()}] [WARN] [${tag}] ${message}${ctx}`);
    }
  },

  error(tag: string, message: string, error?: unknown, context?: Record<string, unknown>): void {
    if (shouldLog("error")) {
      const ctx = context ? ` ${JSON.stringify(context)}` : "";
      let errMsg = "";
      if (error instanceof Error) {
        errMsg = `: ${error.message}`;
      } else if (typeof error === "string") {
        errMsg = `: ${error}`;
      } else if (error !== undefined && error !== null) {
        errMsg = `: ${JSON.stringify(error)}`;
      }
      console.error(`[${formatTimestamp()}] [ERROR] [${tag}] ${message}${errMsg}${ctx}`);
    }
  },
};

export function logHandlerError(tag: string, filePath: string, error: unknown): void {
  if (error instanceof Error && error.message.includes("Executable not found")) {
    logger.debug(tag, "External tool not available", { file: filePath, tool: error.message });
    return;
  }

  if (error instanceof Error) {
    logger.error(tag, "Unexpected error", error, { file: filePath });
  } else {
    logger.error(tag, "Unknown error", error, { file: filePath });
  }
}
