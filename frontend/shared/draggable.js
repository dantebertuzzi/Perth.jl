/* Perth · widget flutuante arrastável (chat, e futuros painéis do tipo).
 *
 * Arrasta `panel` pela área `handle` (ex.: o cabeçalho), sempre clampado
 * dentro da viewport — inclusive depois de um resize da janela. Posição
 * persistida em localStorage por `storageKey`, então sobrevive a reload;
 * sem posição salva, o CSS decide onde o widget nasce (bottom/right por
 * padrão no chat — ver frontend/shared/ui.css).
 *
 * Uso:
 *   const d = PerthDraggable(panel, panel.querySelector(".chat-head"),
 *                            "perth-chat-pos");
 *   d.restore();   // aplica a posição salva, se houver
 */
"use strict";

window.PerthDraggable = function (panel, handle, storageKey) {
  function clamp(x, y) {
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const maxX = Math.max(8, window.innerWidth - w - 8);
    const maxY = Math.max(8, window.innerHeight - h - 8);
    return { x: Math.min(Math.max(x, 8), maxX), y: Math.min(Math.max(y, 8), maxY) };
  }

  function place(x, y) {
    const p = clamp(x, y);
    panel.style.left = p.x + "px";
    panel.style.top = p.y + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    return p;
  }

  function save() {
    const r = panel.getBoundingClientRect();
    try {
      localStorage.setItem(storageKey, JSON.stringify({ x: r.left, y: r.top }));
    } catch { /* localStorage indisponível (modo privado etc.): só não persiste */ }
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || "null"); }
    catch { /* posição salva corrompida: cai pro padrão do CSS */ }
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      place(saved.x, saved.y);
      return true;
    }
    return false;
  }

  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    // clique num controle do cabeçalho (ex.: fechar) não deve iniciar o arrasto
    if (ev.target.closest("button, a, input, textarea, select")) return;
    ev.preventDefault();
    const r = panel.getBoundingClientRect();
    const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    const onMove = (mv) => place(mv.clientX - dx, mv.clientY - dy);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      save();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // um resize pode deixar a posição salva fora da tela (janela encolheu);
  // reclampa em cima da posição atual, sem depender de uma nova ação do usuário
  window.addEventListener("resize", () => {
    if (panel.style.left) {
      const r = panel.getBoundingClientRect();
      place(r.left, r.top);
    }
  });

  return { restore, place };
};
