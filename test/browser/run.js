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
  // O protocolo do DevTools fala por WebSocket, e o cliente aqui é o global do
  // Node — que só existe a partir do 22. Num Node mais velho o teste PULA, como
  // pula sem Chrome: teste que não pode rodar tem de dizer isso e sair com 0.
  // (Foi assim que o CI ficou vermelho: o runner pinava Node 20, achava o Chrome
  // e morria no `new WebSocket` — falha de ambiente vestida de falha de teste.)
  if (typeof WebSocket === "undefined") {
    console.log("navegador · PULADO (este Node não tem WebSocket global — precisa de 22+)");
    console.log(`  versão encontrada: ${process.version}`);
    process.exit(0);
  }

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
    /* Espera o app existir E o init() TERMINAR.
     *
     * Só esperar por `renderAll` não basta: a função existe assim que o
     * arquivo é avaliado, muito antes de o init() assíncrono acabar. Este
     * servidor de teste não tem /api, então o init falha de propósito — e a
     * falha chega DEPOIS, com um renderAll() que apaga o gráfico que a
     * semente acabou de desenhar. Na minha máquina o init falhava antes da
     * semente e ninguém via; no runner do CI, mais lento, ele chegava depois
     * e a barra da tarefa sumia do meio do teste.
     *
     * O sinal de que o init terminou é a barra de status: em erro ela recebe
     * "no connection" ou "startup error"; com projetos, o nome de um. */
    const pronto = async () => pg.avaliar(`
      if (typeof renderAll !== "function") return false;
      const s = document.getElementById("status-left");
      return !!s && s.textContent !== "—";`);
    for (let i = 0; i < 100 && !(await pronto()); i++) await espera(100);
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

    console.log("navegador · o zoom \"caber\" cabe mesmo");
    {
      // A conta do "caber" divide pela largura MEDIDA da timeline. No jsdom
      // essa largura é dada pelo teste; aqui ela é a de verdade, com
      // barra de rolagem, padding e o que mais o layout resolver cobrar.
      const r = await pg.avaliar(`
        setZoom("fit");
        const svg = document.getElementById("chart");
        return { largura: Number(svg.getAttribute("width")),
                 visivel: el.tlBody.clientWidth,
                 rolagem: el.tlBody.scrollWidth - el.tlBody.clientWidth,
                 ativo: document.querySelector(".zoom-group .active").dataset.zoom };`);
      check(r.ativo === "fit", "o botão Caber fica marcado");
      check(Math.abs(r.largura - r.visivel) <= 1,
            `o gráfico tem a largura da janela (${r.largura} vs ${r.visivel})`);
      check(r.rolagem <= 1,
            `e não sobra rolagem horizontal (${r.rolagem}px)`);
      await pg.avaliar(`setZoom("week"); return 1;`);
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

    console.log("navegador · ligar duas tarefas arrastando");
    {
      // O que o jsdom não pode dizer: quem decide o alvo do arrasto é a
      // PILHA de formas sob o ponteiro, e pilha só existe com layout de
      // verdade. Na borda da barra o topo é o contorno do crítico ou da
      // seleção, que não carregam data-id.
      const pos = await pg.avaliar(`
        setZoom("week");
        state.current.tasks.forEach((t) => { t.dependencies = []; });
        state.selected = "t1"; renderAll();
        // as duas barras têm que estar na vista: fora dela
        // elementFromPoint devolve null e o teste mede o nada
        revealTask("t1");
        el.tlBody.scrollLeft = Math.max(0, el.tlBody.scrollLeft - 60);
        const dot = [...document.querySelectorAll("#chart .link-dot")]
          .find((d) => d.dataset.side === "right");
        const alvo = document.querySelector('#chart .bar[data-id="t2"]');
        const a = dot.getBoundingClientRect(), b = alvo.getBoundingClientRect();
        return { dx: Math.round(a.left + a.width / 2), dy: Math.round(a.top + a.height / 2),
                 ax: Math.round(b.left + b.width / 2), ay: Math.round(b.top + b.height / 2),
                 // o topo da pilha no meio do alvo, e o que o gesto resolve
                 topo: document.elementFromPoint(Math.round(b.left + b.width / 2),
                                                 Math.round(b.top + b.height / 2)).getAttribute("class"),
                 achado: formaSobOPonteiro(Math.round(b.left + b.width / 2),
                                           Math.round(b.top + b.height / 2))?.dataset.id };`);
      check(pos.achado === "t2",
            `o gesto atravessa a pilha de formas e acha a tarefa (topo: ${pos.topo})`);

      await pg.enviar("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.dx,
                                                    y: pos.dy, button: "left", clickCount: 1 });
      await pg.enviar("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.ax,
                                                    y: pos.ay, button: "left", buttons: 1 });
      const meio = await pg.avaliar(`
        return { elastico: document.querySelectorAll("#chart .link-rubber").length,
                 aceso: document.querySelectorAll("#chart .link-target").length };`);
      check(meio.elastico === 1, "durante o arrasto há um elástico até o cursor");
      check(meio.aceso === 1, "e o alvo acende antes de soltar");

      await pg.enviar("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.ax,
                                                    y: pos.ay, button: "left", clickCount: 1 });
      await espera(120);
      const r = await pg.avaliar(`
        const t2 = state.current.tasks.find((t) => t.id === "t2");
        return { deps: t2.dependencies.slice(),
                 setas: document.querySelectorAll("#chart .dep").length,
                 elastico: document.querySelectorAll("#chart .link-rubber").length,
                 aceso: document.querySelectorAll("#chart .link-target").length };`);
      check(r.deps.join(",") === "t1",
            `soltar sobre a outra barra cria a dependência (${r.deps.join(",") || "nenhuma"})`);
      check(r.setas === 1, "e a seta aparece no gráfico");
      check(r.elastico === 0 && r.aceso === 0,
            "o elástico e o realce somem ao soltar");

      await pg.avaliar(`state.current.tasks.forEach((t) => { t.dependencies = []; });
        state.selected = null; renderAll(); return 1;`);
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
    console.log("navegador · selecionar várias com o mouse de verdade");
    {
      // Aqui a cadeia de eventos é a real: Ctrl+clique e Shift+clique passam
      // pelo mesmo pointerdown/click que o arrasto da barra disputa, e é isso
      // que o jsdom não consegue provar. O modificador viaja no evento do
      // navegador (Input.dispatchMouseEvent → modifiers), não num objeto
      // montado à mão.
      const CTRL = 2, SHIFT = 8;
      const centro = (id) => `
        const r = document.querySelector('.tt-row[data-id="${id}"]').getBoundingClientRect();
        return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) };`;
      const clicar = async (id, modifiers = 0) => {
        const p = await pg.avaliar(centro(id));
        for (const type of ["mousePressed", "mouseReleased"]) {
          await pg.enviar("Input.dispatchMouseEvent",
            { type, x: p.x, y: p.y, button: "left", clickCount: 1, modifiers });
        }
        await espera(40);
      };
      const sel = `return selectedTasks().map((t) => t.id);`;

      await pg.avaliar(`clearSelection(); renderAll(); return 1;`);
      await clicar("t1");
      await clicar("t3", CTRL);
      check((await pg.avaliar(sel)).join() === "t1,t3",
            "Ctrl+clique de verdade soma a segunda tarefa");

      await pg.avaliar(`clearSelection(); renderAll(); return 1;`);
      await clicar("t1");
      await clicar("t4", SHIFT);
      check((await pg.avaliar(sel)).join() === "t1,t2,t3,t4",
            "Shift+clique de verdade pega o intervalo inteiro");

      const molduras = await pg.avaliar(`
        return document.querySelectorAll("#chart .bar-sel").length;`);
      check(molduras === 4, "e as quatro barras aparecem molduradas no gráfico");

      const status = await pg.avaliar(`return document.getElementById("status-left").textContent;`);
      check(/· 4 tasks selected/.test(status), "a barra de status conta as quatro");

      // Arrastar UMA barra da seleção empurra as quatro pelo mesmo delta —
      // com o layout de verdade, que é o que converte pixels em dias
      // a pilha de desfazer vem suja dos testes anteriores (mesma página):
      // o que importa é quantas entradas ESTE gesto acrescenta
      const antes = await pg.avaliar(`
        state.undoStack = []; state.redoStack = [];
        return state.current.tasks.map((t) => t.start);`);
      const pos = await pg.avaliar(`
        const b = document.querySelector('#chart .bar[data-id="t2"]').getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
                 ppd: PPD[state.zoom] };`);
      await pg.enviar("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y,
                                                    button: "left", clickCount: 1 });
      await pg.enviar("Input.dispatchMouseEvent", { type: "mouseMoved",
                                                    x: pos.x + 3 * pos.ppd, y: pos.y, buttons: 1 });
      await pg.enviar("Input.dispatchMouseEvent", { type: "mouseReleased",
                                                    x: pos.x + 3 * pos.ppd, y: pos.y,
                                                    button: "left", clickCount: 1 });
      await espera(150);
      const depois = await pg.avaliar(`
        return { datas: state.current.tasks.map((t) => t.start),
                 undo: state.undoStack.length };`);
      const andou = depois.datas.map((d, i) =>
        (Date.parse(d) - Date.parse(antes[i])) / 86400000);
      check(andou.join() === "3,3,3,3",
            `arrastar uma barra da seleção empurra as quatro pelos mesmos 3 dias (${andou.join()})`);
      check(depois.undo === 1, "e o lote inteiro é uma entrada de desfazer");
      await pg.avaliar(`undo(); clearSelection(); renderAll(); return 1;`);
    }

    console.log("navegador · nada é escrito por cima de nada");
    {
      /* O varredor: mede a caixa de cada texto, forma e linha do gráfico e
       * cruza todos contra todos. Só aqui isso é possível — jsdom não tem
       * motor de layout, e sem largura de texto de verdade não há colisão
       * para achar.
       *
       * O projeto abaixo é feito para colidir: nomes longos que passam por
       * cima das colunas seguintes, resumo, marco, fantasma de baseline,
       * duas faixas e dois dias marcados de nome comprido. Antes do conserto
       * dava de 11 a 17 colisões por tela, e as três correções que existem
       * hoje (setas, linhas verticais, nomes deitados) foram descobertas na
       * mão, olhando. Este bloco é para que a quarta não precise ser. */
      await pg.avaliar(`
        const mk2 = (id, name, start, duration, extra) => Object.assign({
          id, name, start, duration, assignee: "", progress: 0, dependencies: [],
          color: "", notes: "", milestone: false, parent: "", cost: 0,
          baseline_start: null, baseline_duration: 0, deadline: null, pinned: false,
          optimistic: 0, most_likely: 0, pessimistic: 0 }, extra || {});
        state.current = { id: "p2", name: "Sobreposição", people: [],
          bands: [{ name: "Estação de chuvas", from: "2026-03-15", to: "2026-04-10", color: "#6b9bd1" },
                  { name: "Sprint 4", from: "2026-03-21", to: "2026-03-25", color: "" }],
          markers: [{ name: "Sete de Setembro · Feriado", date: "2026-03-07", color: "", label_at: 0 },
                    { name: "Vistoria da concessionária", date: "2026-04-05", color: "", label_at: 0 }],
          tasks: [
            mk2("f1", "1. Estudos preliminares e levantamento de campo", "2026-03-01", 1),
            mk2("a", "Levantamento planialtimétrico do terreno", "2026-03-01", 4, { parent: "f1" }),
            mk2("b", "Sondagem", "2026-03-03", 2, { parent: "f1" }),
            mk2("c", "Estudo de viabilidade", "2026-03-06", 3, { parent: "f1", dependencies: ["a"] }),
            mk2("d", "Compatibilização de projetos e aprovação na prefeitura", "2026-03-24", 8,
                { baseline_start: "2026-03-18", baseline_duration: 8 }),
            mk2("m", "Projeto aprovado pela prefeitura", "2026-03-29", 1, { milestone: true }),
            mk2("e", "Fundação", "2026-04-02", 9, { dependencies: ["d"] }),
            mk2("g", "Curto", "2026-04-07", 1) ] };
        state.cpm = { cycle: false, finish: "2026-04-10", calendar: "", pert: null, byId: new Map() };
        state.selected = null;
        renderAll();
        window.__colisoes = function () {
          const cx = (sel, tipo, infla) => [...document.querySelectorAll(sel)].map((n) => {
            const r = n.getBoundingClientRect();
            const i = infla || 0;
            return { tipo, txt: (n.textContent || "").slice(0, 26),
                     x0: r.left - i, x1: r.right + i, y0: r.top - i, y1: r.bottom + i };
          });
          const textos = [...cx("#chart .bar-label", "rótulo"),
                          ...cx("#chart .marker-label", "dia marcado"),
                          ...cx("#chart .cal-label", "faixa")];
          const formas = [...cx("#chart .bar", "barra"), ...cx("#chart .milestone", "marco"),
                          ...cx("#chart .bar-summary", "resumo"),
                          ...cx("#chart .link-dot", "ponto de ligar"),
                          ...cx("#chart .note-dot", "ponto de nota"),
                          ...cx("#chart .baseline-ghost", "fantasma")];
          // só traço fino: a caixa de um cotovelo cobriria o L inteiro
          const linhas = [...cx("#chart .today-line", "linha de hoje", 1.5),
                          ...cx("#chart .marker-line", "linha de dia marcado", 1.5),
                          ...cx("#chart .cal-edge", "borda de faixa", 1.5)]
                         .filter((l) => (l.x1 - l.x0) <= 6 || (l.y1 - l.y0) <= 6);
          const bate = (p, q) => {
            const w = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
            const h = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
            return w > 0.5 && h > 0.5;
          };
          const achados = [];
          for (let i = 0; i < textos.length; i++) {
            for (let j = i + 1; j < textos.length; j++)
              if (bate(textos[i], textos[j]))
                achados.push(textos[i].tipo + ' "' + textos[i].txt + '" × ' +
                             textos[j].tipo + ' "' + textos[j].txt + '"');
            for (const f of formas)
              if (bate(textos[i], f))
                achados.push(textos[i].tipo + ' "' + textos[i].txt + '" × ' + f.tipo);
            for (const l of linhas)
              if (bate(textos[i], l))
                achados.push(textos[i].tipo + ' "' + textos[i].txt + '" × ' + l.tipo);
          }
          return achados;
        };
        return 1;`);

      const cenarios = [
        ["zoom dia", `setZoom("day")`],
        ["zoom semana", `setZoom("week")`],
        ["zoom mês", `setZoom("month")`],
        ["zoom caber", `setZoom("fit")`],
        ["densidade compacta", `ui.density = "compact"; applyUI(); renderAll()`],
        ["raias por responsável", `ui.density = "cozy"; applyUI(); state.groupBy = "assignee"; renderAll()`],
        ["caminho crítico", `state.groupBy = ""; state.showCritical = true; renderAll()`],
      ];
      for (const [nome, prep] of cenarios) {
        const achados = await pg.avaliar(`${prep}; return window.__colisoes();`);
        check(achados.length === 0,
              `${nome}: nenhuma sobreposição` +
              (achados.length ? ` — ${achados.length}: ${achados.slice(0, 3).join("; ")}` : ""));
      }
      await pg.avaliar(`state.showCritical = false; setZoom("week"); renderAll(); return 1;`);
    }

  } finally {
    pg.fechar();
    srv.close();
  }

  console.log(falhas ? `\n${falhas} falha(s)` : "\nTodos os testes de navegador passaram.");
  process.exit(falhas ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
