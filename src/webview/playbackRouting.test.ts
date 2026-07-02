import test from "node:test";
import assert from "node:assert/strict";

import { createPlaybackRoutingPlan } from "./playbackRouting";

test("downmix mode sends each enabled channel to both stereo outputs with normalized gain", () => {
  const plan = createPlaybackRoutingPlan({
    channelCount: 2,
    mode: "downmix",
    enabledChannels: [true, true]
  });

  assert.deepEqual(plan.connections, [
    { channel: 0, output: 0 },
    { channel: 0, output: 1 },
    { channel: 1, output: 0 },
    { channel: 1, output: 1 }
  ]);
  assert.deepEqual(plan.channelGains, [0.5, 0.5]);
});

test("stereo mode preserves two-channel left/right speaker mapping", () => {
  const plan = createPlaybackRoutingPlan({
    channelCount: 2,
    mode: "stereo",
    enabledChannels: [true, true]
  });

  assert.equal(plan.effectiveMode, "stereo");
  assert.deepEqual(plan.connections, [
    { channel: 0, output: 0 },
    { channel: 1, output: 1 }
  ]);
  assert.deepEqual(plan.channelGains, [1, 1]);
});

test("stereo mode keeps muted stereo channels silent without re-centering the other channel", () => {
  const plan = createPlaybackRoutingPlan({
    channelCount: 2,
    mode: "stereo",
    enabledChannels: [true, false]
  });

  assert.deepEqual(plan.connections, [
    { channel: 0, output: 0 },
    { channel: 1, output: 1 }
  ]);
  assert.deepEqual(plan.channelGains, [1, 0]);
});

test("stereo mode falls back to downmix for more than two channels", () => {
  const plan = createPlaybackRoutingPlan({
    channelCount: 3,
    mode: "stereo",
    enabledChannels: [true, true, true]
  });

  assert.equal(plan.effectiveMode, "downmix");
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
