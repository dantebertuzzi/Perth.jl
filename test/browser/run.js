// Perth · testes de geometria e de evento em navegador de verdade.
//
// A suíte de jsdom (test/frontend/run.js) cobre lógica e DOM, mas não tem
// motor de layout nem cadeia real de eventos de entrada. Todos os defeitos
// verificados aqui passaram por ela sem falhar — e apareceram na tela:
//
//   · a faixa PERT mudava de largura a cada tecla digitada;
//   · duplo clique na barra nunca virava duplo clique (preventDefault no
//     pointerdown mata o click, e re-renderizar no pointerup mata o par);
//   · a busca acendia o nome e deixava a barra fora da vista.
//
// Sem dependência: Chrome sem interface, falando o protocolo DevTools por
// WebSocket (nativo no Node 22+). Sem navegador na máquina, o arquivo se
// declara pulado e sai com 0 — não é teste que se finge de verde, é teste que
// diz que não rodou.
"use strict";

const { servidorEstatico, acharChrome, abrirChrome, espera } = require("./cdp");

let falhas = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else { falhas++; console.error("  ✗ " + msg); }
};

// Projeto de teste injetado direto no estado, como o harness de jsdom faz.
const SEMENTE = `
  const mk = (id, name, start, duration, extra) => Object.assign({
    id, name, start, duration, assignee: "", progress: 0, dependencies: [],
    color: "", notes: "", milestone: false, parent: "", cost: 0,
    baseline_start: null, baseline_duration: 0, deadline: null, pinned: false,
    optimistic: 0, most_likely: 0, pessimistic: 0 }, extra || {});
  hideWelcome();
  state.current = { id: "p1", name: "Obra", tasks: [
    mk("t1", "Fundação",   "2026-03-02", 5, { optimistic: 5, most_likely: 8, pessimistic: 20 }),
    mk("t2", "Escavação",  "2026-03-10", 8),
    mk("t3", "Telhado",    "2026-09-01", 6),
    mk("t4", "Pintura",    "2027-02-01", 4) ] };
  state.cpm = { cycle: false, finish: "2027-02-05", calendar: "", pert: null, byId: new Map() };
  renderAll();
  return 1;`;

