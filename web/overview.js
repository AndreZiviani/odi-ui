/*
 * The stick, drawn: fibre, optics, SoC, host lane, router, each part with
 * its live figure, on top of the Status tab. The idea, a diagram of the
 * stick with a value on every block, came from the modified UI a user
 * shared in odi-oss #300; this is a fresh implementation over the same poll.
 *
 * Everything here is read off the one /api/status answer the page already
 * fetches every 15 s: diag for the optics, the ONU state and the port
 * counters, and plain file reads in confd for CPU, memory, ONU-ID, the
 * PON load and the host side (src/status.c, emit_overview). A part whose source is missing
 * (a stock slot has no /proc/odi_gpon) shows a dash, never a guess.
 *
 * Clicking a part goes to the section that explains it.
 */

import { $, el, bytes } from './dom.js';
import { parsePorts } from './flow.js';
import { serdesShort } from './hostlink.js';

const STATE_NAMES = { O1: 'Initial', O2: 'Standby', O3: 'Serial number', O4: 'Ranging',
  O5: 'In service', O6: 'Intermittent', O7: 'Emergency stop' };

/* A real minus sign, as the meters print it. */
const signed = (v, d) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

/* The cpu line of /proc/stat: user nice system idle iowait irq softirq steal ...
   Busy is everything but idle and iowait, over the interval between two
   polls, so the first poll has no figure. */
let PREV_CPU = null;
function cpuBusy(line) {
  if (typeof line !== 'string') { PREV_CPU = null; return null; }
  const f = line.trim().split(/\s+/).map(Number);
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) { PREV_CPU = null; return null; }
  const total = f.reduce((a, b) => a + b, 0);
  const idle = f[3] + (f[4] || 0);
  const prev = PREV_CPU;
  PREV_CPU = { total, idle };
  if (!prev || total <= prev.total) return null;
  return 100 * (1 - (idle - prev.idle) / (total - prev.total));
}

/*
 * How full the downstream of the whole PON is, every ONU on the tree
 * together. The OLT fills what nobody needs with idle GEM frames, five
 * bytes each, and they are addressed to nobody, so the share of a frame
 * that was not idle is what the OLT sent to somebody. An estimate:
 *
 *   - the frame header (PCBd, with the bandwidth map), GEM headers and
 *     management traffic count as used, so a tree with no traffic at all
 *     reads a little above zero;
 *   - with FEC on, the 16 parity bytes of each of the 153 code words of a
 *     frame carry nothing and are taken out first;
 *   - an OLT may send dummy frames instead of idle ones (G.984.3 lets it,
 *     to control the idle pattern); they would read as load;
 *   - downstream only: nothing here says how busy the upstream is.
 *
 * Counted against the superframe counter (one per 125 us frame, 30 bits)
 * rather than the clock, so the poll interval drops out. confd sends the
 * members only as a consistent set (src/status.c, emit_pon_load).
 *
 * No figure, rather than a clamped one, on the first poll and whenever the
 * interval cannot be trusted: FEC changed, the idle count went backwards
 * (a reboot), the driver read the idle register full meanwhile, the frame
 * count moved more than the time between the polls allows (the line
 * re-locked), or the result is outside 0 to 100 %.
 */
const PON_FRAME = 38880;        /* bytes in 125 us at 2.488 Gbit/s */
const PON_FEC_PARITY = 153 * 16;
const GEM_IDLE = 5;
let PREV_PON = null;
function ponLoad(st) {
  const sf = Number(st && st.ds_superframe);
  const fec = st && typeof st.ds_fec === 'string' ? st.ds_fec.trim() : '';
  const sat = st && typeof st.ds_gem_idle_sat === 'string' ? Number(st.ds_gem_idle_sat) : 0;
  let idle = null;
  try { idle = BigInt(String(st && st.ds_gem_idle).trim()); } catch (e) { /* not there */ }
  if (!st || typeof st.ds_superframe !== 'string' || !Number.isFinite(sf) || !Number.isFinite(sat)
      || idle === null) {
    PREV_PON = null;
    return null;
  }
  const now = Date.now();
  const prev = PREV_PON;
  PREV_PON = { at: now, sf, idle, fec, sat };
  if (!prev || idle < prev.idle || fec !== prev.fec || sat !== prev.sat) return null;
  const frames = (sf - prev.sf + 0x40000000) % 0x40000000;
  if (frames <= 0 || frames > (now - prev.at) * 8 * 1.1 + 16) return null;
  const payload = PON_FRAME - (fec === '1' ? PON_FEC_PARITY : 0);
  const used = payload - Number(idle - prev.idle) * GEM_IDLE / frames;
  const pct = 100 * used / payload;
  return pct < 0 || pct > 100 ? null : pct;
}

/* "  14792 kB" -> bytes. */
const kb = (s) => {
  const m = /(\d+)\s*kB/.exec(s || '');
  return m ? Number(m[1]) * 1024 : null;
};
const mib = (b) => (b / 1048576).toFixed(1) + ' MiB';

/* The fibre side of the switch is port 2 (flow.js): what it receives came
   down the fibre, what it sends goes up. */
let PREV_PORTS = null;
function fibreRates(counterText) {
  const ports = parsePorts(counterText);
  const now = Date.now();
  const prev = PREV_PORTS;
  PREV_PORTS = ports['2'] ? { at: now, p: ports['2'] } : null;
  if (!prev || !ports['2']) return null;
  const dt = (now - prev.at) / 1000;
  if (dt < 1) return null;
  const rate = (k) => {
    const d = Number(ports['2'][k] || 0) - Number(prev.p[k] || 0);
    return d < 0 ? null : d / dt;
  };
  return { down: rate('ifInOctets'), up: rate('ifOutOctets') };
}

