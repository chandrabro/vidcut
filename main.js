import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const $ = (id) => document.getElementById(id);
const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const TRANS = ['fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown', 'circleopen', 'circleclose', 'radial', 'pixelize', 'smoothleft', 'zoomin', 'squeezeh', 'random'];
const pad = (n) => String(n).padStart(2, '0');
function fmt(s, sep = ':') { s = Math.round(s); return pad(Math.floor(s / 3600)) + sep + pad(Math.floor((s % 3600) / 60)) + sep + pad(s % 60); }
const extOf = (f) => (f.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
function fillTrans(sel, withNone) {
  sel.innerHTML = (withNone ? '<option value="none">None (hard cut)</option>' : '') + TRANS.map((t) => `<option value="${t}">${t}</option>`).join('');
  sel.value = withNone ? 'fade' : 'fade';
}
fillTrans($('trans'), false);
fillTrans($('strans'), true);

// ---- Tabs ----
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  ['split', 'show'].forEach((t) => ($('tab-' + t).hidden = t !== b.dataset.tab));
  document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));

// ---- Shared FFmpeg engine ----
let ff = null, progCb = null, logs = [];
async function engine(statusEl) {
  if (ff) return ff;
  const f = new FFmpeg();
  f.on('progress', (e) => progCb && progCb(e));
  f.on('log', ({ message }) => { logs.push(message); if (logs.length > 8) logs.shift(); });
  statusEl.textContent = 'Loading video engine (first time only)...';
  await f.load({
    coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  ff = f;
  return ff;
}
async function mount(dir, files) {
  try { await ff.unmount(dir); } catch {}
  try { await ff.deleteDir(dir); } catch {}
  await ff.createDir(dir);
  await ff.mount('WORKERFS', { files }, dir); // reads files lazily, no big memory copy
}
async function run(args) {
  logs = [];
  const code = await ff.exec(args);
  if (code !== 0) throw new Error('FFmpeg failed. ' + (logs.filter((l) => l.trim()).slice(-2).join(' | ') || ''));
}
function showFull(box, blob, name) {
  const url = URL.createObjectURL(blob);
  box.innerHTML = `<video controls src="${url}"></video><p><a href="${url}" download="${name}"><button>Download ${name}</button></a></p>`;
}

// Join several inputs (video labels v0..vN-1) with xfade or concat. Returns filter text ending in [vout].
function joinGraph(lens, trans, d) {
  const n = lens.length;
  if (n === 1) return ';[v0]null[vout]';
  if (trans === 'none') return ';' + lens.map((_, i) => `[v${i}]`).join('') + `concat=n=${n}:v=1:a=0[vout]`;
  let g = '', acc = lens[0], prev = 'v0';
  for (let i = 1; i < n; i++) {
    const t = trans === 'random' ? TRANS[Math.floor(Math.random() * (TRANS.length - 1))] : trans;
    const out = i === n - 1 ? 'vout' : `x${i}`;
    g += `;[${prev}][v${i}]xfade=transition=${t}:duration=${d}:offset=${(acc - d).toFixed(3)}[${out}]`;
    acc += lens[i] - d; prev = out;
  }
  return g;
}
const totalLen = (lens, trans, d) => lens.reduce((a, b) => a + b, 0) - (trans === 'none' ? 0 : (lens.length - 1) * d);

// ---- Minimal ZIP writer (store only, no compression; video is already compressed) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildZip(entries) {
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const chunks = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, e.crc, true); lh.setUint32(18, e.size, true); lh.setUint32(22, e.size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    chunks.push(lh.buffer, name, e.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, e.crc, true); ch.setUint32(20, e.size, true); ch.setUint32(24, e.size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + e.size;
  }
  const cdSize = central.reduce((n, b) => n + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
}
// ---- Split & Transitions tab ----
let file = null, duration = 0, busy = false, zipEntries = [], zipName = 'parts.zip';
const mode = () => document.querySelector('input[name=mode]:checked').value;

function plan(total, interval, overlap) {
  const parts = [];
  let start = 0;
  while (start < total) {
    const end = Math.min(start + interval, total);
    parts.push({ start, end });
    if (end >= total) break;
    start = end - overlap;
  }
  return parts;
}
function getParts(interval, overlap, td) {
  const join = mode() === 'join';
  const parts = plan(duration, interval, join ? 0 : overlap);
  if (join && parts.length > 1 && parts[parts.length - 1].end - parts[parts.length - 1].start < td * 2) {
    parts[parts.length - 2].end = duration; parts.pop(); // a tiny last piece is merged into the one before
  }
  return parts;
}
function readInputs() {
  const interval = parseFloat($('interval').value) * 60;
  const overlap = parseFloat($('overlap').value) || 0;
  const td = parseFloat($('tdur').value);
  let err = '';
  if (!(interval > 0)) err = 'Enter an interval greater than 0.';
  else if (mode() === 'cut') { if (overlap < 0) err = 'Overlap cannot be negative.'; else if (overlap >= interval) err = 'Overlap must be shorter than the interval.'; }
  else if (!(td > 0 && td * 2 <= interval)) err = 'Transition length must be shorter than half the interval.';
  return { interval, overlap, td, err };
}
function renderPlan() {
  if (!duration) return;
  const { interval, overlap, td, err } = readInputs();
  $('err').hidden = !err; $('err').textContent = err;
  $('go').disabled = !!err || busy;
  const box = $('plan'); box.innerHTML = '';
  if (err) return;
  const parts = getParts(interval, overlap, td);
  const wrap = document.createElement('div'); wrap.className = 'tl';
  parts.forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'seg';
    row.innerHTML = `<i style="left:${(p.start / duration) * 100}%;width:${((p.end - p.start) / duration) * 100}%"></i>`;
    if (i > 0) { const o = parts[i - 1].end - p.start; row.innerHTML += `<b style="left:${(p.start / duration) * 100}%;width:${(o / duration) * 100}%"></b>`; }
    wrap.appendChild(row);
  });
  const text = document.createElement('p'); text.className = 'note';
  const join = mode() === 'join';
  text.textContent = join
    ? `${parts.length} sections, ${parts.length - 1} transitions. Output length about ${fmt(duration - (parts.length - 1) * td)}. ${parts.length > 8 ? 'Many sections on a long video will be very slow.' : ''}`
    : `${parts.length} parts: ` + parts.map((p, i) => `${i + 1}) ${fmt(p.start)}-${fmt(p.end)}`).join('   ');
  box.append(wrap, text);
}
function syncMode() {
  const join = mode() === 'join';
  $('ovBox').hidden = join; $('joinOpts').hidden = !join; $('preciseBox').hidden = join;
  $('go').textContent = join ? 'Create full video with transitions' : 'Split video';
  renderPlan();
}
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));
['interval', 'overlap', 'tdur'].forEach((id) => $(id).addEventListener('input', renderPlan));