(async () => {
  const chrome = acharChrome();
  if (!chrome) {
    console.log("navegador · PULADO (nenhum Chrome/Chromium encontrado)");
    console.log("  defina PERTH_CHROME=/caminho/do/chrome para rodar estes testes");
    process.exit(0);
  }

  const srv = await servidorEstatico();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const pg = await abrirChrome(chrome, url);

  try {
    // espera o app existir (o init é assíncrono e o fetch de projetos falha
    // de propósito: este servidor devolve lista vazia)
    for (let i = 0; i < 60; i++) {
      if (await pg.avaliar(`return typeof renderAll === "function"`)) break;
      await espera(100);
    }
    await pg.avaliar(SEMENTE);

    console.log("navegador · a faixa PERT não se mexe enquanto se digita");
    {
      await pg.avaliar(`openModal("t1"); return 1;`);
      const antes = await pg.avaliar(`
        const r = (id) => { const b = document.getElementById(id).getBoundingClientRect();
                            return [Math.round(b.left), Math.round(b.width)]; };
        const btn = document.getElementById("f-pert-apply").getBoundingClientRect();
        return { o: r("f-optimistic"), m: r("f-most-likely"), p: r("f-pessimistic"),
                 botao: [Math.round(btn.left), Math.round(btn.top)],
                 saida: document.getElementById("f-pert-out").textContent };`);

      // digita de verdade no campo pessimista, tecla por tecla
      await pg.avaliar(`document.getElementById("f-pessimistic").focus(); return 1;`);
      for (const c of "6666") {
        await pg.enviar("Input.dispatchKeyEvent", { type: "keyDown", text: c });
        await pg.enviar("Input.dispatchKeyEvent", { type: "keyUp" });
      }
      const depois = await pg.avaliar(`
        const r = (id) => { const b = document.getElementById(id).getBoundingClientRect();
                            return [Math.round(b.left), Math.round(b.width)]; };
        const btn = document.getElementById("f-pert-apply").getBoundingClientRect();
        return { o: r("f-optimistic"), m: r("f-most-likely"), p: r("f-pessimistic"),
                 botao: [Math.round(btn.left), Math.round(btn.top)],
                 saida: document.getElementById("f-pert-out").textContent };`);

      check(depois.saida !== antes.saida, "o texto do resultado de fato cresceu com os dígitos");
      check(JSON.stringify(depois.o) === JSON.stringify(antes.o) &&
            JSON.stringify(depois.m) === JSON.stringify(antes.m) &&
            JSON.stringify(depois.p) === JSON.stringify(antes.p),
            "os três campos ficam no mesmo lugar, com a mesma largura");
      check(JSON.stringify(depois.botao) === JSON.stringify(antes.botao),
            "e o botão de aplicar não desliza nem pula de linha");

      // as duas camadas do editor de código não existem mais aqui; fecha o modal
      await pg.avaliar(`closeModal(false); return 1;`);
    }

    console.log("navegador · duplo clique na barra abre a tarefa");
    {
      const alvo = await pg.avaliar(`
        const b = document.querySelector('#chart .bar[data-id="t2"]');
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
      // duplo clique de verdade: dois pares press/release com clickCount 1 e 2
      for (const n of [1, 2]) {
        await pg.enviar("Input.dispatchMouseEvent", { type: "mousePressed", x: alvo.x, y: alvo.y,
                                                      button: "left", clickCount: n });
        await pg.enviar("Input.dispatchMouseEvent", { type: "mouseReleased", x: alvo.x, y: alvo.y,
                                                      button: "left", clickCount: n });
      }
      await espera(150);
      const r = await pg.avaliar(`
        return { aberto: !document.getElementById("modal").hidden,
                 nome: document.getElementById("f-name").value };`);
      check(r.aberto === true && r.nome === "Escavação",
            "duplo clique de verdade abre o modal da tarefa certa");
      await pg.avaliar(`closeModal(false); return 1;`);
    }

    console.log("navegador · a busca leva a linha do tempo até a barra");
    {
      // "Pintura" começa em 2027-02, quase um ano depois do início da vista
      const r = await pg.avaliar(`
        el.tlBody.scrollTo({ left: 0, top: 0, behavior: "instant" });
        const cx = document.getElementById("task-search");
        cx.value = "pintura";
        cx.dispatchEvent(new Event("input"));
        await new Promise((ok) => setTimeout(ok, 120));
        const b = document.querySelector('#chart .bar[data-id="t4"]');
        const rb = b.getBoundingClientRect();
        const área = el.tlBody.getBoundingClientRect();
        return { conta: document.getElementById("task-search-count").textContent,
                 selecionada: state.selected,
                 rolouX: Math.round(el.tlBody.scrollLeft),
                 dentro: rb.left >= área.left && rb.right <= área.right };`);
      check(r.conta === "1/1" && r.selecionada === "t4",
            "a busca acha e seleciona a tarefa");
      check(r.rolouX > 0, "a linha do tempo rolou na horizontal");
      check(r.dentro === true, "e a barra ficou inteira dentro da área visível");
    }

    console.log("navegador · raia e barra na mesma altura");
    {
      // A altura da linha de raia vem do CSS (--row-h), que o jsdom não
      // aplica: lá o alinhamento é aritmética, aqui é layout. Um cabeçalho
      // de raia um pixel mais alto desloca TODAS as barras abaixo dele.
      const r = await pg.avaliar(`
        state.current.people = [{ name: "Ana", role: "Arquiteta", team: "Obra",
                                  email: "", notes: "" }];
        state.current.tasks[0].assignee = "Ana";
        state.current.tasks[1].assignee = "Bruno";
        el.groupSelect.value = "assignee";
        el.groupSelect.dispatchEvent(new Event("change"));
        const meio = (n) => { const b = n.getBoundingClientRect();
                              return Math.round(b.top + b.height / 2); };
        const linha = (id) => meio(document.querySelector(\`.tt-row[data-id="\${id}"]\`));
        const barra = (id) => meio(document.querySelector(\`#chart .bar[data-id="\${id}"]\`));
        return { raias: document.querySelectorAll(".tt-lane").length,
                 alturaRaia: Math.round(document.querySelector(".tt-lane")
                               .getBoundingClientRect().height),
                 alturaLinha: Math.round(document.querySelector(".tt-row")
                                .getBoundingClientRect().height),
                 t1: [linha("t1"), barra("t1")],
                 t2: [linha("t2"), barra("t2")],
                 t4: [linha("t4"), barra("t4")] };`);
      check(r.raias === 3, "três raias: Ana, Bruno e sem responsável");
      check(r.alturaRaia === r.alturaLinha,
            "o cabeçalho de raia tem a MESMA altura de uma linha de tarefa");
      for (const id of ["t1", "t2", "t4"]) {
        check(Math.abs(r[id][0] - r[id][1]) <= 1,
              `a barra de ${id} está na altura do nome dela (${r[id].join(" vs ")})`);
      }
      await pg.avaliar(`el.groupSelect.value = "";
        el.groupSelect.dispatchEvent(new Event("change")); return 1;`);
    }

    console.log("navegador · duplo clique na régua marca o dia");
    {
      // O gesto inteiro, com mouse de verdade: a régua é HTML e o dia
      // marcado é SVG, então só um navegador diz se a linha caiu na coluna
      // que o dedo apontou.
      const alvo = await pg.avaliar(`
        setZoom("day");
        // a régua rola por baixo da tabela de tarefas, que é fixa: escolher
        // a célula pela posição não basta, tem que ser uma que esteja mesmo
        // SOB o cursor — senão o clique cai na tabela e some
        const c = [...document.querySelectorAll("#tl-days .tl-cell")].find((x) => {
          const r = x.getBoundingClientRect();
          const alvo = document.elementFromPoint(Math.round(r.left + r.width / 2),
                                                 Math.round(r.top + r.height / 2));
          return alvo === x;
        });
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2),
                 y: Math.round(r.top + r.height / 2), dia: c.dataset.date };`);
      check(alvo !== null, "há uma coluna de dia clicável na régua");
      for (const n of [1, 2]) {
        await pg.enviar("Input.dispatchMouseEvent", { type: "mousePressed", x: alvo.x,
                                                      y: alvo.y, button: "left", clickCount: n });
        await pg.enviar("Input.dispatchMouseEvent", { type: "mouseReleased", x: alvo.x,
                                                      y: alvo.y, button: "left", clickCount: n });
      }
      await espera(150);
      const r = await pg.avaliar(`
        const dia = document.querySelector(".cal-add input[type=date]");
        if (!dia) return { aberto: false };
        const f = document.querySelector(".cal-add");
        const i = f.querySelectorAll("input");
        i[0].value = "Entrega";
        window.saveNowAfterDirty = async () => null;   // sem rede neste teste
        f.dispatchEvent(new Event("submit"));
        document.getElementById("perth-overlay").remove();
        renderChart();
        const linha = document.querySelector("#chart .marker-line");
        // a régua rola sozinha entre o clique e a medição (foco no campo,
        // espelhamento do scroll): comparar pixel de tela seria medir duas
        // fotos diferentes. O que importa é o DIA que ficou marcado.
        return { aberto: true, data: dia.value,
                 x1: +linha.getAttribute("x1"),
                 esperado: xOf(parseDate(dia.value)) + PPD[state.zoom] / 2 };`);
      check(r.aberto === true, "o duplo clique na régua abre o painel de dias marcados");
      check(r.data === alvo.dia,
            `o dia marcado é o da coluna clicada (${r.data} vs ${alvo.dia})`);
      check(Math.abs(r.x1 - r.esperado) <= 1,
            "e a linha cai no meio dessa coluna, no sistema do gráfico");

      await pg.avaliar(`state.current.markers = []; setZoom("week"); renderChart(); return 1;`);
    }

    console.log("navegador · campo travado parece travado");
    {
      const r = await pg.avaliar(`
        openModal("t2");
        const dur = document.getElementById("f-duration");
        const custo = document.getElementById("f-cost");
        const antes = getComputedStyle(dur).backgroundColor;
        document.getElementById("f-milestone").click();
        const depois = getComputedStyle(dur).backgroundColor;
        const r = { antes, depois, custo: getComputedStyle(custo).backgroundColor,
                    desabilitado: dur.disabled };
        closeModal(false);
        return r;`);
      check(r.desabilitado === true, "marcar Marco desabilita a duração");
      check(r.depois !== r.antes && r.depois !== r.custo,
            "e o campo MUDA de aparência — travado sem parecer travado engole o clique");
    }
  } finally {
    pg.fechar();
    srv.close();
  }

  console.log(falhas ? `\n${falhas} falha(s)` : "\nTodos os testes de navegador passaram.");
  process.exit(falhas ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
