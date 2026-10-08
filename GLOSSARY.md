# OPDS Generator

Builds an OPDS catalogue and a browser view from a directory of locally stored ebooks, and keeps both in step with that directory.

## Source and representation

**Source tree**:
The files and folders from which the catalogue is built. The service has read-only access; changes can occur while it processes them.

**Derived representation**:
The catalogue and browser view produced from the source tree, including their supporting metadata and images.

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
The scan that runs once when the service starts. If it fails, the service exits with code 1 instead of serving an empty catalogue.

**Reconciliation**:
A periodic scan that repairs drift between the books directory and the catalogue.

**Resync**:
A scan that is requested on demand, by an operator or by the books watcher after it lost events. It repairs the catalogue in place and never clears it first. By default it reprocesses only changed books; a **forced resync** reprocesses every book.
_Avoid_: Full resync, wipe

## Catalogue processing

**Watcher event**:
A raw notice from the books-directory watcher that something changed there. It becomes catalogue work, or nothing.
_Avoid_: Event (alone)

**Catalogue work**:
One unit of work that updates the catalogue, such as processing a book or refreshing a folder's metadata.
_Avoid_: Event, item, task, job

**Pending**:
Catalogue work that was accepted and has not started.

**Active**:
Catalogue work that runs now. At most one piece of catalogue work is active at a time.

**Cascade**:
Catalogue work that a piece of catalogue work produces when it succeeds. Failed work produces no cascade.

**Coalescing**:
A request to refresh a folder's metadata that arrives while the same request is pending adds no new work. The pending request moves behind the work queued after it.
_Avoid_: Dedup, merging

**Watcher dedup**:
A watcher event that repeats one seen less than half a second earlier is dropped. It applies only to watcher events, never to work from a scan.
_Avoid_: Coalescing
