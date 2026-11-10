/*
 * The Status tab: optical meters and the registration ladder.
 *
 * The device parses nothing it does not have to -- /api/status returns diag's
 * raw output and the splitting happens here, which means adding a status field
 * costs no C and no reflash.
 */

import { $, el, histRecord, histSlots, histStart, hhmm } from './dom.js';
import { renderFlow } from './flow.js';
import { renderOverview } from './overview.js';

/* diag echoes each command after its "RTK.0> " prompt, so the reply splits back
 * into per-command sections on that marker. */
function sections(raw) {
  const out = {};
  const parts = raw.split('RTK.0> ');
  for (const p of parts) {
    const nl = p.indexOf('\n');
    if (nl < 0) continue;
    out[p.slice(0, nl).trim()] = p.slice(nl + 1);
  }
  return out;
}

const num = (s, re) => { const m = re.exec(s || ''); return m ? m[1] : null; };

/*
 * Optical power, on a scale.
 *
 * A bare number does not tell you whether -23 dBm is healthy. The window drawn
 * on the scale is the GPON class B+ range this optics is specified for, and
 * the two dimension lines under it are the margin to each edge -- which is
 * the number that actually decides whether a line will survive a dirty
 * connector or a new splice. The edge names are the ones a power-meter
 * datasheet uses: sensitivity is the weakest light the receiver still
 * decodes, overload the strongest.
 */
/*
 * The windows are the ONU figures for optical budget class B+ in ITU-T
 * G.984.2 Amendment 1: mean launched power +0.5 to +5 dBm, receiver
 * sensitivity -27 dBm, overload -8 dBm. (The OLT side of B+ differs --
 * +1.5 to +5 launched, -28 sensitivity -- and is not what this stick is.)
 */
const OPTICS = {
  rx: { name: 'Receive', lo: -30, hi: -4, winLo: -27, winHi: -8,
        loName: 'sensitivity', hiName: 'overload', note: 'Class B+ receive window' },
  tx: { name: 'Transmit', lo: -3, hi: 8, winLo: 0.5, winHi: 5,
        loName: 'minimum', hiName: 'maximum', note: 'Class B+ launch power' },
};
/*
 * "Near the edge" is the outer 16% of the window at each end, not a fixed
 * figure: about 3 dB of the 19 dB receive window, about 0.7 dB of the
 * 4.5 dB launch window. A fixed 3 dB was more than half the launch window,
 * so a healthy +2.15 dBm transmitter read as marginal on every stick.
 */
const TIGHT_SHARE = 0.16;
const tight = (spec) => (spec.winHi - spec.winLo) * TIGHT_SHARE;

/* A real minus sign, not a hyphen: the readout face draws the two differently. */
const signed = (v, d) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

