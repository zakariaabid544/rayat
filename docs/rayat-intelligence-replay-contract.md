# Rayat Intelligence Multi-Tenant Replay Contract

Status: architecture contract only. Historical Replay is not implemented by Sprint 2.7A.

## Identity Requirements

Every source event entering a future replay must resolve both identities before any grouping or write:

- `owner_user_id`: canonical customer owner (`COALESCE(users.owner_user_id, users.id)`).
- `device_id`: greenhouse device primary key.
- `sensor_id`: required for Sprint 1 events and must belong to `device_id`.
- `greenhouse_scope`: required on local derived rows and must equal `device_id`.

Fleet rows are the only exception. They must have `owner_user_id`, `device_id`, and `greenhouse_scope` set to `NULL` because fleet output is anonymous aggregation, not a tenant-owned record.

## Failure Conditions

Replay must stop without writing intelligence when:

- owner, device, or sensor identity cannot be resolved;
- a device does not belong to the resolved canonical owner;
- a sensor does not belong to the resolved device;
- one local device or sensor timeline contains more than one owner;
- a local row would use a `NULL` identity or `NULL` grouping key;
- a fleet candidate has fewer than `AGRO_FLEET_MIN_DISTINCT_CUSTOMERS` distinct owners (default `3`);
- a fleet payload contains event IDs, examples, device IDs, or owner IDs.

Partial or best-effort replay is forbidden. The replay transaction must roll back its unit of work on any identity failure.

## Isolation Guarantees

- Pattern, trigger, recovery, and local-learning timelines are grouped by a validated device identity.
- Ownership is checked before aggregation and again on database insert/update.
- Local learning reads only the matching device's local pattern, trigger, and recovery rows.
- Fleet knowledge never mutates a local fingerprint. `agro_learning_delta` is benchmark-only.
- Fleet evidence contains aggregate counts and statistics only.

## Deterministic Keys

Local replay keys must contain a validated owner and device namespace before the domain-specific components:

`<kind>|<owner_user_id>|<device_id>|<domain-parts>`

Existing Sprint 1 and Sprint 2 keys based on globally unique database IDs remain supported for backward compatibility. A future replay implementation must use the tenant-namespaced form for new replay checkpoints and batches. It must never derive a key from a nullable owner, device, gateway label, sensor label, or customer-supplied display name.

Fleet keys may use a constant fleet namespace only after the distinct-owner privacy gate succeeds.

## Fleet Contract

Fleet intelligence is a benchmark, never a decision engine:

- eligibility is based on distinct customer owners, not greenhouse count;
- default minimum is three distinct owners;
- raw supporting event IDs and examples are prohibited;
- only aggregated statistics can cross the fleet boundary;
- local knowledge is written first and remains valid when the fleet benchmark is unavailable.

## Replay Readiness Boundary

Sprint 2.7A provides identity columns, foreign keys, database guards, fail-closed aggregators, privacy sanitization, and this contract. It does not provide a replay cursor, batch runner, checkpoint table, source-window traversal, or replay command.
