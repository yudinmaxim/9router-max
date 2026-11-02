# 9router ACP bridge

Stdio ACP bridge for Zed. It connects to the WebSocket ACP endpoint on exp 9router `20129`. Reads router connection settings from:

```text
~/.config/9router/acp-bridge.json
```

Example:

```json
{
  "url": "ws://127.0.0.1:20129/api/acp/ws"
}
```

Override config URL for one run:

```bash
9router-acp-bridge --url ws://127.0.0.1:20129/api/acp/ws
```

Build:

```bash
dart format bin/acp_bridge.dart
dart analyze
dart compile exe bin/acp_bridge.dart -o dist/9router-acp-bridge
```
