import { log } from "./logging/index.ts";

interface Config {
  filesPath: string;
  dataPath: string;
  port: number;
  devMode: boolean;
  logLevel: string;
}

function requireEnv(name: string, defaultValue?: string): string {
  const value = process.env[name] || defaultValue;
  if (!value) {
    log.error("Config", `Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function parsePort(value: string): number {
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    log.error("Config", `Invalid PORT: ${value} (must be 1-65535)`);
    process.exit(1);
  }
  return port;
}

function loadConfig(): Config {
  // Internal Bun server port (nginx proxies to this)
  const port = parsePort(process.env.PORT || "3000");

  return {
    filesPath: requireEnv("FILES", "./files"),
    dataPath: requireEnv("DATA", "./data"),
    port,
    devMode: process.env.DEV_MODE === "true",
    logLevel: process.env.LOG_LEVEL || "info",
  };
}

export const config = loadConfig();
