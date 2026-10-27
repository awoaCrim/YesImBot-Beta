# durable-willingness-state Specification

## Status

Retired with the optional first-party `will-policy` package. YesImBot no longer ships the willingness scoring engine or its durable store. This document does not impose a storage contract on Core or third-party Will engines.

Existing `willingness.json` files remain untouched: source retirement does not read, migrate, reset, or delete operator state. Any operational cleanup requires separate approval. Generic optional Will batch/reservation and delivery-confirmation contracts remain in `channel-will-evaluation` and `message-delivery`.
