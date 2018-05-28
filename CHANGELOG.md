# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is
[semantic](https://semver.org/).

## [Unreleased]

### Planned
- Contract tests running the same suite against a Postgres-backed sequence allocator
- A fairness policy, so repeated claim-and-release cannot monopolise an incident

## [0.1.0] - 2026-03

### Added
- Event stream: sequence ordering, gap buffering, duplicate suppression, bounded buffer with
  a refetch signal
- Resume-point calculation from the highest applied sequence
- Claim leases with self-expiry, renewal and holder-only release
- Optimistic concurrency guard combining version and lease
- Operator-facing explanations for every refusal, as sentences rather than error codes

### Fixed during development
- A message test asserted the output contained no hyphen, as a proxy for the countdown never
  being negative. The operator identifier contains a hyphen, so it failed against correct
  code. The assertion now reads the countdown value. The test was wrong, not the code

### Verification

40 tests, executed, passing. Lint and type-check clean. No external services required.
Recorded output in `docs/test-results/`.
