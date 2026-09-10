interface TimelineDragAnchor {
  time: number;
  secondsPerPixel: number;
}

interface TimelineDragOptions {
  hitTest(clientX: number, clientY: number): TimelineDragAnchor | undefined;
  start(): void;
  seek(time: number): void;
  end(canceled: boolean): void;
}

export interface TimelineDragController {
  cancel(): void;
  isDragging(): boolean;
}

// 捕获指针后，即使鼠标离开标签或画布也能完成拖动；按抓取点的位移定位，
// 不把鼠标强行吸到标签中心，避免边缘处已向内收的标签在按下时跳动。
export function bindTimelinePlayheadDrag(canvas: HTMLCanvasElement, options: TimelineDragOptions): TimelineDragController {
  let drag: (TimelineDragAnchor & { pointerId: number; clientX: number }) | undefined;
  const finish = (canceled: boolean) => {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag = undefined;
    canvas.style.cursor = "";
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    options.end(canceled);
  };
  const seek = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    options.seek(drag.time + (event.clientX - drag.clientX) * drag.secondsPerPixel);
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    const anchor = options.hitTest(event.clientX, event.clientY);
    if (!anchor) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drag = { ...anchor, pointerId: event.pointerId, clientX: event.clientX };
    canvas.style.cursor = "grabbing";
    canvas.focus({ preventScroll: true });
    options.start();
    options.seek(anchor.time);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (drag) {
      event.preventDefault();
      seek(event);
    } else {
      canvas.style.cursor = options.hitTest(event.clientX, event.clientY) ? "grab" : "";
    }
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    seek(event);
    finish(false);
  });
  canvas.addEventListener("pointercancel", (event) => {
    if (drag?.pointerId === event.pointerId) finish(true);
  });
  canvas.addEventListener("lostpointercapture", (event) => {
    if (drag?.pointerId === event.pointerId) finish(true);
  });
  canvas.addEventListener("pointerleave", () => {
    if (!drag) canvas.style.cursor = "";
  });
  window.addEventListener("blur", () => finish(true));
  return { cancel: () => finish(true), isDragging: () => drag !== undefined };
}