function meter(hostSel, spec, value) {
  const host = $(hostSel);
  host.textContent = '';
  const pct = (v) => ((Math.max(spec.lo, Math.min(spec.hi, v)) - spec.lo) / (spec.hi - spec.lo)) * 100;

  let verdict = 'none';
  let say = 'No reading';
  if (value !== null) {
    const m = Math.min(value - spec.winLo, spec.winHi - value);
    if (value < spec.winLo || value > spec.winHi) { verdict = 'bad'; say = 'Out of window'; }
    else if (m < tight(spec)) { verdict = 'warn'; say = 'Near the edge'; }
    else { verdict = 'ok'; say = 'In window'; }
  }
  host.className = 'meter v-' + verdict;

  const head = el('div', 'm-head');
  head.append(el('h2', 'm-name', spec.name), el('span', 'm-verdict', say));
  host.append(head);

  const read = el('div', 'm-read');
  read.append(el('span', 'num', value === null ? '—' : signed(value, 2)), el('span', 'unit', 'dBm'));
  host.append(read);

  const scale = el('div', 'scale');
  scale.style.setProperty('--n', String(spec.hi - spec.lo));
  const win = el('div', 'win');
  win.style.left = pct(spec.winLo) + '%';
  win.style.width = (pct(spec.winHi) - pct(spec.winLo)) + '%';
  scale.append(el('div', 'ticks'), win);
  if (value !== null) {
    const n = el('div', 'needle');
    n.style.left = pct(value) + '%';
    scale.append(n);
  }
  const lab = el('div', 'm-ticks');
  const step = spec.hi - spec.lo > 15 ? 5 : 2;
  for (let v = Math.ceil(spec.lo / step) * step; v <= spec.hi; v += step) {
    const t = el('span', null, signed(v, 0));
    t.style.left = pct(v) + '%';
    lab.append(t);
  }

  /* Dimension lines: edge to needle, both sides. Outside the window there is
     only one, from the edge that was crossed, and it says by how much. */
  const dims = el('div', 'm-dims');
  const dim = (a, b, text, cls) => {
    const d = el('div', 'dim' + (cls ? ' ' + cls : ''));
    d.style.left = Math.min(pct(a), pct(b)) + '%';
    d.style.width = Math.abs(pct(b) - pct(a)) + '%';
    /* The figure always shows; the edge name goes first when the line is
       too short to hold both (a narrow screen, a reading near an edge). */
    const [fig, ...rest] = text.split(' dB ');
    const t = el('span', null, fig + ' dB');
    t.append(el('em', null, ' ' + rest.join(' dB ')));
    d.append(t);
    dims.append(d);
  };
  let label = spec.name + ': no reading.';
  if (value !== null) {
    const toLo = value - spec.winLo;
    const toHi = spec.winHi - value;
    if (toLo < 0) {
      dim(value, spec.winLo, `${(-toLo).toFixed(1)} dB below ${spec.loName}`, 'over');
      label = `${signed(value, 2)} dBm, ${(-toLo).toFixed(1)} dB below the ${spec.loName} edge.`;
    } else if (toHi < 0) {
      dim(spec.winHi, value, `${(-toHi).toFixed(1)} dB over ${spec.hiName}`, 'over');
      label = `${signed(value, 2)} dBm, ${(-toHi).toFixed(1)} dB over the ${spec.hiName} edge.`;
    } else {
      dim(spec.winLo, value, `${toLo.toFixed(1)} dB to ${spec.loName}`, toLo < tight(spec) ? 'tight' : '');
      dim(value, spec.winHi, `${toHi.toFixed(1)} dB to ${spec.hiName}`, toHi < tight(spec) ? 'tight' : '');
      label = `${signed(value, 2)} dBm: ${toLo.toFixed(1)} dB above ${spec.loName}, `
        + `${toHi.toFixed(1)} dB below ${spec.hiName}.`;
    }
  }
  const inst = el('div', 'instrument');
  inst.setAttribute('role', 'img');
  inst.setAttribute('aria-label', label + ' ' + spec.note + ', '
    + signed(spec.winLo, 1) + ' to ' + signed(spec.winHi, 1) + ' dBm.');
  inst.append(scale, lab, dims);
  host.append(inst);
  const foot = el('p', 'm-note');
  foot.textContent = `${spec.note}, ${signed(spec.winLo, 1)} to ${signed(spec.winHi, 1)} dBm`;
  host.append(foot);
  return { verdict, value };
}

/* O1 to O5 is a real sequence — an ONU climbs it on every registration — which
   is the one thing on this page worth numbering. */
const STATES = {
  O1: 'Initial', O2: 'Standby', O3: 'Serial number',
  O4: 'Ranging', O5: 'Operational', O6: 'Intermittent', O7: 'Emergency stop',
};

function ladder(state) {
  const host = $('#ladder');
  host.textContent = '';
  const n = state ? Number(state.slice(1)) : 0;
  for (let i = 1; i <= 5; i++) {
    const li = el('li', null, 'O' + i);
    li.title = STATES['O' + i];
    if (i === n) li.setAttribute('aria-current', 'step');
    if (i < n) li.classList.add('done');
    if (i === n) li.classList.add('here');
    host.append(li);
  }
  const note = $('#statenote');
  note.classList.toggle('bad', state !== 'O5');
  note.textContent = !state ? 'No state reported.'
    : state === 'O5' ? 'Operational. The line is registered and carrying traffic.'
    : (STATES[state] || state) + ': not yet operational.';
}
/*
 * The SoC temperature, from /api/status chip_temp (the kernel hwmon sensor,
 * read by confd; absent on an image without it). Only the alarms the kernel
 * raised decide anything: this page holds no limit of its own, and the limits
 * it quotes are the ones the stick reports.
 */
const deg = (v) => Math.round(v) + ' \u00b0C';