function setFile(f) {
  if (!f) return;
  file = f; $('dropText').textContent = f.name;
  const url = URL.createObjectURL(f), v = document.createElement('video');
  v.preload = 'metadata';
  v.onloadedmetadata = () => {
    duration = v.duration; URL.revokeObjectURL(url);
    $('info').hidden = false; $('info').textContent = `Length ${fmt(duration)}, size ${(f.size / 1048576).toFixed(0)} MB`;
    $('settings').hidden = false; $('out').innerHTML = ''; $('full').innerHTML = ''; renderPlan();
  };
  v.onerror = () => { $('info').hidden = false; $('info').textContent = "This browser can't read that video's length. Try an MP4 or WebM file."; };
  v.src = url;
}
$('file').addEventListener('change', (e) => setFile(e.target.files[0]));
const drop = $('drop');
['dragover', 'dragenter'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('on'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('on'); }));
drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));

async function doCut(interval, overlap, inName, base) {
  const precise = $('precise').checked, ext = extOf(file), outExt = precise ? 'mp4' : ext;
  const parts = plan(duration, interval, overlap);
  let cur = 0;
  progCb = ({ progress }) => ($('bar').value = Math.min(1, (cur + Math.max(0, Math.min(1, progress))) / parts.length));
  for (let i = 0; i < parts.length; i++) {
    cur = i;
    const p = parts[i];
    $('status').textContent = `Cutting part ${i + 1} of ${parts.length}...`;
    const outName = `part${i + 1}.${outExt}`;
    const args = ['-ss', String(p.start), '-i', `/in/${inName}`, '-t', String(p.end - p.start)];
    if (precise) args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac'); else args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
    await run([...args, outName]);
    const data = await ff.readFile(outName);
    await ff.deleteFile(outName);
    const blob = new Blob([data], { type: 'video/' + outExt }), url = URL.createObjectURL(blob);
    const dl = `${base}_part${i + 1}_${fmt(p.start, '-')}_to_${fmt(p.end, '-')}.${outExt}`;
    const li = document.createElement('li');
    li.innerHTML = `<span>Part ${i + 1}: ${fmt(p.start)} - ${fmt(p.end)}</span>`;
    const a = document.createElement('a'); a.href = url; a.download = dl; a.textContent = 'Download';
    li.appendChild(a); $('out').appendChild(li);
    zipEntries.push({ name: dl, blob, crc: crc32(data), size: data.length });
  }
  zipName = `${base}_parts.zip`; $('zip').hidden = false;
  $('status').textContent = 'Done. Download each part, or all at once as a ZIP.';
}

