/* Perth · presença compartilhada (multiplayer).
 *
 * Réplica exata da mecânica do Perth kanban, extraída como módulo genérico:
 *   - WebSocket em /ws com reconexão exponencial + heartbeat
 *   - cada cliente publica seu cursor como ÂNCORA (elemento + posição
 *     fracionária dentro dele), e cada janela resolve a âncora na sua
 *     própria geometria — funciona com zoom/scroll/tamanhos diferentes
 *   - cursores etiquetados com nome/IP (estilo pareação do VS Code),
 *     chips de máquinas conectadas na menubar e indicador de conexão
 *
 * Uso (ver frontend/app.js do gantt):
 *   PerthPresence.connect({
 *     captureAnchor(e) -> anchor | null   // ponto -> âncora (específico do app)
 *     resolveAnchor(a) -> {x,y} | null    // âncora -> ponto  (específico do app)
 *     onRev(rev)                          // servidor avisou mudança de dados
 *   });
 *
 * O protocolo (init/join/leave/peer/presence/hello/hb) é o mesmo do kanban,
 * então o kanban pode migrar para este módulo sem mudança de servidor.
 */
"use strict";

window.PerthPresence = (function () {
  // Paleta de peers: cores Julia + complementares — espelha NCOLORS do server
  const PALETTE = ["#9558b2", "#389826", "#4063d8", "#b58900",
                   "#cb3c33", "#2aa198", "#d33682", "#6c71c4"];

  const KEY = new URLSearchParams(location.search).get("key") || "";
  const keyQS = (sep = "?") => (KEY ? `${sep}key=${encodeURIComponent(KEY)}` : "");

  const st = {
    me: null,                 // {id, ip, name, color, host}
    peers: new Map(),         // id -> {id, ip, name, color, presence}
    ws: null,
    lastMsgAt: 0,
    retry: 0,
    opts: null,
  };

  const $ = (sel) => document.querySelector(sel);

  /* ------------------------------------------------------------- ws */

  function connect(opts) {
    st.opts = opts || {};
    openWS();
    // watchdog: heartbeat do servidor chega a cada 30s; 75s sem nada = morto
    setInterval(() => {
      if (st.ws && st.ws.readyState === WebSocket.OPEN &&
          Date.now() - st.lastMsgAt > 75000) st.ws.close();
    }, 15000);
    document.addEventListener("pointermove", trackPointer);
    document.addEventListener("pointerleave", () => {
      myAnchor = null;
      presenceDirty = true;
    });
    setInterval(() => { if (presenceDirty) sendPresenceNow(); }, 60);
    return api;
  }

  function openWS() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    st.ws = new WebSocket(`${proto}://${location.host}/ws${keyQS()}`);
    st.ws.onopen = () => {
      st.retry = 0;
      setConn(true);
      const name = localStorage.getItem("perth-name") || "";
      send({ type: "hello", name });
    };
    st.ws.onmessage = (ev) => {
      st.lastMsgAt = Date.now();
      handle(JSON.parse(ev.data));
    };
    st.ws.onclose = () => {
      setConn(false);
      st.peers.clear();
      renderPeers();
      renderCursors();
      // backoff exponencial com teto de 15s
      setTimeout(openWS, Math.min(15000, 500 * 2 ** st.retry++));
    };
    st.ws.onerror = () => st.ws.close();
  }

  function send(obj) {
    if (st.ws && st.ws.readyState === WebSocket.OPEN)
      st.ws.send(JSON.stringify(obj));
  }

  function handle(msg) {
    switch (msg.type) {
      case "init":
        st.me = msg.you;
        st.peers.clear();
        for (const p of msg.peers || [])
          if (p.id !== msg.you.id) st.peers.set(p.id, { ...p, presence: null });
        renderPeers();
        renderCursors();
        break;
      case "join":
        st.peers.set(msg.peer.id, { ...msg.peer, presence: null });
        renderPeers();
        break;
      case "leave":
        st.peers.delete(msg.id);
        renderPeers();
        renderCursors();
        break;
      case "peer": {   // alguém trocou de nome
        if (st.me && msg.peer.id === st.me.id) { st.me = { ...st.me, ...msg.peer }; }
        else {
          const prev = st.peers.get(msg.peer.id);
          st.peers.set(msg.peer.id, { ...msg.peer, presence: prev?.presence ?? null });
        }
        renderPeers();
        renderCursors();
        break;
      }
      case "presence": {
        const p = st.peers.get(msg.from);
        if (!p) break;
        p.presence = msg.state;
        renderCursors();
        break;
      }
      case "rev":      // dados mudaram no servidor: o app decide como recarregar
        st.opts.onRev && st.opts.onRev(msg.rev);
        break;
      case "denied":
        setConn(false, "access denied");
        try { st.ws.onclose = null; st.ws.close(); } catch { /* já fechado */ }
        break;
      case "hb":
        break;   // lastMsgAt já registrado acima
    }
  }

  /* -------------------------------------------------- publicação */

  let myAnchor = null;
  let presenceDirty = false;

  function trackPointer(e) {
    const a = st.opts.captureAnchor ? st.opts.captureAnchor(e) : null;
    myAnchor = a;
    presenceDirty = true;
  }

  function sendPresenceNow() {
    send({ type: "presence", state: { anchor: myAnchor } });
    presenceDirty = false;
  }

  /* -------------------------------------------------- renderização */

  const peerColor = (p) => PALETTE[p.color % PALETTE.length];
  const peerLabel = (p) => (p.name && p.name !== p.ip ? p.name : p.ip);

  function setConn(live, label) {
    const conn = $("#conn");
    if (!conn) return;
    conn.classList.toggle("live", live);
    const l = $("#conn-label");
    if (!l) return;
    const txt = label || (live ? "live" : "reconnecting…");
    l.textContent = window.PerthI18n ? PerthI18n.t(txt) : txt;
  }

  function renderPeers() {
    const box = $("#peers");
    if (!box) return;
    box.textContent = "";
    const all = st.me
      ? [{ ...st.me, __me: true }, ...st.peers.values()]
      : [...st.peers.values()];
    for (const p of all) {
      const chip = document.createElement("span");
      chip.className = "peer-chip" + (p.__me ? " me" : "");
      chip.style.background = peerColor(p);
      chip.textContent = peerLabel(p).replace(/^\D*/, "").charAt(0) ||
                         peerLabel(p).charAt(0).toUpperCase();
      chip.title = (p.__me ? "you — " : "") + peerLabel(p) + " · " + p.ip;
      box.append(chip);
    }
  }

  function renderCursors() {
    const layer = $("#cursors");
    if (!layer) return;
    layer.textContent = "";
    for (const p of st.peers.values()) {
      const pos = st.opts.resolveAnchor
        ? st.opts.resolveAnchor(p.presence?.anchor) : null;
      if (!pos) continue;
      const c = document.createElement("div");
      c.className = "cursor";
      c.style.setProperty("--peer", peerColor(p));
      c.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      c.innerHTML =
        `<svg width="15" height="15" viewBox="0 0 24 24">` +
        `<path d="M4 2l16 8.5-7 1.7L9 20z" fill="${peerColor(p)}" ` +
        `stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
      const label = document.createElement("div");
      label.className = "cursor-label";
      const lbl = peerLabel(p);
      if (lbl !== p.ip) {
        label.textContent = lbl + " ";
        const ip = document.createElement("span");
        ip.className = "cursor-ip";
        ip.textContent = "· " + p.ip;
        label.append(ip);
      } else {
        label.textContent = p.ip;
      }
      label.title = p.ip;
      c.append(label);
      layer.append(c);
    }
  }

  /* -------------------------------------------------- API pública */

  const api = {
    setName(name) {
      localStorage.setItem("perth-name", name || "");
      send({ type: "hello", name: name || "" });
    },
    me: () => st.me,
    peers: () => [...st.peers.values()],
    // reancorar cursores em scroll/resize do app
    refreshCursors: renderCursors,
    keyQS,
  };

  return { connect, ...api };
})();
