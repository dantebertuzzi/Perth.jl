/* Perth — lista de atalhos de teclado, compartilhada pelo gantt e pelo
 * kanban.
 *
 * Existia num alert() do gantt: sem formatação, sem tradução, e travando a
 * página enquanto estivesse aberto. O kanban tinha oito teclas globais e
 * nenhum lugar onde descobri-las — o único anunciado era o "/", escondido
 * dentro do placeholder do filtro.
 *
 * O que é compartilhado aqui é só o desenho da lista: cada aplicativo passa
 * as teclas que ele tem e abre no seu próprio contêiner (showOverlay no
 * gantt, showModal no kanban), que já são diferentes por bons motivos.
 */
(function () {
  "use strict";

  const t = (k) => (window.PerthI18n ? PerthI18n.t(k) : k);

  // `pares`: [["Ctrl+Z", "undo"], …]. A tecla é literal (não se traduz
  // "Ctrl"); a descrição passa pelo dicionário.
  function list(pares) {
    const wrap = document.createElement("div");
    wrap.className = "shortcut-list";
    for (const [tecla, descricao] of pares) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const keys = document.createElement("span");
      keys.className = "shortcut-keys";
      // "Enter / duplo clique" vira duas teclas com um "/" entre elas —
      // um <kbd> por tecla, senão a moldura engole o separador
      tecla.split(" / ").forEach((parte, i) => {
        if (i) keys.append(document.createTextNode(" / "));
        const kbd = document.createElement("kbd");
        kbd.textContent = parte;
        keys.append(kbd);
      });
      const desc = document.createElement("span");
      desc.className = "shortcut-desc";
      desc.textContent = t(descricao);
      row.append(keys, desc);
      wrap.append(row);
    }
    return wrap;
  }

  window.PerthShortcuts = { list };
})();
