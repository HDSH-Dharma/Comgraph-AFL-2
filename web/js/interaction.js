// Interaksi mouse, sentuh, dan keyboard pada kanvas peta.
// Pan: seret (1 jari / mouse) atau tombol panah.
// Zoom: roda mouse, cubit 2 jari, klik ganda, tombol + / −.

const TAP_SLOP = { mouse: 4, pen: 6, touch: 10 };
const KEY_PAN_PX = 90;

export function attachInteractions(canvas, { viewport, renderer, onTap, onHover, onViewChange, onFit, onEscape }) {
  const pointers = new Map();
  let drag = null;
  let pinch = null;

  const pos = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const changed = () => {
    renderer.requestRender();
    onViewChange?.();
  };

  const startPinch = () => {
    const [a, b] = [...pointers.values()];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: [(a.x + b.x) / 2, (a.y + b.y) / 2],
      zoom: viewport.zoom,
    };
    drag = null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const [x, y] = pos(e);
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x, y });
    if (pointers.size === 1) {
      drag = { x, y, startX: x, startY: y, moved: false, type: e.pointerType || 'mouse' };
    } else if (pointers.size === 2) {
      startPinch();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = pos(e);
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') onHover?.(renderer.hitTest(x, y, 4), x, y);
      return;
    }
    pointers.set(e.pointerId, { x, y });

    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      viewport.panBy(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1]);
      viewport.zoomAt(mid[0], mid[1], pinch.zoom + Math.log2(dist / pinch.dist));
      pinch.mid = mid;
      changed();
      return;
    }

    if (drag) {
      const slop = TAP_SLOP[drag.type] ?? 6;
      if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) > slop) {
        drag.moved = true;
        canvas.classList.add('is-dragging');
        onHover?.(null);
      }
      if (drag.moved) {
        viewport.panBy(x - drag.x, y - drag.y);
        changed();
      }
      drag.x = x;
      drag.y = y;
    }
  });

  const endPointer = (e, cancelled) => {
    if (!pointers.has(e.pointerId)) return;
    const [x, y] = pos(e);
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {
        const [p] = [...pointers.values()];
        drag = { x: p.x, y: p.y, startX: p.x, startY: p.y, moved: true, type: 'touch' };
      }
      return;
    }
    if (drag && !drag.moved && !cancelled) {
      const tolerance = drag.type === 'touch' ? 12 : 4;
      onTap?.(renderer.hitTest(x, y, tolerance), x, y);
    }
    drag = null;
    canvas.classList.remove('is-dragging');
  };
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !pointers.has(e.pointerId)) onHover?.(null);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      const delta = Math.max(-200, Math.min(200, e.deltaY * unit));
      if (viewport.zoomAt(x, y, viewport.zoom - delta * 0.0025)) changed();
    },
    { passive: false }
  );

  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const [x, y] = pos(e);
    if (viewport.zoomAt(x, y, Math.round(viewport.zoom) + (e.shiftKey ? -1 : 1))) changed();
  });

  canvas.addEventListener('keydown', (e) => {
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        viewport.panBy(KEY_PAN_PX, 0);
        break;
      case 'ArrowRight':
        viewport.panBy(-KEY_PAN_PX, 0);
        break;
      case 'ArrowUp':
        viewport.panBy(0, KEY_PAN_PX);
        break;
      case 'ArrowDown':
        viewport.panBy(0, -KEY_PAN_PX);
        break;
      case '+':
      case '=':
        viewport.zoomAt(cx, cy, viewport.zoom + 1);
        break;
      case '-':
      case '_':
        viewport.zoomAt(cx, cy, viewport.zoom - 1);
        break;
      case '0':
        onFit?.();
        break;
      case 'Escape':
        onEscape?.();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      changed();
    }
  });
}
