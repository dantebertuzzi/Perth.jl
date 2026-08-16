/* Perth · markdown de uma linha, compartilhado pelo kanban e pelo gantt.
 *
 * Nasceu no card do kanban e agora serve também às notas de uma tarefa, que
 * são o outro lugar do Perth onde o texto é PROSA de quem escreveu — e não um
 * identificador que viaja para CSV, iCalendar, .perth.jl e para o nome da
 * barra. Por isso o nome da tarefa continua de fora: markdown num campo que
 * também ordena, é buscado e é exportado vazaria como pontuação em todos
 * esses lugares (e a busca deixaria de achar o que está escrito).
 *
 * Subconjunto de propósito: **negrito**, *itálico*, `código`, ~~riscado~~,
 * [texto](url), URL solta e #etiqueta. Sem aninhamento — é o que resolve uma
 * linha, não um renderizador completo.
 *
 * Tokenizador que só monta nós DOM. NUNCA innerHTML com texto de usuário: o
 * texto vem de outra máquina da rede, e um innerHTML aqui seria XSS de mão
 * beijada. Links restritos a http/https pelo mesmo motivo (nada de
 * javascript:).
 */
"use strict";

window.PerthInline = (function () {
  const RE = new RegExp(
    "(`([^`]+)`)" +
    "|(\\*\\*([^*]+)\\*\\*)" +
    "|(\\*([^*\\s](?:[^*]*[^*\\s])?)\\*)" +
    "|(~~([^~]+)~~)" +
    "|(\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\))" +
    "|(https?:\\/\\/[^\\s<>\"')\\]]+)" +
    "|(#[\\p{L}\\p{N}_-]+)", "gu");

  /* `opts` é o que cada aplicativo tem de diferente:
   *   linkClass / tagClass  — classes do CSS de cada um
   *   onTag(valor)          — clique na etiqueta (o kanban filtra; sem isto
   *                           a etiqueta é só um chip, sem clique)
   *   tagColor(valor)       — cor estável da etiqueta
   *   podeAbrirLink()       — falso cancela o clique (o kanban usa para não
   *                           abrir link no fim de um arrasto) */
  function render(container, text, opts = {}) {
    const s = String(text ?? "");
    let last = 0;
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(s))) {
      if (m.index > last) container.append(s.slice(last, m.index));
      if (m[1]) container.append(marca("code", m[2]));
      else if (m[3]) container.append(marca("strong", m[4]));
      else if (m[5]) container.append(marca("em", m[6]));
      else if (m[7]) container.append(marca("del", m[8]));
      else if (m[9]) container.append(link(m[10], m[11], opts));
      else if (m[12]) container.append(link(m[12], m[12], opts));
      else if (m[13]) container.append(etiqueta(m[13], opts));
      last = m.index + m[0].length;
    }
    if (last < s.length) container.append(s.slice(last));
    return container;
  }

  function marca(tag, texto) {
    const n = document.createElement(tag);
    n.textContent = texto;
    return n;
  }

  function link(rotulo, href, opts) {
    // esquema fora de http/https vira texto: um javascript: aqui seria a
    // porta de entrada que o tokenizador existe para fechar
    if (!/^https?:\/\//i.test(href)) return document.createTextNode(rotulo);
    const a = document.createElement("a");
    a.className = opts.linkClass || "inline-link";
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = rotulo;
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      if (opts.podeAbrirLink && !opts.podeAbrirLink()) e.preventDefault();
    });
    return a;
  }

  function etiqueta(valor, opts) {
    const n = document.createElement("span");
    n.className = opts.tagClass || "tag";
    n.textContent = valor;
    if (opts.tagColor) {
      const c = opts.tagColor(valor.toLowerCase());
      n.style.setProperty("--tagc", c);
      n.style.setProperty("--tagbg", c + "26");
    }
    if (opts.onTag) {
      n.title = (window.PerthI18n ? PerthI18n.t("filter by") : "filter by") + " " + valor;
      n.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onTag(valor);
      });
    }
    return n;
  }

  return { render };
})();
