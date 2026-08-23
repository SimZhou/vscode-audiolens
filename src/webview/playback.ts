export function defaultChannelPan(channelCount: number, channel: number): number {
  if (channelCount !== 2) {
    return 0;
  }
  if (channel === 0) {
    return -1;
  }
  if (channel === 1) {
    return 1;
  }
  return 0;
}