function chipRow(chip) {
  const t = signed(chip.celsius, 1) + ' \u00b0C';
  const level = chip.crit_alarm ? 'critical' : chip.max_alarm ? 'warning' : null;
  if (!level) return [t, 'num'];
  const lim = level === 'critical' ? chip.crit : chip.max;
  return [`${t}, above the ${level} limit` + (typeof lim === 'number' ? ` (${deg(lim)})` : ''),
    level === 'critical' ? 'bad' : 'warn'];
}

/* The header bar on every view: only the critical alarm raises it. */
function chipBar(chip) {
  const bar = $('#chipbanner');
  const hot = !!(chip && chip.crit_alarm);
  bar.hidden = !hot;
  const p = $('#chip-text');
  p.textContent = '';
  if (!hot) return;
  p.append(el('strong', null, 'The chip is very hot'),
    document.createTextNode(` (${deg(chip.celsius)}${typeof chip.crit === 'number' ? ', limit ' + deg(chip.crit) : ''}). `
      + 'Check the airflow around the router\'s SFP cage.'));
}

/*
 * How full the downstream of the whole PON is, every ONU on the fibre
 * together. The OLT fills what nobody needs with idle GEM frames, five
 * bytes each, and they are addressed to nobody, so the share of a frame
 * that was not idle is what the OLT sent to somebody. An estimate:
 *
 *   - the frame header (PCBd, with the bandwidth map), GEM headers and
 *     management traffic count as used, so a PON with no traffic at all
 *     reads a little above zero;
 *   - with FEC on, the 16 parity bytes of each of the 153 code words of a
 *     frame carry nothing and are taken out first;
 *   - an OLT may send dummy frames instead of idle ones (G.984.3 lets it,
 *     to control the idle pattern); they would read as load;
 *   - downstream only: nothing here says how busy the upstream is.
 *
 * Counted against the superframe counter (one per 125 us frame, 30 bits)
 * rather than the clock, so the poll interval drops out. confd takes the
 * members from one read of /proc/odi_gpon/counters, where the driver puts
 * the frame count of the sample its totals come from (src/status.c).
 *
 * Returns { pct, mbps, of } (of: what the frames can carry, less with FEC
 * on), or null, rather than a clamped figure, on the
 * first poll and whenever the interval cannot be trusted: FEC changed, the
 * idle count went backwards (a reboot), the driver read the idle register
 * full meanwhile, the frame count moved more than the time between the
 * polls allows (the line re-locked), or the result is outside 0 to 100 %.
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
  if (pct < 0 || pct > 100) return null;
  return { pct, mbps: used * 8 * 8000 / 1e6, of: payload * 8 * 8000 / 1e6 };
}

/* The key of the PON figures in the tab history (dom.js). */
const PON_HIST_KEY = 'pon-hist';

/* The top of the chart: the smallest of these that holds the peak, so a
   quiet PON is not a flat line at the bottom of a 0 to 100 scale. */
const PON_TOPS = [2, 5, 10, 15, 20, 30, 50, 75, 100];
const ponPct = (v) => (v < 10 ? v.toFixed(1) : v.toFixed(0));

/* Where a bar stands on the whole scale, whatever the chart is zoomed to:
   the chart scales to its peak, so the colour is what says how full the
   PON was. Bands for the eye, not limits of anything. */
const ponBand = (v) => (v >= 80 ? 'hi' : v >= 50 ? 'mid' : 'lo');

/* The bars, newest on the right, one per poll interval; the last figure of
   an interval stands for it, an interval without one stays empty. The scale
   on the left is the zoom, the colour is the absolute level, and each bar
   says its time and figure: as a title, and in the line under the chart
   while the pointer is on it. */
