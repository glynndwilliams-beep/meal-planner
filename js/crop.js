// Simple touch-friendly crop box: drag the corners to resize, drag the middle to move.
// Returns the selection as fractions (0–1) of the photo.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MIN = 0.08;

export function mountCropper(host, url) {
  host.innerHTML = `<div class="crop"><img alt="Photo to crop"><div class="crop-box">
    <i data-h="tl"></i><i data-h="tr"></i><i data-h="bl"></i><i data-h="br"></i></div></div>`;
  const wrap = host.querySelector('.crop');
  const box = wrap.querySelector('.crop-box');
  wrap.querySelector('img').src = url;
  let r = { x: 0.04, y: 0.04, w: 0.92, h: 0.92 };
  let drag = null;

  const draw = () => Object.assign(box.style, {
    left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`,
  });
  draw();

  wrap.addEventListener('pointerdown', e => {
    const h = e.target.dataset && e.target.dataset.h ? e.target.dataset.h : (e.target === box ? 'move' : null);
    if (!h) return;
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    drag = { h, sx: e.clientX, sy: e.clientY, o: { ...r }, W: wrap.clientWidth, H: wrap.clientHeight };
  });
  wrap.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / drag.W, dy = (e.clientY - drag.sy) / drag.H;
    const o = drag.o;
    let { x, y, w, h } = o;
    if (drag.h === 'move') {
      x = clamp(o.x + dx, 0, 1 - o.w);
      y = clamp(o.y + dy, 0, 1 - o.h);
    } else {
      if (drag.h[1] === 'l') { x = clamp(o.x + dx, 0, o.x + o.w - MIN); w = o.w + (o.x - x); }
      if (drag.h[1] === 'r') w = clamp(o.w + dx, MIN, 1 - o.x);
      if (drag.h[0] === 't') { y = clamp(o.y + dy, 0, o.y + o.h - MIN); h = o.h + (o.y - y); }
      if (drag.h[0] === 'b') h = clamp(o.h + dy, MIN, 1 - o.y);
    }
    r = { x, y, w, h };
    draw();
  });
  const end = () => { drag = null; };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);

  return { get: () => ({ ...r }) };
}
