import { PlaybackAlgorithm } from "../shared/protocol";

export type { PlaybackAlgorithm };

export interface PlaybackRoutingConnection {
  channel: number;
  output: 0 | 1;
}

export interface PlaybackRoutingPlan {
  effectiveAlgorithm: PlaybackAlgorithm;
  outputChannels: 2;
  connections: PlaybackRoutingConnection[];
  channelGains: number[];
}

export interface PlaybackRoutingPlanOptions {
  channelCount: number;
  algorithm: PlaybackAlgorithm;
  enabledChannels?: readonly boolean[];
}

interface PlaybackAlgorithmDefinition {
  createPlan(enabledChannels: readonly boolean[]): PlaybackRoutingPlan;
}

export const PLAYBACK_ALGORITHMS: Record<PlaybackAlgorithm, PlaybackAlgorithmDefinition> = {
  downmix: { createPlan: createDownmixPlan },
  bypass: { createPlan: createBypassPlan }
};

export function createPlaybackRoutingPlan(options: PlaybackRoutingPlanOptions): PlaybackRoutingPlan {
  const channelCount = Math.max(0, Math.floor(options.channelCount));
  const enabledChannels = Array.from({ length: channelCount }, (_, channel) => options.enabledChannels?.[channel] ?? true);
  return PLAYBACK_ALGORITHMS[options.algorithm].createPlan(enabledChannels);
}

function createBypassPlan(enabledChannels: readonly boolean[]): PlaybackRoutingPlan {
  const channelCount = enabledChannels.length;
  if (channelCount > 2) {
    return createDownmixPlan(enabledChannels);
  }

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
    effectiveAlgorithm: "bypass",
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
    effectiveAlgorithm: "downmix",
    outputChannels: 2,
    connections,
    channelGains: enabledChannels.map((enabled) => (enabled ? channelGain : 0))
  };
}
