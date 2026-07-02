import { PlaybackRoutingMode } from "../shared/protocol";

export type { PlaybackRoutingMode };

export interface PlaybackRoutingConnection {
  channel: number;
  output: 0 | 1;
}

export interface PlaybackRoutingPlan {
  effectiveMode: PlaybackRoutingMode;
  outputChannels: 2;
  connections: PlaybackRoutingConnection[];
  channelGains: number[];
}

export interface PlaybackRoutingPlanOptions {
  channelCount: number;
  mode: PlaybackRoutingMode;
  enabledChannels?: readonly boolean[];
}

export function createPlaybackRoutingPlan(options: PlaybackRoutingPlanOptions): PlaybackRoutingPlan {
  const channelCount = Math.max(0, Math.floor(options.channelCount));
  const enabledChannels = Array.from({ length: channelCount }, (_, channel) => options.enabledChannels?.[channel] ?? true);
  const useStereo = options.mode === "stereo" && channelCount > 0 && channelCount <= 2;

  if (useStereo) {
    return createStereoPlan(enabledChannels);
  }

  return createDownmixPlan(enabledChannels);
}

function createStereoPlan(enabledChannels: readonly boolean[]): PlaybackRoutingPlan {
  const channelCount = enabledChannels.length;
  const connections: PlaybackRoutingConnection[] = channelCount === 1
    ? [
        { channel: 0, output: 0 },
        { channel: 0, output: 1 }
      ]
    : [
        { channel: 0, output: 0 },
        { channel: 1, output: 1 }
      ];

  return {
    effectiveMode: "stereo",
    outputChannels: 2,
    connections,
    channelGains: enabledChannels.map((enabled) => (enabled ? 1 : 0))
  };
}

function createDownmixPlan(enabledChannels: readonly boolean[]): PlaybackRoutingPlan {
  const enabledCount = enabledChannels.filter(Boolean).length;
  const channelGain = enabledCount > 0 ? 1 / enabledCount : 0;
  const connections = enabledChannels.flatMap<PlaybackRoutingConnection>((_, channel) => [
    { channel, output: 0 },
    { channel, output: 1 }
  ]);

  return {
    effectiveMode: "downmix",
    outputChannels: 2,
    connections,
    channelGains: enabledChannels.map((enabled) => (enabled ? channelGain : 0))
  };
}
