# Configuration

| Variable             | Default  | Description                                                                                 |
| -------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `FILES`              | `/books` | Source books directory.                                                                     |
| `DATA`               | `/data`  | Generated metadata cache.                                                                   |
| `PORT`               | `3000`   | Internal Bun server port.                                                                   |
| `LOG_LEVEL`          | `info`   | `debug`, `info`, `warn`, or `error`.                                                        |
| `DEV_MODE`           | `false`  | Enable Bun watch-mode hot reload.                                                           |
| `ADMIN_USER`         | -        | Basic Auth username for `/resync`.                                                          |
| `ADMIN_TOKEN`        | -        | Basic Auth password for `/resync`.                                                          |
| `RATE_LIMIT_MB`      | `0`      | Download rate limit in MB/s. Zero disables it. It also throttles in-browser reader fetches. |
| `RECONCILE_INTERVAL` | `1800`   | Periodic reconciliation seconds. Zero disables it; 60 is the minimum positive value.        |
