### Changed

- The personal fork checks the native account model catalog at service startup
  and every 24 hours instead of every five minutes. The short cache TTL and
  explicit forced refresh remain independent of automatic polling. Failed
  requests continue using the previous cache.
