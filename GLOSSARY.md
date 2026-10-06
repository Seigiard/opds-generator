# OPDS Generator

Builds an OPDS catalogue and a browser view from a directory of locally stored ebooks, and keeps both in step with that directory.

## Sync lifecycle

**Accepting**:
The service takes in watcher events and resync requests; catalogue work can run.
_Avoid_: Ready

**Scanning**:
A full comparison of the books directory with the catalogue is running and its work is not yet queued.
_Avoid_: Syncing, busy

**Settled**:
No scan is running, no catalogue work is pending, and no catalogue work is active. Only a Settled catalogue is complete.
_Avoid_: Done, idle, complete

**Stopping**:
The service has received a stop signal and takes no new work.
_Avoid_: Shutting down

**Initial sync**:
The scan that runs once when the service starts.

**Reconciliation**:
A periodic scan that repairs drift between the books directory and the catalogue.

**Resync**:
A scan that is requested on demand, by an operator or by the books watcher after it lost events. It repairs the catalogue in place and never clears it first. By default it reprocesses only changed books; a **forced resync** reprocesses every book.
_Avoid_: Full resync, wipe
