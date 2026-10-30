const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const W = 380, H = 190, L = 40, R = 8, T = 10, B = 24;
const day = (ts) => new Date(ts * 1000).toISOString().slice(5, 10);
const stamp = (ts) => new Date(ts * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
const tick = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : Number.isInteger(v) ? String(v) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2));

function scale(lo, hi) {
  if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
  const step = 10 ** Math.floor(Math.log10((hi - lo) / 4));
  const nice = [1, 2, 5, 10].map((m) => m * step).find((s) => (hi - lo) / s <= 5);
  return { lo: Math.floor(lo / nice) * nice, hi: Math.ceil(hi / nice) * nice, step: nice };
}

function frame(title, desc, body) {
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: ${esc(desc)}"><title>${esc(title)}</title><desc>${esc(desc)}</desc>${body}</svg><figcaption>${esc(title)}</figcaption></figure>`;
}

function axes(y, x0, x1) {
  const ys = [];
  for (let v = y.lo; v <= y.hi + y.step / 2; v += y.step) ys.push(v);
  const yy = (v) => T + (H - T - B) * (1 - (v - y.lo) / (y.hi - y.lo));
  const grid = ys.map((v) => `<line class="gl" x1="${L}" x2="${W - R}" y1="${yy(v).toFixed(1)}" y2="${yy(v).toFixed(1)}"/><text class="ax" x="${L - 6}" y="${(yy(v) + 4).toFixed(1)}" text-anchor="end">${tick(v)}</text>`).join('');
  return { yy, svg: `${grid}<text class="ax" x="${L}" y="${H - 6}">${esc(x0)}</text><text class="ax" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(x1)}</text>` };
}

/**
 * Line chart over time. points: [{ ts, y }], oldest first. refs: [{ y, label }] dashed reference lines.
 * Returns an empty-state figure when there are fewer than two points.
 */
export function lineChart(points, { title, unit = '', refs = [], min, max } = {}) {
  if (points.length < 2) return frame(title, 'not enough history yet', `<text class="ax" x="${W / 2}" y="${H / 2}" text-anchor="middle">Not enough history yet: ${points.length} point${points.length === 1 ? '' : 's'}. Each dashboard build adds one.</text>`);
  const ys = points.map((p) => p.y);
  const y = scale(min ?? Math.min(...ys), max ?? Math.max(...ys));
  refs = refs.filter((r) => r.y >= y.lo && r.y <= y.hi);
  const t0 = points[0].ts, t1 = points.at(-1).ts;
  const xx = (ts) => L + (W - L - R) * ((ts - t0) / (t1 - t0 || 1));
  const a = axes(y, stamp(t0), stamp(t1));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xx(p.ts).toFixed(1)} ${a.yy(p.y).toFixed(1)}`).join('');
  const ref = refs.map((r) => `<line class="ref" x1="${L}" x2="${W - R}" y1="${a.yy(r.y).toFixed(1)}" y2="${a.yy(r.y).toFixed(1)}"/><text class="ax ref-l" x="${W - R - 4}" y="${(a.yy(r.y) - 4).toFixed(1)}" text-anchor="end">${esc(r.label)}</text>`).join('');
  const last = points.at(-1);
  const lo = Math.min(...points.map((p) => p.y)), hi = Math.max(...points.map((p) => p.y));
  const desc = `${points.length} points from ${stamp(t0)} to ${stamp(t1)}, range ${tick(lo)}–${tick(hi)}${unit}, latest ${tick(last.y)}${unit}`;
  return frame(title, desc, `${a.svg}${ref}<path class="line" d="${d}"/><circle class="dot" cx="${xx(last.ts).toFixed(1)}" cy="${a.yy(last.y).toFixed(1)}" r="3"><title>${tick(last.y)}${esc(unit)} at ${stamp(last.ts)}</title></circle>`);
}

/** Bar chart per day. bars: [{ day, y, label }], oldest first. */
export function barChart(bars, { title, unit = '' } = {}) {
  if (!bars.length) return frame(title, 'no data', '');
  const y = scale(0, Math.max(1, ...bars.map((b) => b.y)));
  const a = axes(y, day(bars[0].day), day(bars.at(-1).day));
  const bw = (W - L - R) / bars.length;
  const total = bars.reduce((s, b) => s + b.y, 0);
  const rects = bars.map((b, i) => {
    const top = a.yy(b.y);
    return `<rect class="bar-r" x="${(L + i * bw + 1).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${(H - B - top).toFixed(1)}"><title>${day(b.day)}: ${esc(b.label ?? `${tick(b.y)}${unit}`)}</title></rect>`;
  }).join('');
  return frame(title, `${bars.length} days, total ${tick(total)}${unit}, busiest day ${tick(Math.max(...bars.map((b) => b.y)))}${unit}`, `${a.svg}${rects}`);
}
