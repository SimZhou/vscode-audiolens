import test from "node:test";
import assert from "node:assert/strict";

import { createPlaybackRoutingPlan, PLAYBACK_ALGORITHMS } from "./playbackAlgorithms";

test("playback algorithms expose downmix and bypass implementations", () => {
  assert.deepEqual(Object.keys(PLAYBACK_ALGORITHMS), ["downmix", "bypass"]);
});

test("downmix algorithm sends each enabled channel to both stereo outputs with normalized gain", () => {
  const plan = createPlaybackRoutingPlan({
    channelCount: 2,
    algorithm: "downmix",
    enabledChannels: [true, true]
  });

  assert.equal(plan.effectiveAlgorithm, "downmix");
  assert.deepEqual(plan.connections, [
    { channel: 0, output: 0 },
    { channel: 0, output: 1 },
    { channel: 1, output: 0 },
    { channel: 1, output: 1 }
  ]);
  assert.deepEqual(plan.channelGains, [0.5, 0.5]);
});

test("bypass algorithm preserves two-channel left/right speaker mapping", () => {
  const plan = createPlaybackRoutingPlan({
    channelCount: 2,
    algorithm: "bypass",
    enabledChannels: [true, true]
  });

  assert.equal(plan.effectiveAlgorithm, "bypass");
  assert.deepEqual(plan.connections, [
    { channel: 0, output: 0 },
    { channel: 1, output: 1 }
  ]);
  assert.deepEqual(plan.channelGains, [1, 1]);
});

test("bypass algorithm keeps muted stereo channels silent without re-centering the other channel", () => {
  const plan = createPlaybackRoutingPlan({
    channelCount: 2,
    algorithm: "bypass",
    enabledChannels: [true, false]
  });

  assert.deepEqual(plan.connections, [
    { channel: 0, output: 0 },
    { channel: 1, output: 1 }
  ]);
  assert.deepEqual(plan.channelGains, [1, 0]);
});

test("bypass algorithm falls back to downmix for more than two channels", () => {
  const plan = createPlaybackRoutingPlan({
    channelCount: 3,
    algorithm: "bypass",
    enabledChannels: [true, true, true]
  });

  assert.equal(plan.effectiveAlgorithm, "downmix");
  assert.deepEqual(plan.channelGains, [1 / 3, 1 / 3, 1 / 3]);
  assert.deepEqual(plan.connections, [
    { channel: 0, output: 0 },
    { channel: 0, output: 1 },
    { channel: 1, output: 0 },
    { channel: 1, output: 1 },
    { channel: 2, output: 0 },
    { channel: 2, output: 1 }
  ]);
});