async function doJoin(interval, td, inName, base) {
  const parts = getParts(interval, 0, td);
  if (parts.length < 2) throw new Error('The video is shorter than two intervals. Use a smaller interval.');
  const H = $('jh').value, trans = $('trans').value, lens = parts.map((p) => p.end - p.start);
  const outLen = totalLen(lens, trans, td), n = parts.length;
  progCb = ({ time }) => ($('bar').value = Math.min(1, time / 1e6 / outLen));
  const attempt = async (withAudio) => {
    const args = [];
    parts.forEach((p) => args.push('-ss', String(p.start), '-t', String(p.end - p.start), '-i', `/in/${inName}`));
    let g = parts.map((_, i) => `[${i}:v]scale=-2:${H},setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`).join(';');
    g += joinGraph(lens, trans, td);
    const map = ['-map', '[vout]'];
    if (withAudio) {
      g += ';' + parts.map((_, i) => `[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`).join(';');
      let prev = 'a0';
      for (let i = 1; i < n; i++) { const o = i === n - 1 ? 'aout' : `ac${i}`; g += `;[${prev}][a${i}]acrossfade=d=${td}[${o}]`; prev = o; }
      map.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
    }
    await run([...args, '-filter_complex', g, ...map, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'out.mp4']);
  };
  $('status').textContent = 'Rendering full video with transitions. This can take a long time...';
  try { await attempt(true); } catch { $('status').textContent = 'Retrying without audio...'; await attempt(false); }
  const data = await ff.readFile('out.mp4'); await ff.deleteFile('out.mp4');
  showFull($('full'), new Blob([data], { type: 'video/mp4' }), `${base}_transitions.mp4`);
  $('status').textContent = 'Done.';
}

$('go').addEventListener('click', async () => {
  const { interval, overlap, td, err } = readInputs();
  if (err || !file) return;
  busy = true; $('go').disabled = true;
  $('out').innerHTML = ''; $('full').innerHTML = ''; $('zip').hidden = true; zipEntries = [];
  $('err').hidden = true; $('bar').hidden = false; $('bar').value = 0;
  try {
    await engine($('status'));
    const inName = 'input.' + extOf(file), base = file.name.replace(/\.[^.]+$/, '');
    await mount('/in', [new File([file], inName)]);
    if (mode() === 'join') await doJoin(interval, td, inName, base); else await doCut(interval, overlap, inName, base);
    $('bar').value = 1;
  } catch (e) {
    console.error(e); $('status').textContent = '';
    $('err').hidden = false; $('err').textContent = e.message || 'Something went wrong. Try a smaller file.';
  } finally { busy = false; $('go').disabled = false; }
});
$('zip').addEventListener('click', () => {
  if (!zipEntries.length) return;
  const url = URL.createObjectURL(buildZip(zipEntries));
  const a = document.createElement('a'); a.href = url; a.download = zipName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

// ---- Slideshow Maker tab ----
let items = [], seq = 0;
const defDur = () => parseFloat($('defdur').value) > 0 ? parseFloat($('defdur').value) : 5;
const itemLen = (it) => (it.kind === 'video' ? it.vdur : it.dur ?? defDur());

function sortItems() {
  const m = $('sort').value;
  items.sort((a, b) => m === 'added' ? a.seq - b.seq : (m === 'asc' ? 1 : -1) * a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' }));
}
function renderItems() {
  sortItems();
  const ul = $('items'); ul.innerHTML = '';
  items.forEach((it, i) => {
    const li = document.createElement('li');
    const thumb = it.kind === 'image' ? `<img class="thumb" src="${it.url}" alt="">` : '<span class="thumb">VIDEO</span>';
    const len = it.kind === 'image'
      ? `<input class="dur" type="number" min="0.5" step="0.5" placeholder="${defDur()}" value="${it.dur ?? ''}" aria-label="Seconds for ${it.file.name}"> s`
      : `<span class="note">${fmt(it.vdur)}</span>`;
    li.innerHTML = `<span class="note">${i + 1}</span>${thumb}<span class="nm" title="${it.file.name}">${it.file.name}</span>${len}<button class="x" aria-label="Remove">x</button>`;
    const inp = li.querySelector('.dur');
    if (inp) inp.addEventListener('input', () => { const v = parseFloat(inp.value); it.dur = v > 0 ? v : null; });
    li.querySelector('.x').addEventListener('click', () => { items = items.filter((x) => x !== it); renderItems(); });
    ul.appendChild(li);
  });
}
$('sort').addEventListener('change', renderItems);
$('defdur').addEventListener('input', () => document.querySelectorAll('#items .dur').forEach((e) => (e.placeholder = defDur())));

function videoLen(url) {
  return new Promise((res) => {
    const v = document.createElement('video'); v.preload = 'metadata';
    v.onloadedmetadata = () => res(v.duration); v.onerror = () => res(0); v.src = url;
  });
}
$('media').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    const kind = f.type.startsWith('video') ? 'video' : f.type.startsWith('image') ? 'image' : null;
    if (!kind) continue;
    const url = URL.createObjectURL(f);
    const it = { file: f, kind, url, seq: seq++, dur: null, vdur: 0 };
    if (kind === 'video') { it.vdur = await videoLen(url); if (!(it.vdur > 0)) continue; }
    items.push(it);
  }
  e.target.value = '';
  renderItems();
});

