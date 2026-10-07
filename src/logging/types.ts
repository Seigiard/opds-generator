export type LogLevel = "debug" | "info" | "warn" | "error";

type EventType =
  | "event_received"
  | "event_ignored"
  | "event_deduplicated"
  | "handler_start"
  | "handler_complete"
  | "handler_error"
  | "cascades_generated";

export interface LogContext {
  // Event context
  event_id?: string;
  event_tag?: string;
  event_type?: EventType;

  // Path context
  path?: string;
  parent?: string;
  name?: string;

  // Handler context
  handler?: string;
  duration_ms?: number;

  // Cascade context
  cascade_count?: number;
  cascade_tags?: string[];

  // Sync context
  books_found?: number;
  books_process?: number;
  books_delete?: number;
  folders_count?: number;

  // Lifecycle context
  from?: string;
  to?: string;
  input?: string;
  scan_kind?: string;
  scan_force?: boolean;
  follow_up?: "none" | "plain" | "forced";
  reason?: string;

  // Result context
  has_cover?: boolean;
  entries_count?: number;
  subfolders?: number;
  books?: number;

  // Error context
  error?: string;
  error_stack?: string;

  // Misc
  file?: string;
  tool?: string;
  port?: number;
  body?: unknown;
  raw_event?: string;
  events_processed?: number;
  heap_used_mb?: number;
  heap_total_mb?: number;
  rss_mb?: number;
  external_mb?: number;
  jsc_object_count?: number;
  jsc_protected_object_count?: number;
  jsc_global_object_count?: number;
  jsc_protected_global_object_count?: number;
}

export interface LogEntry extends LogContext {
  ts: string;
  level: LogLevel;
  tag: string;
  msg: string;
}
