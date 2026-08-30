---
"@truefoundry/trueforge-core": minor
"@truefoundry/trueforge": minor
---

Add generic, host-driven output verification and typed execution evidence.

Introduce a Zod-owned `VerificationCoordinator` (`core/mcp/evidence`) wired into `ToolExecutionCoordinator` finalization. Verification is driven entirely by host-owned `ToolCapability.output_schema` and `ToolCapability.evidence_capabilities`; server prose is never treated as execution evidence.

For a nominally successful `CallTool` result whose capability declares a non-null `output_schema`, the coordinator now requires canonical MCP `structuredContent` (a JSON object) and validates it with the existing bounded, dependency-free, non-throwing JSON-schema engine generalized for output values. Missing structured content or a known schema violation rewrites the outcome into a `failed` normalized outcome with failure class `validation`, a bounded structured error (code `missing_structured_content` or `output_schema_validation_failed` plus capped `violations`/`truncated`), no retry, and zero evidence. Valid structured output produces one bounded typed `EvidenceRecord` per declared evidence capability containing only a deterministic id/digest, the declared evidence capability, immutable invocation/attempt source identity, a schema digest and result digest, and `observed_at` — never raw output, arguments, or secrets. The record id and digests are pure functions of canonicalized inputs (independent of `observed_at`), so evidence is deterministic and reconstructable across store round-trip and lifecycle replay.

Outcomes with no declared output schema stay backward-compatible and yield zero typed evidence even when `evidence_capabilities` are declared — evidence capabilities alone never mint evidence. Required actions, transport/preflight errors, cancellations (before and after dispatch), unknown/terminal invocations, returned MCP domain errors, and prose-only "successes" all carry empty evidence.

Add `evidence: EvidenceRecord[]` to every `ToolExecutionOutcome` and persist it additively on `tool.attempt_completed` lifecycle events with a Zod-owned `optional().default([])` migration, so legacy events without the field parse to an empty evidence array and evidence survives store round-trip and replay. Export `VerificationCoordinator`, `DEFAULT_VERIFICATION_COORDINATOR`, `EvidenceRecordSchema`, `EvidenceSourceIdentitySchema`, `OutputVerificationErrorSchema`, `EVIDENCE_RECORD_VERSION`, and the `EvidenceRecord`/`EvidenceSourceIdentity`/`OutputVerificationError`/`VerificationResult` types from `@truefoundry/trueforge-core/core`.
