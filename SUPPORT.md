# Support

Please use GitHub Issues for bug reports, feature requests, and compatibility reports:

https://github.com/SimZhou/vscode-audiolens/issues

When reporting a problem, include:

- AudioLens version.
- VS Code version.
- Operating system.
- Whether the issue happens in a local window or a Remote SSH window.
- Audio format, sample rate, and approximate file size.
- Clear reproduction steps.

For Remote SSH decode failures, also include whether `ffmpeg` is available on the remote extension host and the output of:

```bash
which ffmpeg
ffprobe -hide_banner -v error -show_format -show_streams /path/to/audio
```

Do not attach private or sensitive audio unless you are comfortable making it public.
