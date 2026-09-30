- Personal v0.6.0-r2 backports the upstream five-minute native account catalog
  refresh while retaining the per-model protocol, Responses reasoning, GLM
  generation-safety, and current CUA customizations. Codex still reloads its
  model catalog on application startup. The watcher is disposed on shutdown,
  does not keep the supervisor alive, and shares its startup and periodic
  refresh guard. Regression tests cover failure recovery, shutdown and overlap.
