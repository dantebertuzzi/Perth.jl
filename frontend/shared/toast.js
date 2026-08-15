/* Perth — avisos passageiros, compartilhados pelo gantt e pelo kanban.
 *
 * Este componente não nasceu do zero: o kanban já tinha o dele (showToast,
 * #toasts, a notificação de presença colorida por máquina) enquanto o gantt
 * reportava toda falha por alert(). Em vez de virarem dois sistemas de aviso
 * no mesmo produto, viraram um — o do kanban, generalizado e trazido para
 * shared/.
 *
 * O alert() que ficou para trás tinha três defeitos de uma vez: trava a
 * página inteira até alguém clicar, não tem formatação nem tema, e o texto
 * dos botões do navegador não passa pelo dicionário. O que ele fazia de
 * certo era não deixar a falha passar despercebida — por isso o aviso de
 * erro dura o dobro do informativo e traz botão de fechar, em vez de piscar
 * e sumir.
 *
 * Canto inferior ESQUERDO: o kanban usava o direito, que é onde o painel de
 * chat abre nos dois aplicativos — com o chat aberto, um tapava o outro.
 */
(function () {
  "use strict";

  const T = (k) => (window.PerthI18n ? PerthI18n.t(k) : k);
  const TEMPO = { error: 8000, info: 4200, peer: 4200 };
  const MAX = 4;                    // além disso o mais antigo sai

  function pilha() {
    let el = document.getElementById("perth-toasts");
    if (!el) {
      el = document.createElement("div");
      el.id = "perth-toasts";
      el.className = "toast-stack";
      // anuncia para leitor de tela sem roubar o foco — o oposto do alert()
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    return el;
  }

  function mostrar(texto, tipo) {
    const msg = String(texto == null ? "" : texto).trim();
    if (!msg) return null;
    const wrap = pilha();

    const box = document.createElement("div");
    box.className = "toast toast-" + tipo;
    box.setAttribute("role", tipo === "error" ? "alert" : "status");

    const span = document.createElement("span");
    span.className = "toast-text";
    span.textContent = msg;

    const x = document.createElement("button");
    x.className = "toast-close";
    x.textContent = "✕";
    x.title = T("Close");
    x.setAttribute("aria-label", T("Close"));

    const sair = () => {
      if (!box.isConnected) return;
      box.classList.add("leaving");
      // deixa a transição correr; remove mesmo se o navegador não animar
      setTimeout(() => box.remove(), 200);
    };
    x.addEventListener("click", sair);

    box.append(span, x);
    wrap.appendChild(box);
    while (wrap.children.length > MAX) wrap.firstElementChild.remove();

    setTimeout(sair, TEMPO[tipo] || TEMPO.info);
    return box;
  }

  /* Presença: "<nome> moveu um card". O nome vem em negrito na cor da
     máquina (a mesma do cursor remoto), então é o único aviso que carrega
     marcação — daí ter função própria em vez de um texto pronto. */
  function presenca(nome, texto, cor, titulo) {
    const box = mostrar(texto, "peer");
    if (!box) return null;
    if (cor) box.style.setProperty("--peer", cor);
    const b = document.createElement("b");
    b.textContent = nome;
    if (titulo) b.title = titulo;
    const span = box.querySelector(".toast-text");
    span.textContent = " " + span.textContent;
    span.prepend(b);
    return box;
  }

  window.PerthToast = {
    error: (texto) => mostrar(texto, "error"),
    info: (texto) => mostrar(texto, "info"),
    peer: presenca,
    // usado no teste e por quem quiser limpar a tela (troca de projeto)
    clear: () => document.getElementById("perth-toasts")?.replaceChildren(),
  };
})();