function ponChart(hist) {
  /* Only what a share can be: a stored figure outside 0 to 100 is not ours. */
  const slots = histSlots(hist).map((p) => (p !== null && p[1] >= 0 && p[1] <= 100 ? p : null));
  const seen = slots.filter((p) => p !== null).map((p) => p[1]);
  const peak = seen.length ? Math.max(...seen) : 0;
  const top = PON_TOPS.find((t) => t >= peak) || 100;
  const fig = el('div', 'pon-chart');
  fig.setAttribute('role', 'img');
  fig.setAttribute('aria-label', seen.length
    ? `Downstream in use over the last hour: ${seen.length} readings, lowest ${ponPct(Math.min(...seen))} %, `
      + `highest ${ponPct(peak)} %, latest ${ponPct(seen[seen.length - 1])} %`
    : 'Downstream in use over the last hour: no readings yet');
  const y = el('div', 'pon-y');
  y.append(el('span', null, top + ' %'), el('span', null, top / 2 + ' %'), el('span', null, '0'));
  const bars = el('div', 'pon-bars');
  const summary = seen.length ? `highest ${ponPct(peak)} % in the last hour` : 'collecting';
  const note = el('span', 'pon-note', summary);
  for (const p of slots) {
    const b = el('i', p === null ? 'gap' : ponBand(p[1]) + (p[1] === peak ? ' peak' : ''));
    if (p !== null) {
      b.style.height = Math.max(2, Math.round((p[1] / top) * 1000) / 10) + '%';
      b.title = `${hhmm(p[0])}  \u2248 ${ponPct(p[1])} %`;
    }
    bars.append(b);
  }
  bars.addEventListener('mouseover', (e) => { note.textContent = (e.target && e.target.title) || summary; });
  bars.addEventListener('mouseleave', () => { note.textContent = summary; });
  const plot = el('div', 'pon-plot');
  plot.append(y, bars);
  const axis = el('div', 'pon-axis');
  axis.append(el('span', null, histStart()), note, el('span', null, 'now'));
  fig.append(plot, axis);
  return fig;
}

/* The section of its own: shown when the driver has the counters. The
   figure as the meters show theirs, a bar for its place between an empty
   and a full PON, and the chart. A dash outside O5, where there is no
   downstream to measure; the chart keeps what it has. */
function renderPon(st, state) {
  const block = $('#ponblock');
  const have = !!st && typeof st.ds_superframe === 'string' && typeof st.ds_gem_idle === 'string';
  block.hidden = !have;
  const host = $('#pon');
  host.textContent = '';
  if (!have) { ponLoad(null); return; }
  const live = state === 'O5';
  const load = live ? ponLoad(st) : (ponLoad(null), null);
  /* The figure as it is kept, so the bar and the chart colour it alike. */
  const kept = load ? Math.round(load.pct * 100) / 100 : null;
  const hist = histRecord(PON_HIST_KEY, load ? [kept] : null);

  const read = el('div', 'm-read');
  /* Only a figure is set in the readout face; the wait for one is said plainly. */
  read.append(el('span', load ? 'num' : 'pon-wait', load ? '\u2248 ' + ponPct(load.pct) : (live ? 'measuring' : '\u2014')));
  if (load) read.append(el('span', 'unit', '% of the downstream in use'));
  host.append(read);
  if (load) {
    host.append(el('p', 'pon-rate',
      `\u2248 ${load.mbps < 100 ? load.mbps.toFixed(1) : load.mbps.toFixed(0)} of ${load.of.toFixed(0)} Mbit/s sent to all ONUs`));
  }

  const bar = el('div', 'scale pon-bar');
  bar.style.setProperty('--n', '10');
  bar.append(el('div', 'ticks'));
  if (load) {
    const fill = el('div', 'pon-fill ' + ponBand(kept));
    fill.style.width = Math.max(0.5, Math.round(load.pct * 10) / 10) + '%';
    bar.append(fill);
  }
  const lab = el('div', 'm-ticks');
  for (const v of [0, 25, 50, 75, 100]) {
    const t = el('span', null, v + ' %');
    t.style.left = v + '%';
    lab.append(t);
  }
  host.append(bar, lab, ponChart(hist));
}

