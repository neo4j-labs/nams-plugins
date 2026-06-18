# TODO

- [ ] Interate the opencode walking skeleton scaffold - and eliminate unnecesarry constraints when adding a new platform to the hooks. Adding opencode required quite a few changes that didn't seem required (based on this PR https://github.com/kubamarchwicki/nams-hooks/pull/5)
- [x] Additional header identifing a platform for platform diagnostics and statistics
- [ ] Redacting logs
- [ ] Implement `NAMS_LOG_LEVEL` to skip logging HTTP calls, requests, and responses or limit the verbosity
- [x] Refine README. Add platform installation process and clearly separate development installation from platform (codex, gemini) instalation
- [x] Prepare consistent deployment pipeline, for one-click installation on various platforms (build to master branch, gemini tags references, npm registry installation)
- [x] Prepare `.nams/.env` configuration flow - to make environment variables configuration first class configuration over manual configuration.
- [ ] Integration test with isolated real platforms (to verify completness and corecctness of hooks)
- [x] Use @neo4j-labs/agent-memory library as project dependency
- [x] Use metadata conversation request attribute to store additional agent information
