// Ponte mínima com o Chrome, sem dependência nenhuma: servidor estático de
// arquivos do frontend + protocolo DevTools por WebSocket (nativo no Node 22+).
//
// Por que não jsdom: o jsdom não tem motor de layout nem cadeia real de
// eventos. Os defeitos que este arquivo cobre passaram batidos por 340
// checagens de jsdom e só apareceram no navegador — largura de campo mudando
// enquanto se digita, duplo clique que nunca virava duplo clique, rolagem que
// não levava o gráfico junto.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

const RAIZ = path.join(__dirname, "..", "..", "frontend");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
               ".png": "image/png", ".webmanifest": "application/manifest+json" };

// Serve o frontend como o servidor do Perth serviria, e responde o mínimo de
// /api para o app terminar de subir. Não é um Perth de mentira: os testes
// injetam o estado direto, do mesmo jeito que o harness de jsdom faz.
function servidorEstatico() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    if (p === "/api/rev") return json(res, { rev: 1 });
    if (p === "/api/projects") return json(res, []);
    if (p.startsWith("/api/")) return json(res, {});
    const arq = path.join(RAIZ, p.replace(/^\/+/, ""));
    if (!arq.startsWith(RAIZ) || !fs.existsSync(arq)) { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", MIME[path.extname(arq)] || "application/octet-stream");
    res.end(fs.readFileSync(arq));
  });
  const json = (res, v) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(v));
  };
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

function acharChrome() {
  const candidatos = [process.env.PERTH_CHROME,
                      "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
                      "/usr/bin/chromium", "/usr/bin/chromium-browser",
                      "/opt/google/chrome/chrome"].filter(Boolean);
  for (const c of candidatos) if (fs.existsSync(c)) return c;
  // playwright, se alguém já tiver baixado
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache)) {
      const p = path.join(cache, d, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Abre o Chrome sem interface na URL dada e devolve uma sessão CDP da aba.
async function abrirChrome(bin, url) {
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "perth-cdp-"));
  const proc = spawn(bin, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--disable-extensions", "--disable-dev-shm-usage",
    "--window-size=1400,900", "--remote-debugging-port=0",
    `--user-data-dir=${perfil}`, url,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  // a porta real sai no stderr: "DevTools listening on ws://127.0.0.1:PORTA/..."
  const porta = await new Promise((ok, erro) => {
    const t = setTimeout(() => erro(new Error("Chrome não anunciou a porta")), 20000);
    proc.stderr.on("data", (b) => {
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(String(b));
      if (m) { clearTimeout(t); ok(Number(m[1])); }
    });
    proc.on("exit", (c) => { clearTimeout(t); erro(new Error("Chrome saiu: " + c)); });
  });

  let alvo = null;
  for (let i = 0; i < 60 && !alvo; i++) {
    try {
      const lista = await (await fetch(`http://127.0.0.1:${porta}/json/list`)).json();
      alvo = lista.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch { /* ainda subindo */ }
    if (!alvo) await espera(100);
  }
  if (!alvo) throw new Error("nenhuma aba encontrada no Chrome");

  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok, erro) => { ws.onopen = ok; ws.onerror = () => erro(new Error("WS falhou")); });

  let seq = 0;
  const pendentes = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pendentes.get(msg.id);
    if (!p) return;
    pendentes.delete(msg.id);
    msg.error ? p.erro(new Error(msg.error.message)) : p.ok(msg.result);
  };
  const enviar = (method, params = {}) => new Promise((ok, erro) => {
    const id = ++seq;
    pendentes.set(id, { ok, erro });
    ws.send(JSON.stringify({ id, method, params }));
  });

  // Avalia no contexto da página e devolve o valor. Promessas são aguardadas,
  // então dá para escrever `await` no trecho avaliado.
  const avaliar = async (codigo) => {
    const r = await enviar("Runtime.evaluate", {
      expression: `(async () => { ${codigo} })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error("na página: " + (r.exceptionDetails.exception?.description ||
                                       r.exceptionDetails.text));
    }
    return r.result.value;
  };

  const fechar = () => { try { ws.close(); } catch {} proc.kill("SIGKILL");
                         try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {} };

  return { enviar, avaliar, fechar, espera };
}

module.exports = { servidorEstatico, acharChrome, abrirChrome, espera };
