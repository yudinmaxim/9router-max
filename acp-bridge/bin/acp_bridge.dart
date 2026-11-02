import 'dart:async';
import 'dart:convert';
import 'dart:io';

Future<void> main(List<String> args) async {
  final config = await BridgeConfig.load();
  final url = _arg(args, '--url') ?? config.url;
  final socket = await WebSocket.connect(url);
  var closed = false;

  void close([Object? error]) {
    if (closed) return;
    closed = true;
    if (error != null) stderr.writeln('[bridge] $error');
    stdout.close();
    socket.close();
  }

  socket.listen(
    (message) {
      if (closed) return;
      if (message is String) {
        stdout.writeln(message);
      } else {
        stderr.writeln('[bridge] non-text server frame ignored');
      }
    },
    onError: close,
    onDone: close,
    cancelOnError: true,
  );

  await for (final line
      in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
    if (closed || line.trim().isEmpty) continue;
    try {
      jsonDecode(line);
      socket.add(line);
    } on FormatException catch (error) {
      stderr.writeln('[bridge] invalid JSON from stdin: $error');
    }
  }
  close();
}

class BridgeConfig {
  const BridgeConfig({required this.url});

  final String url;

  static Future<BridgeConfig> load() async {
    final file = File(_configPath());
    if (!await file.exists())
      return const BridgeConfig(url: 'ws://127.0.0.1:20129/api/acp/ws');
    final data = jsonDecode(await file.readAsString());
    if (data is! Map ||
        data['url'] is! String ||
        (data['url'] as String).isEmpty) {
      throw FormatException('Invalid bridge config: ${file.path}');
    }
    return BridgeConfig(url: data['url'] as String);
  }
}

String _configPath() {
  final home = Platform.environment['HOME'];
  if (home == null || home.isEmpty) throw StateError('HOME is not set');
  return '$home/.config/9router/acp-bridge.json';
}

String? _arg(List<String> args, String name) {
  final index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}
