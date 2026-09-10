interface TimelineBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface TimelinePlayheadLabel extends TimelineBounds {
  x: number;
  text: string;
  font: string;
}

// 坐标与 Canvas 一致，均使用物理像素；文本按实际宽度布局，长音频也保留毫秒。
export function layoutTimelinePlayhead(
  context: CanvasRenderingContext2D,
  time: number,
  x: number,
  bounds: TimelineBounds,
  ratio: number
): TimelinePlayheadLabel | undefined {
  if (!Number.isFinite(time) || !Number.isFinite(x) || x < bounds.left || x > bounds.right) return undefined;
  const text = `${Math.max(0, time).toFixed(3)}s`;
  const font = `600 ${12 * ratio}px ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace`;
  context.save();
  context.font = font;
  const width = context.measureText(text).width + 12 * ratio;
  context.restore();
  const inset = 2 * ratio;
  // 极窄视图保留竖线即可，避免压缩数字而失去可读性。
  if (width > bounds.right - bounds.left - 2 * inset || bounds.bottom - bounds.top < 26 * ratio) return undefined;
  const left = Math.max(bounds.left + inset, Math.min(x - width / 2, bounds.right - inset - width));
  const top = bounds.top + 3 * ratio;
  return { x, left, right: left + width, top, bottom: top + 20 * ratio, text, font };
}

export function drawTimelinePlayheadLabel(
  context: CanvasRenderingContext2D,
  label: TimelinePlayheadLabel,
  ratio: number
): void {
  const { left, right, top, bottom, x } = label;
  const radius = 4 * ratio;
  const tipHalfWidth = 4 * ratio;
  // 边缘标签向内收，但指针尖端始终留在真实时间位置。
  const pointerBase = Math.max(left + radius + tipHalfWidth, Math.min(x, right - radius - tipHalfWidth));
  context.save();
  context.fillStyle = "#ffcc66";
  context.strokeStyle = "rgba(0, 0, 0, 0.25)";
  context.lineWidth = ratio;
  context.beginPath();
  context.moveTo(left + radius, top);
  context.lineTo(right - radius, top);
  context.quadraticCurveTo(right, top, right, top + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(pointerBase + tipHalfWidth, bottom);
  context.lineTo(x, bottom + 4 * ratio);
  context.lineTo(pointerBase - tipHalfWidth, bottom);
  context.lineTo(left + radius, bottom);
  context.quadraticCurveTo(left, bottom, left, bottom - radius);
  context.lineTo(left, top + radius);
  context.quadraticCurveTo(left, top, left + radius, top);
  context.closePath();
  context.fill();
  context.stroke();
  context.font = label.font;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#30220b";
  context.fillText(label.text, (left + right) / 2, (top + bottom) / 2);
  context.restore();
}