$('sgo').addEventListener('click', async () => {
  const bar = $('sbar'), st = $('sstatus'), er = $('serr');
  er.hidden = true; $('sfull').innerHTML = '';
  if (!items.length) { er.hidden = false; er.textContent = 'Add at least one image or video clip.'; return; }
  $('sgo').disabled = true; bar.hidden = false; bar.value = 0;
  try {
    await engine(st);
    const [W, H] = $('size').value.split('x').map(Number);
    const trans = $('strans').value;
    const lens = items.map(itemLen);
    const d = trans === 'none' ? 0 : Math.min(parseFloat($('stdur').value) || 1, Math.min(...lens) / 2);
    const T = totalLen(lens, trans, d);
    const files = [], args = [];
    items.forEach((it, i) => {
      const name = `m${i}.${extOf(it.file)}`;
      files.push(new File([it.file], name));
      if (it.kind === 'image') args.push('-loop', '1', '-framerate', '30', '-t', String(lens[i]), '-i', `/m/${name}`);
      else args.push('-t', String(lens[i]), '-i', `/m/${name}`);
    });
    const audio = [];
    const bgF = $('bg').files[0], voF = $('vo').files[0];
    if (bgF) { files.push(new File([bgF], 'bg.' + extOf(bgF))); args.push('-stream_loop', '-1', '-i', `/m/bg.${extOf(bgF)}`); audio.push(['bg', $('bgv').value / 100]); }
    if (voF) { files.push(new File([voF], 'vo.' + extOf(voF))); args.push('-i', `/m/vo.${extOf(voF)}`); audio.push(['vo', $('vov').value / 100]); }
    await mount('/m', files);

    let g = items.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`).join(';');
    g += joinGraph(lens, trans, d);
    const map = ['-map', '[vout]'];
    if (audio.length) {
      const fmtA = 'aformat=sample_rates=44100:channel_layouts=stereo';
      audio.forEach(([, vol], k) => (g += `;[${items.length + k}:a]volume=${vol},${fmtA}[s${k}]`));
      const mixed = audio.length === 2 ? ';[s0][s1]amix=inputs=2:duration=longest:normalize=0[am]' : ';[s0]anull[am]';
      g += mixed + `;[am]atrim=0:${T.toFixed(3)},afade=t=out:st=${Math.max(0, T - 2).toFixed(3)}:d=2[aout]`;
      map.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
    }
    progCb = ({ time }) => (bar.value = Math.min(1, time / 1e6 / T));
    st.textContent = `Rendering ${fmt(T)} of video. This can take a while...`;
    await run([...args, '-filter_complex', g, ...map, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', T.toFixed(3), 'slideshow.mp4']);
    const data = await ff.readFile('slideshow.mp4'); await ff.deleteFile('slideshow.mp4');
    showFull($('sfull'), new Blob([data], { type: 'video/mp4' }), 'slideshow.mp4');
    bar.value = 1; st.textContent = 'Done.';
  } catch (e) {
    console.error(e); st.textContent = '';
    er.hidden = false; er.textContent = e.message || 'Something went wrong. Try fewer or smaller files.';
  } finally { $('sgo').disabled = false; }
});
