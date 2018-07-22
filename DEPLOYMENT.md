# Deployment

**Not deployed anywhere. It is a service, and it runs locally.**

A NestJS service on in-memory adapters by default, so `pnpm dev` needs nothing installed.
The console UI and the production persistence live in `engitrack-platform`.

## Running it

```bash
pnpm install
pnpm dev            # http://localhost:3002
curl localhost:3002/health
```

No database and no Redis. Setting DATABASE_URL and REDIS_URL swaps the store binding;
nothing above the port changes.

## If it were published

It is not published to any registry, and no version has ever been released. Were that to
change, the release would be: tag, CI runs the full verify, `pnpm publish --access public`
behind a manual approval. The versioning tooling in `native-release-lab/tools` derives
the version from git rather than having anyone type it.

## Verification status

| Item | State |
|------|-------|
| Build | Runs, clean |
| Tests | Run, passing: 40 unit and 14 over real HTTP. Output in `docs/test-results/` |
| Published to a registry | Never |
| Deployed | Never. It runs locally and has not been deployed anywhere |
