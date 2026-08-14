/* Perth · fundo da UI, compartilhado pelo gantt e pelo kanban.
 *
 * A imagem (ou a rotação delas) é setting do SERVIDOR — Perth.background!,
 * um arquivo ou uma pasta expandida em lista — e vale para os dois apps.
 * Esconder é preferência LOCAL de cada navegador, que cada app guarda do
 * seu jeito (o gantt no objeto `ui`, o kanban num checkbox); por isso a
 * preferência entra aqui como callback, em init().
 *
 * A troca é fade-out → troca a imagem no vale → fade-in: é o escurecimento
 * pedido, e uma camada só (body::before) basta para isso — crossfade de
 * verdade exigiria uma segunda camada para ganhar nada visível num véu de
 * 18% de opacidade.
 *
 * O índice em exibição sai do RELÓGIO, não de um contador local:
 *
 *     i = floor(Date.now() / periodo) % n
 *
 * Assim todas as máquinas mostram a mesma foto sem o servidor mandar tick
 * nenhum, uma aba aberta atrasada entra em fase sozinha, e uma aba
 * suspensa (laptop fechado) se corrige no primeiro disparo depois de
 * voltar. É também por isso que a lista de imagens é congelada no
 * servidor em vez de varrida ao vivo: se dois clientes vissem listas de
 * tamanhos diferentes, calculariam índices diferentes (ver background.jl).
 */
"use strict";

window.PerthBackground = (function () {
  const FADE = 450;             // ms de cada metade; casa com a transição do ui.css

  let info = null;              // último payload de /api/background
  let isHidden = () => false;   // preferência local deste navegador
  let withKey = (u) => u;       // /background é endpoint de dados: pede a chave
  let shown = -1;               // índice em exibição
  let timer = null;
  let fading = null;

  const root = () => document.documentElement;

  // Aceita o payload novo (`images`) e o antigo (só `url`): um cliente
  // pode estar aberto de antes, e o formato de uma imagem só continua
  // sendo o que o servidor grava quando você aponta um arquivo.
  function images() {
    if (!info || !info.set) return [];
    if (info.images && info.images.length) return info.images;
    return info.url ? [{ url: info.url, name: info.name }] : [];
  }

  const period = () => (info && info.interval > 0 ? info.interval * 1000 : 0);
  const opacity = () =>
    String(info && info.opacity != null ? info.opacity : 0.18);

  function indexNow() {
    const n = images().length;
    const p = period();
    if (n < 2 || !p) return 0;
    return Math.floor(Date.now() / p) % n;
  }

  function show(i) {
    const im = images()[i];
    root().style.setProperty("--perth-bg",
      im ? `url("${encodeURI(withKey(im.url))}")` : "none");
    shown = im ? i : -1;
  }

  // Carrega a próxima antes da hora: sem isto o primeiro giro acende uma
  // camada vazia enquanto os bytes chegam
  function preloadNext() {
    const imgs = images();
    if (imgs.length < 2) return;
    const next = imgs[(shown + 1) % imgs.length];
    if (!next) return;
    const im = new Image();
    im.src = encodeURI(withKey(next.url));
  }

  function swapTo(i) {
    if (fading !== null) window.clearTimeout(fading);
    root().style.setProperty("--perth-bg-opacity", "0");   // escurece
    fading = window.setTimeout(() => {
      fading = null;
      // pode ter sido escondido, trocado ou limpo durante o vale
      if (!images().length || isHidden()) return;
      show(i);                                             // troca no vale
      root().style.setProperty("--perth-bg-opacity", opacity());
      preloadNext();
    }, FADE);
  }

  function stop() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  // Acorda no instante da virada, não a cada N ms: como o índice vem do
  // relógio, um disparo atrasado ainda calcula o índice certo
  function schedule() {
    stop();
    const p = period();
    if (!p || images().length < 2 || isHidden()) return;
    timer = window.setTimeout(tick, p - (Date.now() % p) + 20);
  }

  function tick() {
    if (info && !isHidden()) {
      const i = indexNow();
      if (i !== shown) swapTo(i);
    }
    schedule();
  }

  /* `next` ausente = só redesenhar com o que já se sabe (o toggle local
     de esconder passa por aqui). */
  function apply(next) {
    if (next !== undefined) info = next;
    const on = images().length > 0 && !isHidden();
    root().classList.toggle("has-bg", on);
    if (!on) {
      root().style.setProperty("--perth-bg-opacity", "0");
      if (!images().length) show(-1);   // sem fundo: não segura URL velha
      stop();
      return;
    }
    // sempre repinta, mesmo no mesmo índice: um payload novo pode trazer
    // outra URL para a mesma posição — é assim que trocar a foto no disco
    // aparece ao vivo (a versão em ?v= muda). O guard por índice só faz
    // sentido no tick, onde a informação não mudou.
    show(indexNow());
    root().style.setProperty("--perth-bg-opacity", opacity());
    preloadNext();
    schedule();
  }

  function init(opts) {
    if (opts && opts.isHidden) isHidden = opts.isHidden;
    if (opts && opts.withKey) withKey = opts.withKey;
  }

  // Aba que volta do segundo plano: o timer pode ter dormido junto
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });

  // `tick` é público porque quem chama de fora é justamente quem sabe que
  // o relógio pode ter andado sem o timer: o handler de visibilidade acima
  return { init, apply, tick, images, indexNow, current: () => info };
})();