function renderStatus(raw, chip, st) {
  const s = sections(raw);
  $('#raw').textContent = raw;

  const dbm = (key) => {
    const v = num(s['pon get transceiver ' + key], /:\s*(-?\d+\.\d+)/);
    return v === null ? null : Number(v);
  };
  const rx = meter('#rx', OPTICS.rx, dbm('rx-power'));
  const tx = meter('#tx', OPTICS.tx, dbm('tx-power'));

  const state = num(s['gpon get onu-state'], /Operation State\((O\d)\)/);
  ladder(state);

  const alarms = (s['gpon get alarm-status'] || '').split('\n').filter((l) => /Alarm /.test(l));
  const asserted = alarms.filter((l) => !/clear/i.test(l));

  /*
   * Loss of signal costs you more than the fibre. The stick reports RX_LOS on
   * its SFP pins, and most routers and switches take
   * that as "this transceiver has nothing to say" and disable the Ethernet
   * side, so the management page goes with it. That is the single most common
   * "my stick is bricked" report on this hardware, and it is not a fault in
   * the stick: it is the host doing what a plain transceiver would want.
   *
   * Worth saying HERE, while the page is still reachable, because the moment
   * it applies is the moment you cannot read it.
   */
  const los = $('#losnote');
  const lost = asserted.some((l) => /\bLO[SF]\b/i.test(l));
  los.hidden = !lost;
  los.classList.toggle('bad', lost);
  if (lost) {
    los.textContent = 'Loss of signal. Note that most SFP hosts disable the '
      + 'Ethernet side of the cage while a transceiver asserts RX_LOS, so this '
      + 'page may become unreachable until the fibre is back — through the '
      + 'host, not through the stick. A media converter reaches it either way.';
  }
  const stat = (k, v, cls) => [el('dt', null, k), el('dd', cls || null, v)];
  const temp = num(s['pon get transceiver temperature'], /:\s*(-?\d+\.\d+)/);
  const volt = num(s['pon get transceiver voltage'], /:\s*(-?\d+\.\d+)/);
  const env = $('#env');
  env.textContent = '';
  env.append(
    ...stat('Temperature', temp === null ? '\u2014' : signed(Number(temp), 1) + ' \u00b0C', 'num'),
    ...stat('Supply', volt === null ? '\u2014' : Number(volt).toFixed(2) + ' V', 'num'),
    ...stat('Alarms',
      !alarms.length ? '\u2014' : asserted.length ? asserted.length + ' asserted' : 'All clear',
      asserted.length ? 'bad' : (alarms.length ? 'ok' : '')),
  );
  /* The SoC is the stick, not the optics module, so it is not in the
     transceiver rows beside its alarms. */
  $('#stickblock').hidden = !chip;
  const stick = $('#stick');
  stick.textContent = '';
  if (chip) stick.append(...stat('Chip temperature (SoC)', ...chipRow(chip)));
  chipBar(chip);
  if (asserted.length) {
    env.append(el('dt', null, 'Asserted'),
      el('dd', 'bad', asserted.map((l) => l.replace(/\s*Alarm\s*:.*$/i, '').trim()).join(', ')));
  }

  /* The header pill: the two facts that say the line is up, on every view. */
  const pill = $('#linepill');
  pill.hidden = false;
  pill.textContent = '';
  const ok = state === 'O5' && rx.verdict !== 'bad' && rx.verdict !== 'none';
  pill.className = 'linepill ' + (ok ? (rx.verdict === 'warn' ? 'warn' : 'ok') : 'bad');
  pill.append(el('i', 'dot'), el('span', null, state || 'No state'));
  if (rx.value !== null) pill.append(el('span', 'num', signed(rx.value, 1) + ' dBm'));
  pill.title = ok ? 'Registered, receive level in window' : 'Not healthy: see Status';

  renderFlow(s['mib dump counter port all'] || '');
  renderPon(st, state);

  renderOverview({
    rx, tx, state, los: lost, chip,
    temp: temp === null ? null : Number(temp),
    st: { ...(st || {}), raw_counters: s['mib dump counter port all'] || '' },
  });
}

/*
 * What the page reads off one /api/status answer, for the setup wizard: the ONU
 * state, whether LOS or LOF is asserted (the same test renderStatus uses for
 * the loss-of-signal note), and the receive power, null when diag gave no
 * reading. Pure, so make check can drive it with a raw answer.
 */
function lineFacts(raw) {
  const s = sections(raw || '');
  const v = num(s['pon get transceiver rx-power'], /:\s*(-?\d+\.\d+)/);
  const alarms = (s['gpon get alarm-status'] || '').split('\n').filter((l) => /Alarm /.test(l));
  return {
    state: num(s['gpon get onu-state'], /Operation State\((O\d)\)/),
    los: alarms.some((l) => !/clear/i.test(l) && /\bLO[SF]\b/i.test(l)),
    rx: v === null ? null : Number(v),
  };
}

export { renderStatus, lineFacts, ponLoad, OPTICS, STATES, tight };
