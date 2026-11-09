# Cluster ranking during upgrades

GoodVibes runs a separate election for each inbound consumer surface. Equal
versions prefer fewer existing holdings and then a deterministic 32-bit spread
rank, with the full node ID resolving collisions. This calculation does not
require a cryptographic digest.

Current nodes declare this ranking in the SemVer build metadata of the existing
signed `nodeVersion` field. Release precedence, prerelease ordering, the protocol
version, and the seven authenticated fields are preserved. Product status removes
only GoodVibes' reserved final ranking tag and keeps other build metadata.

An accepted older-style peer selects the deployed v1 ranking for the lifetime of
that election instance. Its precise SHA ordering remains solely to agree with
that real peer. Current nodes advertise their resulting v1 behavior too: without
propagation, three mixed nodes could disagree cyclically about the winner. Scores
for unchanged tuples are cached with a fixed entry bound. Invalid signatures and
datagrams rejected by the existing restart-aware sequence cursor do not change
the ranking mode. A fresh election instance in
an entirely current group uses the noncryptographic rank again.

Surface identifiers retain their existing wire derivation. An ntfy topic can be
a capability, and provider account identifiers should not be sent in plaintext.
Peers must derive the same stable opaque selector to contest the same consumer.
These identifiers are pseudonyms, not encryption or anonymization: predictable
names remain guessable offline, and packet signatures authenticate traffic
without encrypting it.

An election is not a distributed execution lease. Partitions or a predecessor
that fails to stop can overlap consumers; a rank change must therefore preserve
agreement with existing peers rather than assume another global lock prevents
duplicate consumption.

Embedded hosts that use `SurfaceElection` directly own the authenticated receive
and send boundary. Use `clusterRankingWireVersion()` when encoding `nodeVersion`,
report actual v1 compatibility through the host's `ranking` getter, and adopt that
behavior before delivering a v1-style peer message. `ClusterElection` performs
these steps for the built-in consumers.
