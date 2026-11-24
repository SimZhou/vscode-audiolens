# Support

Please use GitHub Issues for bug reports, feature requests, and compatibility reports:

https://github.com/SimZhou/vscode-audiolens/issues

For the independently maintained PyCharm port, please report issues to [CinderellaQAQ/pycharm-audiolens](https://github.com/CinderellaQAQ/pycharm-audiolens/issues).

When reporting a problem, include:

- AudioLens version.
- VS Code version.
- Operating system.
- Whether the issue happens in a local window or a Remote SSH window.
- Audio format, sample rate, and approximate file size.
- Clear reproduction steps.

For decode failures, also include which FFmpeg `AudioLens: Select FFmpeg` marks as in use (or that none was found). In a Remote SSH window, run it there and include the output of these commands on the remote host:

```bash
which ffmpeg
ffprobe -hide_banner -v error -show_format -show_streams /path/to/audio
```

Do not attach private or sensitive audio unless you are comfortable making it public.
