#!/usr/bin/env bash
# Generates TypeScript gRPC client stubs and message types from the NebulaGraph
# proto definitions using protoc + ts-proto.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO_DIR="$ROOT_DIR/proto"
OUT_DIR="$ROOT_DIR/src/generated"
TS_PROTO_PLUGIN="$ROOT_DIR/node_modules/.bin/protoc-gen-ts_proto"

if ! command -v protoc >/dev/null 2>&1; then
  echo "error: protoc not found on PATH. Install the Protocol Buffers compiler first." >&2
  exit 1
fi

if [ ! -x "$TS_PROTO_PLUGIN" ]; then
  echo "error: ts-proto plugin not found at $TS_PROTO_PLUGIN. Run 'npm install' first." >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

protoc \
  --plugin=protoc-gen-ts_proto="$TS_PROTO_PLUGIN" \
  --ts_proto_out="$OUT_DIR" \
  --ts_proto_opt=outputServices=grpc-js \
  --ts_proto_opt=outputClientImpl=grpc-js \
  --ts_proto_opt=esModuleInterop=true \
  --ts_proto_opt=env=node \
  --ts_proto_opt=useOptionals=messages \
  --ts_proto_opt=exportCommonSymbols=false \
  --ts_proto_opt=oneof=unions \
  --ts_proto_opt=unrecognizedEnum=false \
  --ts_proto_opt=forceLong=bigint \
  --proto_path="$PROTO_DIR" \
  "$PROTO_DIR/nebula/common.proto" \
  "$PROTO_DIR/nebula/vector.proto" \
  "$PROTO_DIR/nebula/graph.proto"

echo "Generated TypeScript proto bindings in $OUT_DIR"
