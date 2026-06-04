export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Genesis — local channel</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin:0; background:#0b0d12; color:#e6e9ef; }
  header { padding:14px 18px; border-bottom:1px solid #1d2230; display:flex; gap:12px; align-items:center; }
  header b { color:#7aa2ff; } .pill{ font-size:12px; padding:2px 9px; border-radius:999px; border:1px solid #2a3142; }
  .running{color:#7aa2ff;border-color:#2a3a6a} .awaiting{color:#ffcf6a;border-color:#5a4a1a}
  .idle{color:#8a93a6;border-color:#2a3142} .blocked{color:#ff7a7a;border-color:#5a2020} .done{color:#7ee0a5;border-color:#1f5a3a}
  #log { padding:16px 18px; display:flex; flex-direction:column; gap:10px; max-width:900px; }
  .msg { padding:10px 12px; border-radius:10px; border:1px solid #1d2230; white-space:pre-wrap; }
  .user { background:#11151f; } .agent { background:#0e1726; border-color:#1f2d4a; }
  .role { font-size:11px; opacity:.6; margin-bottom:4px; text-transform:uppercase; letter-spacing:.05em; }
  footer { position:sticky; bottom:0; padding:12px 18px; border-top:1px solid #1d2230; background:#0b0d12; display:flex; gap:8px; }
  input { flex:1; background:#11151f; border:1px solid #2a3142; color:#e6e9ef; padding:10px 12px; border-radius:8px; }
  button { background:#7aa2ff; color:#0b0d12; border:0; padding:10px 16px; border-radius:8px; font-weight:600; cursor:pointer; }
</style></head>
<body>
<header><b>Genesis</b> <span>walking skeleton · local channel</span> <span id="phase" class="pill done">idle</span></header>
<div id="log"></div>
<footer><input id="in" placeholder="message the agent…" autofocus/><button id="send">Send</button></footer>
<script>
const thread = "local";
const log = document.getElementById("log"), phase = document.getElementById("phase");
function add(role, text){ const d=document.createElement("div"); d.className="msg "+role;
  d.innerHTML='<div class="role">'+role+'</div>'+text.replace(/</g,"&lt;"); log.appendChild(d); window.scrollTo(0,document.body.scrollHeight); return d; }
function setPhase(p){ phase.className="pill "+p; phase.textContent=p; }
const ws = new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws?thread="+thread);
ws.onmessage = (e)=>{ const m=JSON.parse(e.data);
  if(m.kind==="state"){ setPhase(m.phase); }
  if(m.kind==="turn" && m.role==="agent"){ add("agent", m.text||"(no output)"); setPhase(m.phase||"done"); } };
async function send(){ const i=document.getElementById("in"); const t=i.value.trim(); if(!t)return;
  add("user",t); i.value=""; setPhase("running");
  await fetch("/message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:thread,text:t})}); }
document.getElementById("send").onclick=send;
document.getElementById("in").addEventListener("keydown",(e)=>{ if(e.key==="Enter")send(); });
</script></body></html>`;
