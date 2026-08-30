---
"@truefoundry/trueforge-core": patch
---

Fix argument canonicalization for omitted arguments: `JSON.stringify(undefined)` returns `undefined`, which `Hash.update` rejects, crashing `prepareBatch` for a call with no arguments at all instead of producing the intended invalid-arguments terminal response. Missing argument values now canonicalize to a stable `undefined` marker, keeping failed decodes and omitted-argument calls deterministically fingerprintable and comparable.
