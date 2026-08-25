# apple-mail-ai

On-device **Apple Intelligence** helper for `apple-mail-mcp` (no IMAP, no cloud).

Uses the Foundation Models framework (`SystemLanguageModel`) to name inbox clusters and classify mail actions.

## Requirements

- macOS 26+ with Apple Intelligence available
- Xcode 26/27 toolchain (`DEVELOPER_DIR` may point at `Xcode-beta.app`)

## Build

```bash
# from repo root
pnpm build:ai
# → build/apple-mail-ai
```

Or:

```bash
cd swift-helper && ./build.sh
```

## CLI

```bash
./build/apple-mail-ai status
echo '[{"id":"substack.com","domain":"substack.com","count":3,"subjects":["Weekly"]}]' \
  | ./build/apple-mail-ai name-clusters
```

## Integration

`src/services/appleMailAi.ts` spawns this binary for filter naming (preferred over xAI).

Env:

| Variable | Meaning |
|----------|---------|
| `APPLE_MAIL_MCP_AI_HELPER` | Override binary path |
| `APPLE_MAIL_MCP_FORCE_CLOUD_LLM=1` | Skip Apple AI, use cloud LLM |
| `APPLE_MAIL_AI_MAX_CLUSTERS` | Cap for name-clusters (default 24) |
