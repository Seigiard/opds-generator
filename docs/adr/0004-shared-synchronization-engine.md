---
status: accepted
---

# Share a synchronization engine across the three applications

OPDS Generator, OPML Generator and TTRPG Map Viewer each maintain a derived representation of a read-only source tree. We decided to extract a shared synchronization engine into a separate repository and distribute it as a versioned npm library. The goal is to fix a shared synchronization mechanism once and deliver that fix to all three applications through dependency updates.

The engine and application handlers use Effect 4. The engine owns scanning, work scheduling, dependency completion, reconciliation and shutdown. Applications define source meaning, processing, rendering and publication requirements. Each application keeps its own process and Docker image. Bun on Linux/Docker is the supported runtime.

The [shared synchronization contract](../plans/shared-synchronization-engine.md) defines the agreed behavior and migration order. This decision is accepted. OPDS Generator, TTRPG Map Viewer and OPML Generator have adopted the released package. The engine owns the shared synchronization responsibilities in all three applications; domain processing and publication remain application code.

## Considered options

- **Shared utility functions:** remove some duplication but leave scheduling, recovery and shutdown in three implementations. This does not meet the maintenance goal.
- **Preserve every existing behavior:** requires several synchronization policies inside one library. Instead, we agreed to converge on the shared contract and change application behavior where needed.
- **Shared engine:** selected despite the migration cost. Applications retain domain behavior while the engine owns the common execution rules.

## Consequences

- All three applications adopted the engine in the planned order: OPDS, TTRPG, then OPML. Scenarios from all three informed the interface.
- OPML handlers moved to Effect 4. Its destructive resync changed to repair in place.
- Fix delivery requires a package release and a verified dependency update in each application.
- ADR 0001's repair-in-place decision and ADR 0002's explicit cascade completion remain constraints on the extraction.
- Adoption in OPDS replaced ADR 0003's restriction that lifecycle execution stays plain async: an Effect scope owns the OPDS lifecycle, and a thin Promise adapter serves HTTP and the process. ADR 0003's Effect processing and resource-ownership decisions remain applicable to OPDS handlers.
