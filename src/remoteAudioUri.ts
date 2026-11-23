import * as vscode from "vscode";

const REMOTE_AUDIO_SCHEME = "audiolens-remote";

export function createRemoteAudioUri(address: string): vscode.Uri {
  // VS Code 解析 URI 时会解码各部分。把原始 URL 整体放进 query，签名 URL 的百分号编码
  // 才能逐字节保留，编辑器序列化后恢复也不变。
  return vscode.Uri.from({
    scheme: REMOTE_AUDIO_SCHEME,
    path: vscode.Uri.parse(address).path,
    query: encodeURIComponent(address)
  });
}

export function getRemoteAudioUrl(uri: vscode.Uri): string | undefined {
  if (uri.scheme === REMOTE_AUDIO_SCHEME) return decodeURIComponent(uri.query);
  return undefined;
}
