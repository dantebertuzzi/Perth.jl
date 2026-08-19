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
 * renderBlocks() é a CAMADA DE BLOCO por cima disto, e não um segundo
 * analisador: ela só decide onde cada linha entra (cerca de código, item de
 * lista, parágrafo) e manda cada linha de prosa de volta para render(). É o
 * que o corpo de um card precisa e a linha de um card não — ver a caixa de
 * diálogo em frontend/kanban/app.js.
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

  /* ------------------------------------------------ camada de bloco
   *
   * Blocos de propósito, na mesma medida do resto: cerca de código (```),
   * lista com "- " ou "* ", lista numerada, e parágrafo. Linha em branco
   * separa parágrafos.
   *
   * TÍTULOS FICAM DE FORA de propósito. "# " serviria, mas "#" já é
   * etiqueta neste tokenizador, e a diferença entre um título e uma
   * etiqueta passaria a ser um espaço — o tipo de regra que ninguém lembra
   * e todo mundo tropeça. Quem quer destaque tem **negrito**.
   *
   * O conteúdo de uma cerca NÃO passa pelo tokenizador de linha: dentro de
   * um bloco de código, `crase` e *asterisco* são código, não marcação.
   */
  function renderBlocks(container, text, opts = {}) {
    const linhas = String(text ?? "").split(/\r?\n/);
    let i = 0;
    while (i < linhas.length) {
      const linha = linhas[i];

      if (/^\s*```/.test(linha)) {
        // a cerca sem fechamento vai até o fim: quem está DIGITANDO passa
        // por esse estado a cada bloco novo, e o texto não pode sumir
        const lang = linha.replace(/^\s*```/, "").trim();
        const corpo = [];
        i++;
        while (i < linhas.length && !/^\s*```\s*$/.test(linhas[i])) corpo.push(linhas[i++]);
        i++;                                   // consome a cerca de fechamento
        const pre = document.createElement("pre");
        pre.className = opts.codeClass || "md-code";
        const code = document.createElement("code");
        if (lang) code.dataset.lang = lang;
        code.textContent = corpo.join("\n");  // textContent, nunca innerHTML
        pre.append(code);
        container.append(pre);
        continue;
      }

      const item = linha.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
      if (item) {
        const ordenada = !/^[-*]$/.test(item[1]);
        const lista = document.createElement(ordenada ? "ol" : "ul");
        lista.className = opts.listClass || "md-list";
        while (i < linhas.length) {
          const m = linhas[i].match(/^\s*([-*]|\d+\.)\s+(.*)$/);
          if (!m || (!/^[-*]$/.test(m[1])) !== ordenada) break;
          render(lista.appendChild(document.createElement("li")), m[2], opts);
          i++;
        }
        container.append(lista);
        continue;
      }

      if (!linha.trim()) { i++; continue; }

      // parágrafo: linhas seguidas até a próxima em branco (ou até um bloco
      // começar). A quebra de linha de dentro é preservada — o texto sai do
      // jeito que foi digitado, que é o que um campo de texto promete.
      const p = document.createElement("p");
      p.className = opts.paraClass || "md-p";
      let primeira = true;
      while (i < linhas.length && linhas[i].trim() &&
             !/^\s*```/.test(linhas[i]) &&
             !/^\s*([-*]|\d+\.)\s+/.test(linhas[i])) {
        if (!primeira) p.append(document.createElement("br"));
        render(p, linhas[i], opts);
        primeira = false;
        i++;
      }
      container.append(p);
    }
    return container;
  }

  return { render, renderBlocks };
})();