/* One part: a button, so the keyboard reaches it, with a name, up to two
   figure lines and a status dot. `go` is where a click takes you. */
function part(cls, name, lines, verdict, go) {
  const b = el('button', 'ov-part ' + cls);
  b.type = 'button';
  const head = el('span', 'ov-name');
  head.append(el('i', 'dot ' + (verdict || 'none')), document.createTextNode(name));
  b.append(head);
  for (const [text, extra] of lines) b.append(el('span', 'ov-val' + (extra ? ' ' + extra : ''), text));
  b.addEventListener('click', go);
  return b;
}

const scrollTo = (sel) => () => {
  const t = $(sel);
  if (!t) return;
  t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  t.classList.remove('ov-flash');
  void t.offsetWidth;
  t.classList.add('ov-flash');
};
const goTo = (hash) => () => { location.hash = hash; };

/*
 * f: what renderStatus already worked out (rx and tx with their meter
 * verdicts, module temperature, ONU state, LOS) plus the raw /api/status
 * members this view reads itself.
 */
function renderOverview(f) {
  const host = $('#overview');
  if (!host) return;
  host.textContent = '';

  const rxv = f.rx.value;
  const fibre = el('button', 'ov-fibre ov-part');
  fibre.type = 'button';
  const fhead = el('span', 'ov-name');
  fhead.append(el('i', 'dot ' + f.rx.verdict), document.createTextNode('Fibre'));
  const fval = el('span', 'ov-big');
  fval.append(el('span', 'num', rxv === null ? '—' : signed(rxv, 1)), el('span', 'unit', 'dBm'));
  fibre.append(fhead, fval, el('span', 'ov-val ov-sub', f.los ? 'Loss of signal' : 'Light in'));
  fibre.addEventListener('click', scrollTo('#rx'));

  const txv = f.tx.value;
  const optics = part('ov-optics', 'Optics', [
    [txv === null ? 'Laser —' : `Laser ${signed(txv, 2)} dBm`],
    [f.temp === null ? 'Module —' : `Module ${signed(f.temp, 1)} °C`],
    ['↓ 1490 nm  ↑ 1310 nm', 'ov-sub'],
  ], f.tx.verdict, scrollTo('#tx'));

  const busy = cpuBusy(f.st.cpu);
  const cpu = part('ov-cpu', 'CPU', [[busy === null ? 'measuring' : busy.toFixed(0) + ' % busy']],
    busy === null ? 'none' : busy > 90 ? 'warn' : 'ok', scrollTo('#stickblock'));

  const total = kb(f.st.mem_total);
  const avail = kb(f.st.mem_avail);
  const mem = part('ov-mem', 'Memory', [
    [avail === null ? '—' : mib(avail) + ' free'],
    ...(total === null ? [] : [['of ' + mib(total), 'ov-sub']]),
  ], avail === null ? 'none' : avail < 4 * 1048576 ? 'warn' : 'ok', scrollTo('#stickblock'));

  const onuId = /^\s*(\d+)/.exec(f.st.onu_id || '');
  /* undefined outside O5 and on a slot whose driver has no such counters,
     null while there is no interval to go by. */
  const load = f.state === 'O5' && typeof f.st.ds_superframe === 'string'
    ? ponLoad(f.st) : (ponLoad(null), undefined);
  const gpon = part('ov-gpon', 'GPON', [
    [f.state ? `${f.state} ${STATE_NAMES[f.state] || ''}`.trim() : 'No state'],
    [onuId ? 'ONU-ID ' + onuId[1] : 'ONU-ID —', 'ov-sub'],
    [load === undefined ? 'PON load —' : load === null ? 'PON load measuring'
      : `PON load ↓ ≈ ${load < 10 ? load.toFixed(1) : load.toFixed(0)} %`, 'ov-sub'],
  ], !f.state ? 'none' : f.state === 'O5' ? 'ok' : 'bad', scrollTo('#ladder'));

  const r = fibreRates(f.st.raw_counters);
  const rateText = (v) => (v === null || v === undefined ? 'measuring' : bytes(v) + '/s');
  const sw = part('ov-switch', 'Switch', [
    ['↓ ' + rateText(r && r.down)],
    ['↑ ' + rateText(r && r.up)],
  ], r ? 'ok' : 'none', scrollTo('#flow'));

  const link = typeof f.st.host_link === 'string' ? f.st.host_link.trim() : '';
  const linked = link === '1' ? true : link === '0' ? false : null;
  const mode = typeof f.st.host_mode === 'string' && f.st.host_mode.trim()
    ? serdesShort(f.st.host_mode.trim()) : null;
  const lane = part('ov-lane', 'Host lane', [
    [mode || '—'],
  ], linked === null ? 'none' : linked ? 'ok' : 'bad', goTo('config/network'));
  const router = part('ov-router', 'Router', [
    [linked === null ? '—' : linked ? 'Linked' : 'No link'],
  ], linked === null ? 'none' : linked ? 'ok' : 'bad', goTo('config/network'));

  const soc = el('div', 'ov-soc');
  const chip = f.chip && typeof f.chip.celsius === 'number' ? ` ${signed(f.chip.celsius, 0)} °C` : '';
  soc.append(el('span', 'ov-label', 'SoC' + chip), cpu, mem, gpon, sw);

  const stick = el('div', 'ov-stick');
  stick.append(el('span', 'ov-label ov-stick-label', 'The stick'), optics, soc, lane);

  const fibreLine = el('div', 'ov-line ov-glass');
  fibreLine.setAttribute('aria-hidden', 'true');
  const pins = el('div', 'ov-line ov-pins');
  pins.setAttribute('aria-hidden', 'true');
  host.append(fibre, fibreLine, stick, pins, router);
}

export { renderOverview, cpuBusy, ponLoad };
