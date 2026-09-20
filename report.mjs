// Build the interactive report: merge adapted transcript + Jev decisions into one payload,
// then emit a self-contained HTML page whose threshold slider recomputes the decision ladder.
// Usage: node build-report.mjs <adapted.json> <decisions.json> <out.html>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , adaptedPath, decisionsPath, outPath] = process.argv;
const messages = JSON.parse(readFileSync(adaptedPath, 'utf8'));
const decisions = JSON.parse(readFileSync(decisionsPath, 'utf8'));

// pair calls with their results, in transcript order
const calls = [];
const byId = new Map();
messages.forEach((m, i) => {
  for (const tu of m.toolUses ?? []) {
    const c = { i: calls.length + 1, msg: i, tool: tu.tool, input: tu.input ?? {}, result: '', resultMsg: -1 };
    calls.push(c);
    byId.set(tu.tool_use_id, c);
  }
  for (const tr of m.toolResults ?? []) {
    const c = byId.get(tr.tool_use_id);
    if (c) { c.result = tr.text ?? ''; c.resultMsg = i; c.isError = tr.isError === true; }
  }
});

const items = decisions.map((d, n) => {
  const c = calls[n] ?? {};
  const target = c.input?.file_path ?? c.input?.command ?? c.input?.path ?? JSON.stringify(c.input ?? {}).slice(0, 120);
  return {
    n: n + 1,
    tool: d.tool,
    target: String(target).slice(0, 110),
    resultChars: (c.result ?? '').length,
    keepCall: d.keepCall,
    keepResult: d.keepResult,
    pinned: d.reason === 'pinned',
    isError: c.isError === true,
    action: d.action,
  };
});

const payload = {
  session: process.env.SESSION_LABEL || 'session',
  threshold: Number(process.env.RUN_THRESHOLD || 0.5),
  charsBefore: messages.reduce((n, m) => n + m.text.length + (m.toolResults ?? []).reduce((k, r) => k + r.text.length, 0), 0),
  items,
};

const html = page(payload);
writeFileSync(outPath, html);
console.log(JSON.stringify({ out: outPath, items: items.length, bytes: html.length }));

