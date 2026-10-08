# OPDS Generator

Builds an OPDS catalogue and a browser view from a directory of locally stored ebooks, and keeps both in step with that directory.

## Source and representation

**Source tree**:
The files and folders from which the catalogue is built. The service has read-only access; changes can occur while it processes them.

**Derived representation**:
The catalogue and browser view produced from the source tree, including their supporting metadata and images.

## Sync lifecycle

The shared synchronization engine owns the lifecycle. These terms are the independent facts `GET /status` reports.

**Minimum**:
The root feed and root browser page. A deployment is usable once both exist.
_Avoid_: Seed feed

**Available**:
A usable minimum is in the catalogue: it existed before this run (**prior output**) or this run published it. Deployment health means available. It does not wait for verification.
_Avoid_: Ready

**Verifying**:
The first pass is running, or a pass is active or pending. A catalogue can be available and verifying at once.
_Avoid_: Syncing, busy

**Completed**:
Required work has drained and nothing is verifying. Retained failures can remain beside a completed catalogue.
_Avoid_: Done, idle, settled

**Retained error**:
A typed failure the engine keeps after its pass: a book or folder whose previous result stays in place, or a failed pass. A source read failure is a retained error, never a deletion.

**Stopping**:
The service has received a stop signal and takes no new work.
_Avoid_: Shutting down

**Initial sync**:
The first pass when the service starts. If it fails and no minimum is available, the service exits with code 1 instead of serving an empty catalogue. If a minimum is available, the service keeps serving it and retries.

**Reconciliation**:
A periodic pass that repairs drift between the books directory and the catalogue.

**Resync**:
A pass requested on demand, by an operator or by the books watcher after it lost events. It repairs the catalogue in place and never clears it first. By default freshness reprocesses only changed books; a **forced resync** reprocesses every book.
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
A watcher notice is never dropped for repeating an earlier one. The engine retains it as a hint and combines hints in the next pass.
