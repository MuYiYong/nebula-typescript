# Proto Definitions

These `.proto` files are copied verbatim from the official
[nebula-go](https://github.com/vesoft-inc/nebula-go/tree/release-5.3) SDK
(`proto/nebula/{common,graph,vector}.proto`, protocol version `5.0.0`),
which defines the wire contract shared by all NebulaGraph 5.x client SDKs
(Go / Python / Java / this TypeScript SDK).

Do not hand-edit these files. If the upstream protocol changes, re-sync from
the reference repository and regenerate (`npm run proto:gen`).

Original copyright: Copyright (c) 2025 vesoft inc. All rights reserved.
Licensed under the Apache License, Version 2.0.