function page(p) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jev compaction decisions — ${p.session}</title>
<style>
 :root{--bg:#0f1115;--fg:#e8eaf0;--dim:#9aa3b2;--keep:#2ea043;--trunc:#d29922;--drop:#8b3a3a;--line:#242a35}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:20px}
 h1{font-size:17px;margin:0 0 4px}
 .sub{color:var(--dim);margin-bottom:18px}
 .controls{position:sticky;top:0;background:var(--bg);padding:12px 0;border-bottom:1px solid var(--line);z-index:5;margin-bottom:12px}
 input[type=range]{width:min(520px,90vw);vertical-align:middle}
 .stat{display:flex;gap:22px;flex-wrap:wrap;margin:10px 0 0;color:var(--dim)}
 .stat b{color:var(--fg);font-weight:600}
 table{border-collapse:collapse;width:100%;font-size:12.5px}
 th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px}
 th{color:var(--dim);font-weight:500;position:sticky;top:78px;background:var(--bg)}
 tr.keep td:first-child{border-left:3px solid var(--keep)}
 tr.truncate td:first-child{border-left:3px solid var(--trunc)}
 tr.drop td:first-child{border-left:3px solid var(--drop)}
 .tag{padding:1px 6px;border-radius:3px;font-size:11px}
 .t-keep{background:rgba(46,160,67,.18);color:#7ee787}
 .t-truncate{background:rgba(210,153,34,.18);color:#e3b341}
 .t-drop{background:rgba(139,58,58,.22);color:#f0a0a0}
 .pin{color:var(--dim)}
 .err{color:#f0a0a0}
 .legend{color:var(--dim);font-size:12px;margin:8px 0 14px}
 .seq{color:var(--dim)}
 .note{color:var(--dim);font-size:12px;margin-top:16px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body>
<h1>Jev-guided compaction — real decisions</h1>
<div class="sub">${p.session} · ${p.items.length} tool calls scored by live Jev · drag the threshold to replay the decision ladder</div>
<div class="controls">
  <label>keepThreshold <input id="thr" type="range" min="0" max="0.6" step="0.01" value="${p.threshold}"> <b id="thrv">${p.threshold.toFixed(2)}</b></label>
  <div class="stat">
    <span>kept: <b id="cKeep">0</b></span>
    <span>result truncated: <b id="cTrunc">0</b></span>
    <span>deleted: <b id="cDrop">0</b></span>
    <span>chars remaining: <b id="cChars">0</b> / ${p.charsBefore.toLocaleString()}</span>
    <span>context removed: <b id="cPct">0%</b></span>
  </div>
</div>
<div class="legend">Ladder: <span class="tag t-keep">keepResult ≥ t</span> keep call + result · otherwise <span class="tag t-truncate">keepCall ≥ t</span> keep call, truncate result · otherwise <span class="tag t-drop">deleted</span>. Pinned calls are never candidates.</div>
<table><thead><tr><th>#</th><th>tool</th><th>target</th><th>result chars</th><th>keepCall</th><th>keepResult</th><th>action</th></tr></thead>
<tbody id="rows"></tbody></table>
<div class="note">Data: one real Claude Code session, scored by the live Jev API through fast-jev-compaction's own decision logic. Probabilities are absolute, per call, which is why a threshold above ~0.2 collapses to "delete everything".<br>
Caveat: the slider re-decides using the probabilities from a single Jev run. Jev has small run-to-run variance (median keepResult moved 0.14–0.17 across runs), so moving the slider simulates the ladder on this run's answers — it is not a byte-exact replay of decisions the library would return on a fresh call.</div>
<script>
const DATA = ${JSON.stringify(p)};
const els = {thr:document.getElementById('thr'),thrv:document.getElementById('thrv'),rows:document.getElementById('rows'),
 cKeep:document.getElementById('cKeep'),cTrunc:document.getElementById('cTrunc'),cDrop:document.getElementById('cDrop'),
 cChars:document.getElementById('cChars'),cPct:document.getElementById('cPct')};
function decide(it,t){
  if(it.pinned) return 'keep';
  if(it.keepResult>=t) return 'keep';
  if(it.keepCall>=t) return 'truncate';
  return 'drop';
}
function render(){
  const t=Number(els.thr.value); els.thrv.textContent=t.toFixed(2);
  let k=0,tr=0,dr=0,chars=0;
  const frag=document.createDocumentFragment();
  for(const it of DATA.items){
    const a=decide(it,t);
    if(a==='keep'){k++;chars+=it.resultChars;}
    else if(a==='truncate'){tr++;chars+=Math.min(300,it.resultChars);}
    else dr++;
    const tr_=document.createElement('tr'); tr_.className=a;
    tr_.innerHTML='<td class="seq">'+it.n+'</td><td>'+it.tool+'</td><td title="'+esc(it.target)+'">'+esc(it.target)+(it.isError?' <span class="err">[error]</span>':'')+'</td><td>'+it.resultChars.toLocaleString()+'</td><td>'+it.keepCall.toFixed(2)+'</td><td>'+it.keepResult.toFixed(2)+'</td><td><span class="tag t-'+a+'">'+a+'</span>'+(it.pinned?' <span class="pin">pinned</span>':'')+'</td>';
    frag.appendChild(tr_);
  }
  els.rows.replaceChildren(frag);
  els.cKeep.textContent=k; els.cTrunc.textContent=tr; els.cDrop.textContent=dr;
  els.cChars.textContent=chars.toLocaleString();
  els.cPct.textContent=(100*(1-chars/DATA.charsBefore)).toFixed(1)+'%';
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
els.thr.addEventListener('input',render);
render();
</script></body></html>`;
}