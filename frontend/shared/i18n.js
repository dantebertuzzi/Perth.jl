/* Perth · idioma compartilhado (i18n).
 *
 * Um único módulo serve o Perth gantt e o Perth kanban. O inglês é o
 * idioma-fonte e também a CHAVE do dicionário: os elementos estáticos são
 * traduzidos in-place (primeiro nó de texto) a partir de uma lista de
 * seletores, sem exigir anotação do HTML. Atributos title / placeholder /
 * aria-label são traduzidos em toda a página; textos dinâmicos que não
 * estão no dicionário passam ilesos.
 *
 * A escolha persiste em localStorage "perth-lang" — compartilhada entre as
 * duas ferramentas, como o tema ("perth-theme"). O seletor é montado em
 * qualquer <select id="lang-select"> presente na página.
 *
 * Para strings geradas em JS, use PerthI18n.t("English text").
 */
"use strict";

window.PerthI18n = (function () {
  // Meses curtos por idioma (timeline do gantt, prazos do kanban)
  const MONTHS = {
    en: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
    pt: ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"],
    es: ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"],
    fr: ["janv","févr","mars","avr","mai","juin","juil","août","sept","oct","nov","déc"],
    zh: ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"],
  };

  const LANG_NAMES = {
    en: "English",
    pt: "Português",
    es: "Español",
    fr: "Français",
    zh: "中文",
  };

  /* ---------------------------------------------------- dicionários */
  // chave = string em inglês exatamente como está no HTML (nbsp vira espaço)

  const STR = {
    pt: {
      "A task with zero slack that more than one other task is waiting on. The critical path already tells you a task cannot slip; the bottleneck tells you where the chain becomes a funnel, and that is the one worth protecting first. It is derived from the plan, never typed: a hand-set flag would be wrong the moment somebody drags a bar.":
        "Tarefa com folga zero que mais de uma outra está esperando. O caminho crítico já diz que a tarefa não pode atrasar; o gargalo diz onde a corrente vira funil, e é essa que vale proteger primeiro. É derivado do plano, nunca digitado: uma marca posta à mão ficaria errada no instante em que alguém arrasta uma barra.",
      "Work stopped and expected to resume — a state nothing in the plan can reveal, so it is the one thing you declare rather than Perth deducing. It changes no arithmetic: the task keeps its dates, its load and its place on the critical path. What it stops is the reader's assumption that a bar on the chart means somebody is on it.":
        "O trabalho parou e deve voltar — um estado que nada no plano revela, e por isso o único que se declara em vez de o Perth deduzir. Não muda aritmética nenhuma: a tarefa mantém as datas, a carga e o lugar no caminho crítico. O que ele interrompe é a suposição de quem lê de que uma barra no gráfico significa alguém trabalhando nela.",
      // situação declarada e gargalo derivado
      "Status": "Situação",
      "Normal": "Normal",
      "On hold": "Parada",
      "Bottleneck": "Gargalo",
      "A state only you can know: work stopped and expected to resume. It changes nothing in the schedule — the task keeps its dates, its load and its place on the critical path.":
        "Um estado que só você sabe: o trabalho parou e deve voltar. Não muda nada no cronograma — a tarefa mantém as datas, a carga e o lugar no caminho crítico.",
      "progress in tenths, on the whole selection (100% by dragging the fill)":
        "progresso em décimos, na seleção inteira (100% arrastando o preenchimento)",
      // mesclagem quando duas máquinas gravam o mesmo projeto
      "Merged with the change from the other machine":
        "Mesclado com a mudança da outra máquina",
      "Merged with the other machine — theirs kept in":
        "Mesclado com a outra máquina — ficou a versão dela em",
      // curva-S: as duas réguas
      "work": "trabalho",
      "cost": "custo",
      // capacidade por pessoa e esforço da tarefa
      "Capacity per day": "Capacidade por dia",
      "Effort": "Esforço",
      "capacity": "capacidade",
      "day": "dia",
      "of work": "de trabalho",
      "from": "desde",
      "over capacity": "acima da capacidade",
      "How much work this person absorbs in one working day, in the same unit as a task's effort. Empty = not declared.":
        "Quanto trabalho esta pessoa absorve num dia útil, na mesma unidade do esforço da tarefa. Vazio = não declarada.",
      "How much work this task is, in the same unit as a person's capacity per day. It never moves the task. Empty falls back to the cost, and then to the duration in person-days.":
        "Quanto trabalho esta tarefa é, na mesma unidade da capacidade diária da pessoa. Nunca move a tarefa. Vazio cai no custo, e depois na duração em pessoa-dias.",
      // seleção múltipla e ações em lote (gantt e kanban)
      "Select all tasks": "Selecionar todas as tarefas",
      "Select all cards": "Selecionar todos os cards",
      "Edit selected tasks…": "Editar tarefas selecionadas…",
      "Edit selected tasks": "Editar tarefas selecionadas",
      "Push the dates, change the assignee or the colour of everything selected, in one go":
        "Empurra as datas, troca o responsável ou a cor de tudo o que está selecionado, de uma vez",
      "Mark selection done": "Concluir a seleção",
      "Assign selection…": "Atribuir a seleção…",
      "Archive selection": "Arquivar a seleção",
      "tasks selected": "tarefas selecionadas",
      "cards selected": "cards selecionados",
      "Shift start dates by": "Empurrar as datas em",
      "automatic": "automática",
      "nobody": "ninguém",
      "Apply": "Aplicar",
      "a block moves its own subtasks — a summary has no date of its own":
        "um bloco move as subtarefas dele — resumo não tem data própria",
      "Delete this task?": "Excluir esta tarefa?",
      "Delete these tasks?": "Excluir estas tarefas?",
      "Delete these cards?": "Excluir estes cards?",
      "Assign to whom? (empty clears)": "Atribuir a quem? (vazio limpa)",
      "extend the selection": "estender a seleção",
      "add or remove one task from the selection": "somar ou tirar uma tarefa da seleção",
      "add or remove one card from the selection": "somar ou tirar um card da seleção",
      "select everything in between": "selecionar tudo o que está entre as duas",
      "select everything in between (same column)":
        "selecionar tudo entre os dois (mesma coluna)",
      "select all — with a filter on, only what it leaves lit":
        "selecionar tudo — com um filtro ligado, só o que ele deixa aceso",
      "edit the whole selection (dates, assignee, colour)":
        "editar a seleção inteira (datas, responsável, cor)",
      "archive the selection": "arquivar a seleção",
      "mark the selection done": "concluir a seleção",
      // menus (gantt)
      "File": "Arquivo", "Edit": "Editar", "View": "Exibir", "Help": "Ajuda",
      "Home screen": "Tela inicial",
      "New project…": "Novo projeto…",
      "Rename project…": "Renomear projeto…",
      "Import project (.jl)…": "Importar projeto (.jl)…",
      "Export project (.jl)": "Exportar projeto (.jl)",
      "Delete project…": "Excluir projeto…",
      "New task": "Nova tarefa", "Edit task": "Editar tarefa",
      "the plan cannot be scheduled while it exists": "o plano não pode ser programado enquanto existir",
      "ended": "terminou em",
      "Warnings": "Avisos",
      "Problems found in this plan": "Problemas encontrados neste plano",
      "Problems that stop the plan from being scheduled": "Problemas que impedem programar o plano",
      "nothing wrong with this plan": "nada de errado neste plano",
      "dependency cycle": "ciclo de dependência",
      "past the deadline": "prazo estourado",
      "overdue": "vencida",
      "overallocated": "sobrecarga",
      "behind the baseline": "atrás do baseline",
      "find a task…  ( / )": "buscar tarefa…  ( / )",
      "Find a task by name": "Buscar tarefa pelo nome",
      "Import failed": "Falha ao importar",
      "Auto-schedule failed": "Falha ao reprogramar",
      "could not open the gantt": "não deu para abrir o gantt",
      "new task": "nova tarefa",
      "edit task": "editar tarefa",
      "delete selected task": "excluir a tarefa selecionada",
      "duplicate selected task": "duplicar a tarefa selecionada",
      "undo": "desfazer",
      "redo": "refazer",
      "auto-schedule": "reprogramar automaticamente",
      "toggle critical path": "alternar o caminho crítico",
      "resource load": "carga de recursos",
      "toggle dark mode": "alternar o modo escuro",
      "presentation mode": "modo apresentação",
      "go to today": "ir para hoje",
      "close / deselect / exit presentation": "fechar / desmarcar / sair da apresentação",
      "new card": "novo card",
      "edit selected card": "editar o card selecionado",
      "delete selected card": "excluir o card selecionado",
      "filter cards": "filtrar cards",
      "Gantt charts with a Julia backend.": "Gráficos de Gantt com um backend em Julia.",
      "Data lives on the local server; edit from the REPL too:": "Os dados ficam no servidor local; dá para editar pelo REPL também:",
      "my project": "meu projeto",
      "double-click to rename": "duplo clique para renomear",
      "WIP limit exceeded": "limite de trabalho em curso estourado",
      "assigned to": "de",
      "click to filter": "clique para filtrar",
      "click to edit": "clique para editar",
      "move to the archive": "mover para o arquivo",
      "filter by": "filtrar por",
      "column options": "opções da coluna",
      "type and press Enter — #tags, **bold**, [links](url)…": "escreva e tecle Enter — #tags, **negrito**, [links](url)…",
      "name": "nome",
      "remove item": "remover item",
      "+ checklist item": "+ item de checklist",
      "close (Esc)": "fechar (Esc)",
      "delete forever (cannot be undone)": "excluir para sempre (não dá para desfazer)",
      "e.g. Paulo": "ex.: Paulo",
      "switches the board for everyone": "troca o quadro para todo mundo",
      "new board name": "nome do novo quadro",
      "no subfolders": "sem subpastas",
      "no project open": "nenhum projeto aberto",
      "loading…": "carregando…",
      "copy": "copiar",
      "copied!": "copiado!",
      "+ card": "+ card",
      "+ new column": "+ nova coluna",
      "by": "por",
      "archive": "arquivar",
      "due": "prazo",
      "assignee": "responsável",
      "restore": "restaurar",
      "delete": "excluir",
      "current": "atual",
      "switch": "trocar",
      "create": "criar",
      "could not load the board list": "não deu para carregar a lista de quadros",
      "No other tasks in this project.": "Nenhuma outra tarefa neste projeto.",
      "No activity yet.": "Nenhuma atividade ainda.",
      "Nothing archived yet — finish a card (✓) and hit \"archive\".": "Nada arquivado ainda — conclua um card (✓) e clique em \"arquivar\".",
      "Names apply to everyone's screen: cursors, chips and card stamps. Empty = back to the IP.": "Os nomes valem na tela de todo mundo: cursores, etiquetas e carimbos dos cards. Vazio = volta para o IP.",
      "One board is active at a time — switching changes it for every connected machine.": "Um quadro fica ativo por vez — trocar muda para todas as máquinas conectadas.",
      "Only the host machine can switch or create boards.": "Só a máquina anfitriã pode trocar ou criar quadros.",
      "Discard this new task?": "Descartar esta tarefa nova?",
      "Discard the changes to this task?": "Descartar as alterações nesta tarefa?",
      "(top level)": "(nível superior)",
      "Edit selected task": "Editar tarefa selecionada",
      "Duplicate selected task": "Duplicar tarefa selecionada",
      "Delete selected task": "Excluir tarefa selecionada",
      "Undo": "Desfazer", "Redo": "Refazer",
      "Auto-schedule (push successors)": "Auto-agendar (empurrar sucessoras)",
      "Set baseline (snapshot plan)": "Definir linha de base (foto do plano)",
      "Clear baseline": "Limpar linha de base",
      // PERT (estimativa de três pontos)
      "Apply PERT estimates": "Aplicar estimativas PERT",
      "Every three-point estimate becomes a duration: (optimistic + 4×most likely + pessimistic) / 6":
        "Cada estimativa de três pontos vira duração: (otimista + 4×mais provável + pessimista) / 6",
      "Estimate (PERT)": "Estimativa (PERT)",
      "PERT three-point estimate: the expected duration is (o + 4m + p)/6":
        "Estimativa PERT de três pontos: a duração esperada é (o + 4m + p)/6",
      "optimistic": "otimista",
      "most likely": "mais provável",
      "pessimistic": "pessimista",
      "use as duration": "usar como duração",
      "no estimate": "sem estimativa",
      "expected": "esperada",
      "PERT": "PERT",
      "estimated tasks on the critical path": "tarefas estimadas no caminho crítico",
      "Zoom: day": "Zoom: dia", "Zoom: week": "Zoom: semana", "Zoom: month": "Zoom: mês",
      "Critical path": "Caminho crítico",
      "Go to today": "Ir para hoje",
      "Dark mode": "Modo escuro",
      "Presentation mode": "Modo apresentação",
      "Keyboard shortcuts": "Atalhos de teclado",
      "About Perth": "Sobre o Perth",
      // caixa de caminho / toolbar / tabela (gantt)
      "save to": "salvar em",
      "Save": "Salvar",
      "Save in this folder": "Salvar nesta pasta",
      "+ Task": "+ Tarefa",
      "Day": "Dia", "Week": "Semana", "Month": "Mês", "Today": "Hoje",
       "start": "início", "dur": "dur",
      // configurações (gantt)
      "Density": "Densidade", "Cozy": "Confortável", "Compact": "Compacta",
      "Task panel width": "Largura do painel de tarefas",
      "Weekend shading": "Sombrear fins de semana",
      "Bar labels": "Rótulos nas barras",
      "Baseline bars": "Barras da linha de base",
      "Language": "Idioma",
      // tela inicial (gantt)
      "project schedules, from the REPL to the browser":
        "cronogramas de projeto, do REPL ao navegador",
      "New project": "Novo projeto",
      "Import saved project": "Importar projeto salvo",
      "Continue where I left off": "Continuar de onde parei",
      "recent": "recentes",
      // modal de tarefa (gantt)
      "Task": "Tarefa", "Name": "Nome", "Assignee": "Responsável",
      "Collaborators": "Colaboradores",
      "Role": "Cargo", "Team": "Setor", "Email": "E-mail",
      "Lanes: none": "Raias: nenhuma",
      "Statistics…": "Estatísticas…",
      "Calendar bands…": "Períodos do calendário…",
      "Marked days…": "Dias marcados…",
      "Fit": "Caber",
      "Zoom: fit": "Zoom: caber",
      "Fit the whole project on screen": "Fazer o projeto inteiro caber na tela",
      "zoom day / week / month / fit": "zoom dia / semana / mês / caber",
      "Drag to the task that follows": "Arraste até a tarefa que vem depois",
      "Drag to the task that comes before": "Arraste até a tarefa que vem antes",
      "Double-click to remove": "Duplo clique para remover",
      "Already linked": "Essas duas já estão ligadas",
      "A summary is scheduled by its subtasks — link one of them": "Um resumo é agendado pelas subtarefas — ligue uma delas",
      "A task and its own block are already tied": "Uma tarefa e o próprio bloco já estão presos",
      "That would close a loop": "Isso fecharia um ciclo",
      "Collapse": "Recolher",
      "Expand": "Expandir",
      "Marked days": "Dias marcados",
      "No marked days yet.": "Nenhum dia marcado ainda.",
      "Calendar bands": "Períodos do calendário",
      "No bands yet.": "Nenhum período ainda.",
      "Colour": "Cor",
      "Remove": "Remover",
      "Statistics": "Estatísticas",
      "People": "Pessoas",
      "Teams": "Setores",
      "Person": "Pessoa",
      "effort": "esforço",
      "done": "feito",
      "over": "excesso",
      "late": "atrasadas",
      "Nothing assigned yet.": "Nada atribuído ainda.",
      "Could not load statistics": "Não deu para carregar as estatísticas",
      "Lanes: assignee": "Raias: responsável",
      "Lanes: team": "Raias: setor",
      "(no team)": "(sem setor)",
      "Collaborators…": "Colaboradores…",
      "Add": "Adicionar",
      "task": "tarefa",
      "No collaborators registered yet.": "Nenhum colaborador cadastrado ainda.",
      "Remove from list (tasks keep the name)": "Tirar da lista (as tarefas mantêm o nome)",
      "Also assigned in this project": "Também aparecem neste projeto",
      "Register these": "Cadastrar estes",
      "Parent (WBS)": "Pai (WBS)", "Start": "Início",
      "Duration (days)": "Duração (dias)", "Progress (%)": "Progresso (%)",
      "Color": "Cor", "Automatic": "Automática",
      "Julia purple": "Roxo Julia", "Julia green": "Verde Julia",
      "Julia red": "Vermelho Julia", "Julia blue": "Azul Julia", "Amber": "Âmbar",
      "Milestone": "Marco",
      // prazo (compromisso) e data fixa
      "Deadline": "Prazo limite",
      "deadline": "prazo limite",
      "Pin start date": "Fixar a data de início",
      "pinned start": "data de início fixa",
      "auto-schedule wants": "o auto-schedule quer",
      "Past deadline": "Fora do prazo",
      "Pinned start": "Data fixa",
      "Commitment: never moves the task, but busting it turns the slack of this task and of everything feeding it negative":
        "Compromisso: nunca move a tarefa, mas estourá-lo deixa negativa a folga dela e de tudo que a alimenta",
      "Contract date: auto-schedule leaves it where it is":
        "Data contratual: o auto-schedule não a move",
      "Summary task: start, duration and progress roll up from its subtasks.":
        "Tarefa-resumo: início, duração e progresso derivam das subtarefas.",
      "Depends on": "Depende de", "Notes": "Notas",
      "Delete": "Excluir", "Cancel": "Cancelar", "Close": "Fechar",
      // títulos/tooltips (gantt)
      "Perth.jl on GitHub": "Perth.jl no GitHub",
      "Source on GitHub": "Código no GitHub",
      "Toggle dark mode (D)": "Alternar modo escuro (D)",
      "Presentation mode (P)": "Modo apresentação (P)",
      "Exit presentation mode (Esc)": "Sair do modo apresentação (Esc)",
      "Interface settings": "Configurações da interface",
      "Mirror the project to a .perth.jl file on every save":
        "Espelhar o projeto num arquivo .perth.jl a cada salvamento",
      "Browse folders": "Navegar pelas pastas",
      "Parent folder": "Pasta acima",
      "Active project": "Projeto ativo",
      "Highlight tasks by assignee, status or type":
        "Destacar tarefas por responsável, status ou tipo",
      "Center on today": "Centralizar em hoje",
      "Project completion": "Conclusão do projeto",
      // kanban
      "Board": "Quadro",
      "Switch board": "Trocar de quadro",
      "New card": "Novo card",
      "New column…": "Nova coluna…",
      "Boards…": "Quadros…",
      "Archived cards…": "Cards arquivados…",
      "Share / QR…": "Compartilhar / QR…",
      // fundo da UI (Perth.background!)
      "Hide background": "Esconder o fundo",
      "hide background image": "esconder a imagem de fundo",
      // etiqueta de card criado hoje (kanban)
      "new": "novo",
      "added today": "criado hoje",
      "hide new-card badges": "esconder a etiqueta de card novo",
      // transmitir (share): diálogo de compartilhamento e avisos
      "Transmit to your network": "Transmitir para a sua rede",
      "Transmitting — click to stop": "Transmitindo — clique para parar",
      "Share this board": "Compartilhar este quadro",
      "Share this project": "Compartilhar este projeto",
      "Transmitting to your network": "Transmitindo para a sua rede",
      "Localhost only": "Só nesta máquina",
      "Start transmitting": "Transmitir",
      "Stop transmitting": "Parar de transmitir",
      "Transmission on": "Transmissão ligada",
      "Transmission off": "Transmissão desligada",
      "Nobody else can reach this board yet — start transmitting to hand out a link.":
        "Ninguém mais alcança este quadro ainda — transmita para poder passar um link.",
      "Nobody else can reach this server yet — start transmitting to hand out a link.":
        "Ninguém mais alcança este servidor ainda — transmita para poder passar um link.",
      "Localhost only — the machine running Perth turns transmission on.":
        "Só nesta máquina — quem liga a transmissão é a máquina que roda o Perth.",
      "Scan with a phone on the same Wi-Fi to open":
        "Aponte o celular na mesma rede Wi-Fi para abrir",
      "Tip: run `using QRCoders` before Perth.kanban() to get a QR code here and in the terminal.":
        "Dica: rode `using QRCoders` antes de Perth.kanban() para ter um QR code aqui e no terminal.",
      "Tip: run `using QRCoders` before Perth.run() to get a QR code here and in the terminal.":
        "Dica: rode `using QRCoders` antes de Perth.run() para ter um QR code aqui e no terminal.",
      "The machine running Perth stopped transmitting this board.":
        "A máquina que roda o Perth parou de transmitir este quadro.",
      "The machine running Perth stopped transmitting these projects.":
        "A máquina que roda o Perth parou de transmitir estes projetos.",
      "try again": "tentar de novo",
      "Access key": "Chave de acesso",
      "These projects require an access key. Ask whoever started the server.":
        "Estes projetos exigem uma chave de acesso. Peça a quem subiu o servidor.",
      "This board requires an access key. Ask whoever started the server.":
        "Este quadro exige uma chave de acesso. Peça a quem subiu o servidor.",
      "access key": "chave de acesso",
      "enter": "entrar",
      "enter board": "entrar no quadro",
      "Access key required": "Chave de acesso exigida",
      "No access key": "Sem chave de acesso",
      // link somente-leitura (view_key!)
      "Label position": "Posição do nome",
      "move the selection": "mover a seleção",
      "collapse / expand a summary": "recolher / abrir um resumo",
      "first / last task": "primeira / última tarefa",
      "zoom keeping the date under the pointer": "zoom mantendo a data sob o ponteiro",
      "Marked months": "Meses marcados",
      "Marked months…": "Meses marcados…",
      "No marked months yet.": "Nenhum mês marcado ainda.",
      "Name (optional)": "Nome (opcional)",
      "read-only": "somente leitura",
      "Read-only link — ask for an editing link to change anything.":
        "Link somente leitura — peça um link de edição para mudar qualquer coisa.",
      "Read-only link on": "Link somente leitura ativo",
      "No read-only link": "Sem link somente leitura",
      "new read-only key": "nova chave de leitura",
      "read-only key": "chave de leitura",
      "Whoever opens the link below sees the projects and cannot change them — not even through the chat. This machine always edits, so the link starts at your network address.":
        "Quem abrir o link abaixo vê os projetos e não consegue mudá-los — nem pelo chat. Esta máquina edita sempre, então o link começa no seu endereço de rede.",
      "A second link that opens the projects and refuses to change them — for a client, a director, the whole site.":
        "Um segundo link que abre os projetos e recusa mudá-los — para um cliente, uma diretoria, a obra inteira.",
      "Start transmitting to get the read-only link.":
        "Ligue a transmissão para ter o link somente leitura.",
      "View selected task": "Ver tarefa selecionada",
      "starts before its dependencies allow": "começa antes do que a dependência permite",
      "can start on": "pode começar em",
      "The dates say one thing and the arrows say another: the task begins earlier than its predecessors let it. A dependency never moves anything on its own — auto-schedule (S) is what puts it where it can go, unless the start is pinned.":
        "As datas dizem uma coisa e as setas dizem outra: a tarefa começa antes do que os predecessores deixam. Uma dependência não move nada sozinha — quem põe a tarefa onde ela cabe é o programar automaticamente (S), a não ser que a data seja fixa.",
      // glossário (Ajuda -> O que as palavras querem dizer)
      "What overallocation, slack, baseline, PERT and the rest actually mean":
        "O que sobrecarga, folga, baseline, PERT e o resto querem dizer de verdade",
      "Summary": "Resumo",
      "Progress": "Avanço",
      "Duration": "Duração",
      "Slack": "Folga",
      "Baseline": "Linha de base",
      "What the words mean":
        "O que as palavras querem dizer",
      "Turn lanes off to reorder tasks by hand.":
        "Desligue as raias para ordenar as tarefas com a mão.",
      "Task order — drag a row to change it":
        "Ordem das tarefas — arraste uma linha para mudar",
      "The plan":
        "O plano",
      "A piece of work with a start and a duration — a bar on the chart.":
        "Um trabalho com começo e duração — uma barra no gráfico.",
      "A date with nothing lasting: a delivery, an approval, a signature. Drawn as a diamond and never has a duration.":
        "Uma data sem nada durando: uma entrega, uma aprovação, uma assinatura. Desenhada como losango, nunca tem duração.",
      "A task with subtasks. Its dates and its progress are not typed in — they are rolled up from its children.":
        "Uma tarefa com subtarefas. As datas e o avanço dela não são digitados — sobem dos filhos.",
      "WBS":
        "EAP (WBS)",
      "The breakdown of the plan into blocks and sub-blocks: which task is inside which. The indentation in the table is the WBS.":
        "A quebra do plano em blocos e sub-blocos: qual tarefa está dentro de qual. O recuo na tabela é a EAP.",
      "Sequence (#)":
        "Sequência (#)",
      "The position of the row. Drag a row up or down to choose it; where nobody chose, rows come by start date.":
        "A posição da linha. Arraste para cima ou para baixo para escolher; onde ninguém escolheu, as linhas vêm pela data de início.",
      "How much of the task is done, in percent. A summary averages its children, weighted by duration.":
        "Quanto da tarefa está feito, em porcentagem. Um resumo faz a média dos filhos, ponderada pela duração.",
      "Time":
        "Tempo",
      "Length of the task in days. With a business-day calendar set, weekends and holidays do not count.":
        "O tamanho da tarefa em dias. Com um calendário de dias úteis, fins de semana e feriados não contam.",
      "Dependency":
        "Dependência",
      "\"This only starts after that.\" Finish-to-start is the default; start-to-start and finish-to-finish tie the two starts or the two finishes; lag adds or removes days.":
        "\"Isto só começa depois daquilo.\" Fim-início é o padrão; início-início e fim-fim amarram os dois começos ou os dois términos; a defasagem (lag) soma ou tira dias.",
      "Auto-schedule":
        "Programar automaticamente",
      "Moves every task to the earliest date its dependencies allow. It never invents work — it only closes the gaps the plan does not need.":
        "Leva cada tarefa para a data mais cedo que as dependências permitem. Não inventa trabalho — só fecha as folgas que o plano não precisa ter.",
      "A date fixed by hand — a contract, a delivery window. Auto-schedule leaves it alone, and says so when the plan no longer fits it.":
        "Uma data presa com a mão — um contrato, uma janela de entrega. A programação automática não a move, e avisa quando o plano deixou de caber nela.",
      "A date the task must not finish after. It never moves anything: it turns the slack of this task, and of everything feeding it, negative.":
        "Uma data depois da qual a tarefa não pode terminar. Não move nada: deixa negativa a folga desta tarefa e de tudo que alimenta ela.",
      "Finish":
        "Término",
      "The end of the project as the engine computes it, from the dependencies and the durations.":
        "O fim do projeto como o motor calcula, a partir das dependências e das durações.",
      "What the engine computes":
        "O que o motor calcula",
      "The chain of tasks with no slack. A day lost in any of them is a day lost by the whole project — which is why it is worth looking at first.":
        "A corrente de tarefas sem folga. Um dia perdido em qualquer uma delas é um dia perdido pelo projeto inteiro — por isso é o primeiro lugar para olhar.",
      "How many days a task can slip before it starts pushing the finish. Zero slack is the critical path; negative slack is a promise already broken.":
        "Quantos dias uma tarefa pode atrasar antes de empurrar o término. Folga zero é o caminho crítico; folga negativa é uma promessa já quebrada.",
      "A frozen copy of the plan — what was promised. The ghost bars are the baseline; the difference between them and the bars is the slippage.":
        "Uma cópia congelada do plano — o que foi prometido. As barras fantasma são o baseline; a diferença entre elas e as barras é a derrapagem.",
      "How much of the work was planned to be done by each date, drawn against how much is done. The gap between the two curves is the delay, in work rather than in days.":
        "Quanto do trabalho estava previsto para cada data, desenhado contra quanto está feito. A distância entre as duas curvas é o atraso medido em trabalho, não em dias.",
      "Workload":
        "Carga",
      "How much each person has on each day. It is what turns a plan into a question about people.":
        "Quanto cada pessoa tem em cada dia. É o que transforma um plano numa pergunta sobre gente.",
      "Three estimates instead of one — optimistic, most likely, pessimistic — worth (o + 4m + p) / 6 as the expected duration. It says how uncertain a task is, not only how long it is.":
        "Três estimativas em vez de uma — otimista, mais provável, pessimista — que valem (o + 4m + p) / 6 como duração esperada. Diz o quanto uma tarefa é incerta, não só o quanto ela dura.",
      "P80":
        "P80",
      "The finish date with an 80% chance of being met, from the PERT estimates. The date to promise when the plan has uncertainty in it.":
        "A data de término com 80% de chance de ser cumprida, a partir das estimativas PERT. É a data que se promete quando o plano tem incerteza dentro.",
      "A waits for B and B waits for A. Nothing can be scheduled until the loop is cut — this is the one warning that stops the engine.":
        "A espera B e B espera A. Nada pode ser programado enquanto o laço não for cortado — é o único aviso que trava o motor.",
      "past deadline":
        "prazo estourado",
      "The task finishes after the date it had promised.":
        "A tarefa termina depois da data que tinha prometido.",
      "The day has passed and the task is not at 100%.":
        "O dia passou e a tarefa não está em 100%.",
      "overallocation":
        "sobrecarga",
      "Two tasks of the same person on a day that carries more work than it holds. With a capacity declared for that person, \"more than it holds\" means over the capacity; without one, it falls back to the cruder rule that any two tasks on the same day are too many.":
        "Duas tarefas da mesma pessoa num dia que carrega mais trabalho do que cabe nele. Com uma capacidade declarada para essa pessoa, \"mais do que cabe\" quer dizer acima da capacidade; sem ela, vale a regra mais crua de que duas tarefas quaisquer no mesmo dia já são demais.",
      "How much work a person absorbs in one working day, in the same unit as a task's effort — 8 for hours, 1 for a full-time person-day, 0.5 for half time. Declaring it is what lets two one-hour tasks stop counting as an overload. Empty means not declared, and the old rule applies.":
        "Quanto trabalho uma pessoa absorve num dia útil, na mesma unidade do esforço da tarefa — 8 para horas, 1 para um pessoa-dia integral, 0.5 para meio período. Declarar isso é o que faz duas tarefas de uma hora deixarem de contar como sobrecarga. Vazio quer dizer não declarada, e vale a regra antiga.",
      "How much work a task is, in the same unit as a person's capacity. It never moves the task: two hours of work inside a task that spans a week is a statement about load, not about dates. Empty falls back to the cost, and then to the duration in person-days.":
        "Quanto trabalho uma tarefa é, na mesma unidade da capacidade da pessoa. Nunca move a tarefa: duas horas de trabalho dentro de uma tarefa que ocupa uma semana é uma afirmação sobre carga, não sobre datas. Vazio cai no custo, e depois na duração em pessoa-dias.",
      "The task is later than it was in the frozen plan.":
        "A tarefa está mais tarde do que estava no plano congelado.",
      "On the chart":
        "No gráfico",
      "Lanes":
        "Raias",
      "Group the rows by person or by team, instead of by the WBS.":
        "Agrupam as linhas por pessoa ou por setor, em vez da EAP.",
      "Calendar band":
        "Faixa do calendário",
      "A named stretch of calendar shaded behind the chart: a sprint, a shutdown, the rainy season. Annotation — it never moves a task.":
        "Um trecho de calendário com nome, sombreado atrás do gráfico: um sprint, uma parada, a estação de chuva. É anotação — nunca move uma tarefa.",
      "Marked day":
        "Dia marcado",
      "A named vertical line across the chart, like the today line: an inspection, a hand-over, a holiday.":
        "Uma linha vertical com nome atravessando o gráfico, como a linha de hoje: uma vistoria, uma entrega, um feriado.",
      "The planned weight of the task, in whatever unit you use. Left at zero, the duration in person-days is the weight in the S-curve.":
        "O peso previsto da tarefa, na unidade que você usar. Deixado em zero, a duração em pessoa-dia é o peso na curva S.",
      "new access key": "nova chave",
      "apply": "aplicar",
      "remove": "remover",
      "The links below already carry the key. Changing it disconnects everyone on the network — they are asked for the new one.":
        "Os links abaixo já levam a chave. Trocá-la desconecta todo mundo na rede — cada um é perguntado pela nova.",
      "Without a key, anyone on the network who knows the port can open and edit these projects.":
        "Sem chave, qualquer um na rede que saiba a porta pode abrir e editar estes projetos.",
      "Without a key, anyone on the network who knows the port can open and edit this board.":
        "Sem chave, qualquer um na rede que saiba a porta pode abrir e editar este quadro.",
      "wrong key — try again": "chave incorreta — tente de novo",
      "could not load share info":
        "não foi possível carregar os dados de compartilhamento",
      "not sharing": "sem transmissão",
      "Rename machines…": "Renomear máquinas…",
      "Auto-archive…": "Auto-arquivar…",
      "Delete selected card": "Excluir card selecionado",
      "Reset board…": "Zerar quadro…",
      "Resync with server": "Ressincronizar com o servidor",
      "filter cards…  ( / )": "filtrar cards…  ( / )",
      "your name (shown on your cursor)": "seu nome (aparece no seu cursor)",
      "e.g. dante": "ex.: dante",
      "empty = shows the machine IP only": "vazio = mostra só o IP da máquina",
      "notification sound": "som de notificação",
      "your name on the board": "seu nome no quadro",
      "connected machines": "máquinas conectadas",
      // presença (shared/presence.js)
      "connecting…": "conectando…",
      "live": "ao vivo",
      "reconnecting…": "reconectando…",
      "access denied": "acesso negado",
      "Activity…": "Atividade…",
      "Export tasks (CSV)": "Exportar tarefas (CSV)",
      "Export calendar (.ics)": "Exportar calendário (.ics)",
      "Milestones and deadlines as an .ics file for your calendar app":
        "Marcos e prazos num arquivo .ics para o seu aplicativo de calendário",
      "Export chart (PNG)": "Exportar gráfico (PNG)",
      "S-curve…": "Curva S…",
      "Metrics…": "Métricas…",
      "Cost": "Custo",
      "lag": "defasagem",
      "Activity": "Atividade",
      "S-curve": "Curva S",
      "Metrics": "Métricas",
      "no activity yet": "sem atividade ainda",
      "planned": "planejado",
      "actual": "realizado",
      "planned to date": "planejado até hoje",
      "earned to date": "realizado até hoje",
      "total": "total",
      // painel de recursos (gantt)
      "Resources": "Recursos",
      "resources": "recursos",
      "Close (R)": "Fechar (R)",
      "(unassigned)": "(sem responsável)",
      "no one assigned yet": "ninguém com tarefa ainda",
      "busy days": "dias ocupados",
      "peak": "pico",
      "person-days": "pessoa-dias",
      "tasks": "tarefas",
      "avg lead time": "lead time médio",
      "days": "dias",
      "done last 7 days": "concluídos nos últimos 7 dias",
      "done last 30 days": "concluídos nos últimos 30 dias",
      "cards in progress": "cards em andamento",
      "oldest in progress": "mais antigo em andamento",
      "not enough data yet — complete some cards first": "ainda sem dados suficientes — conclua alguns cards primeiro",
      "Project changed on another machine — reloaded": "O projeto mudou em outra máquina — recarregado",
      "Open Kanban": "Abrir o Kanban",
      "Open Gantt": "Abrir o Gantt",
      // ocultar cursores (gantt + kanban)
      "Hide other cursors": "Ocultar cursores dos outros",
      "hide other people's cursors": "ocultar cursores dos outros",
      // peers na menubar
      "more connected machines": "mais máquinas conectadas",
      // permissões por IP (kanban)
      "Permissions…": "Permissões…",
      "Permissions": "Permissões",
      "add card": "criar card",
      "edit card text": "editar texto do card",
      "edit card description": "editar descrição do card",
      "delete card": "excluir card",
      "move card between columns": "mover card entre colunas",
      "mark card done": "concluir card",
      "archive card": "arquivar card",
      "restore from archive": "restaurar do arquivo",
      "delete archived forever": "excluir definitivamente do arquivo",
      "set assignee": "definir responsável",
      "set due date": "definir prazo",
      "attach images": "anexar imagens",
      "add checklist item": "adicionar item ao checklist",
      "check/uncheck checklist item": "marcar/desmarcar item do checklist",
      "delete checklist item": "excluir item do checklist",
      "add column": "criar coluna",
      "rename column": "renomear coluna",
      "delete column": "excluir coluna",
      "reorder columns": "reordenar colunas",
      "set WIP limit": "definir limite de WIP",
      "sort column by due date": "ordenar coluna por prazo",
      // o card como documento (caixa expandida, código, imagens)
      "Card": "Card",
      "card title — one line": "título do card — uma linha",
      "description — **bold**, `code`, ``` for a block · paste an image": "descrição — **negrito**, `código`, ``` para bloco · cole uma imagem",
      "is editing this card right now": "está editando este card agora",
      "open card": "abrir card",
      "description…": "descrição…",
      "open card (description, code, images)": "abrir card (descrição, código, imagens)",
      "description, code and images": "descrição, código e imagens",
      "bold": "negrito",
      "italic": "itálico",
      "strikethrough": "riscado",
      "inline code": "código",
      "code block": "bloco de código",
      "list item": "item de lista",
      "link": "link",
      "Link address": "Endereço do link",
      "text": "texto",
      "code": "código",
      "remove image": "remover imagem",
      "attached image": "imagem anexada",
      "a card holds at most": "um card guarda no máximo",
      "images": "imagens",
      "could not attach the image": "não foi possível anexar a imagem",
      "Restricted by the host": "Restrito pelo host",
      "The host restricted this action for your machine": "O host restringiu esta ação para esta máquina",
      "Someone changed this since your edit — undo skipped": "Alguém alterou isso depois da sua edição — desfazer ignorado",
      "Chat": "Chat",
      "Close (Esc)": "Fechar (Esc)",
      "Send (Enter)": "Enviar (Enter)",
      "Message the team…": "Mensagem para a equipe…",
      "Message the board…": "Mensagem para o board…",
      "No messages yet — say hi.": "Nenhuma mensagem ainda — diga oi.",
      "No other machines have connected yet.": "Nenhuma outra máquina se conectou ainda.",
      "check/uncheck everything": "marcar/desmarcar tudo",
      "check/uncheck this action for everyone": "marcar/desmarcar esta ação para todos",
      "check/uncheck this machine": "marcar/desmarcar esta máquina",
      "Unchecked = blocked on that machine. The host machine is always allowed here, no matter this matrix.":
        "Desmarcado = bloqueado naquela máquina. A máquina do host sempre tem permissão aqui, independente desta matriz.",
      // etiqueta de versão (barra de status dos dois apps)
      "Perth version": "Versão do Perth",
    },

    es: {
      "A task with zero slack that more than one other task is waiting on. The critical path already tells you a task cannot slip; the bottleneck tells you where the chain becomes a funnel, and that is the one worth protecting first. It is derived from the plan, never typed: a hand-set flag would be wrong the moment somebody drags a bar.":
        "Tarea con holgura cero que más de una otra está esperando. La ruta crítica ya dice que la tarea no puede atrasarse; el cuello de botella dice dónde la cadena se vuelve embudo, y esa es la que conviene proteger primero. Se deriva del plan, nunca se escribe: una marca puesta a mano quedaría mal en cuanto alguien arrastre una barra.",
      "Work stopped and expected to resume — a state nothing in the plan can reveal, so it is the one thing you declare rather than Perth deducing. It changes no arithmetic: the task keeps its dates, its load and its place on the critical path. What it stops is the reader's assumption that a bar on the chart means somebody is on it.":
        "El trabajo se detuvo y se espera que vuelva — un estado que nada en el plan revela, y por eso el único que se declara en vez de deducirlo Perth. No cambia ninguna aritmética: la tarea conserva sus fechas, su carga y su lugar en la ruta crítica. Lo que interrumpe es la suposición de quien lee de que una barra significa alguien trabajando en ella.",
      // situação declarada e gargalo derivado
      "Status": "Situación",
      "Normal": "Normal",
      "On hold": "En pausa",
      "Bottleneck": "Cuello de botella",
      "A state only you can know: work stopped and expected to resume. It changes nothing in the schedule — the task keeps its dates, its load and its place on the critical path.":
        "Un estado que solo usted conoce: el trabajo se detuvo y se espera que vuelva. No cambia nada del cronograma — la tarea conserva sus fechas, su carga y su lugar en la ruta crítica.",
      "progress in tenths, on the whole selection (100% by dragging the fill)":
        "progreso en décimos, en toda la selección (100% arrastrando el relleno)",
      // mesclagem quando duas máquinas gravam o mesmo projeto
      "Merged with the change from the other machine":
        "Fusionado con el cambio de la otra máquina",
      "Merged with the other machine — theirs kept in":
        "Fusionado con la otra máquina — se mantuvo la versión de ella en",
      // curva-S: as duas réguas
      "work": "trabajo",
      "cost": "costo",
      // capacidad por persona y esfuerzo de la tarea
      "Capacity per day": "Capacidad por día",
      "Effort": "Esfuerzo",
      "capacity": "capacidad",
      "day": "día",
      "of work": "de trabajo",
      "from": "desde",
      "over capacity": "sobre la capacidad",
      "How much work this person absorbs in one working day, in the same unit as a task's effort. Empty = not declared.":
        "Cuánto trabajo absorbe esta persona en un día hábil, en la misma unidad que el esfuerzo de la tarea. Vacío = no declarada.",
      "How much work this task is, in the same unit as a person's capacity per day. It never moves the task. Empty falls back to the cost, and then to the duration in person-days.":
        "Cuánto trabajo es esta tarea, en la misma unidad que la capacidad diaria de la persona. Nunca mueve la tarea. Vacío cae en el costo, y luego en la duración en persona-días.",
      // selección múltiple y acciones en lote (gantt y kanban)
      "Select all tasks": "Seleccionar todas las tareas",
      "Select all cards": "Seleccionar todas las tarjetas",
      "Edit selected tasks…": "Editar tareas seleccionadas…",
      "Edit selected tasks": "Editar tareas seleccionadas",
      "Push the dates, change the assignee or the colour of everything selected, in one go":
        "Empuja las fechas, cambia el responsable o el color de todo lo seleccionado, de una vez",
      "Mark selection done": "Completar la selección",
      "Assign selection…": "Asignar la selección…",
      "Archive selection": "Archivar la selección",
      "tasks selected": "tareas seleccionadas",
      "cards selected": "tarjetas seleccionadas",
      "Shift start dates by": "Desplazar las fechas",
      "automatic": "automático",
      "nobody": "nadie",
      "Apply": "Aplicar",
      "a block moves its own subtasks — a summary has no date of its own":
        "un bloque mueve sus propias subtareas — un resumen no tiene fecha propia",
      "Delete this task?": "¿Eliminar esta tarea?",
      "Delete these tasks?": "¿Eliminar estas tareas?",
      "Delete these cards?": "¿Eliminar estas tarjetas?",
      "Assign to whom? (empty clears)": "¿Asignar a quién? (vacío borra)",
      "extend the selection": "extender la selección",
      "add or remove one task from the selection": "sumar o quitar una tarea de la selección",
      "add or remove one card from the selection": "sumar o quitar una tarjeta de la selección",
      "select everything in between": "seleccionar todo lo que hay entre las dos",
      "select everything in between (same column)":
        "seleccionar todo entre las dos (misma columna)",
      "select all — with a filter on, only what it leaves lit":
        "seleccionar todo — con un filtro activo, solo lo que deja encendido",
      "edit the whole selection (dates, assignee, colour)":
        "editar toda la selección (fechas, responsable, color)",
      "archive the selection": "archivar la selección",
      "mark the selection done": "completar la selección",
      "File": "Archivo", "Edit": "Editar", "View": "Ver", "Help": "Ayuda",
      "Home screen": "Pantalla de inicio",
      "New project…": "Nuevo proyecto…",
      "Rename project…": "Renombrar proyecto…",
      "Import project (.jl)…": "Importar proyecto (.jl)…",
      "Export project (.jl)": "Exportar proyecto (.jl)",
      "Delete project…": "Eliminar proyecto…",
      "New task": "Nueva tarea", "Edit task": "Editar tarea",
      "the plan cannot be scheduled while it exists": "el plan no se puede programar mientras exista",
      "ended": "terminó el",
      "Warnings": "Avisos",
      "Problems found in this plan": "Problemas encontrados en este plan",
      "Problems that stop the plan from being scheduled": "Problemas que impiden programar el plan",
      "nothing wrong with this plan": "nada mal en este plan",
      "dependency cycle": "ciclo de dependencia",
      "past the deadline": "plazo vencido",
      "overdue": "atrasada",
      "overallocated": "sobrecarga",
      "behind the baseline": "por detrás de la línea base",
      "find a task…  ( / )": "buscar tarea…  ( / )",
      "Find a task by name": "Buscar tarea por el nombre",
      "Import failed": "Error al importar",
      "Auto-schedule failed": "Error al reprogramar",
      "could not open the gantt": "no se pudo abrir el gantt",
      "new task": "nueva tarea",
      "edit task": "editar tarea",
      "delete selected task": "eliminar la tarea seleccionada",
      "duplicate selected task": "duplicar la tarea seleccionada",
      "undo": "deshacer",
      "redo": "rehacer",
      "auto-schedule": "reprogramar automáticamente",
      "toggle critical path": "alternar la ruta crítica",
      "resource load": "carga de recursos",
      "toggle dark mode": "alternar el modo oscuro",
      "presentation mode": "modo presentación",
      "go to today": "ir a hoy",
      "close / deselect / exit presentation": "cerrar / desmarcar / salir de la presentación",
      "new card": "nueva tarjeta",
      "edit selected card": "editar la tarjeta seleccionada",
      "delete selected card": "eliminar la tarjeta seleccionada",
      "filter cards": "filtrar tarjetas",
      "Gantt charts with a Julia backend.": "Diagramas de Gantt con un backend en Julia.",
      "Data lives on the local server; edit from the REPL too:": "Los datos viven en el servidor local; también puedes editar desde el REPL:",
      "my project": "mi proyecto",
      "double-click to rename": "doble clic para renombrar",
      "WIP limit exceeded": "límite de trabajo en curso superado",
      "assigned to": "de",
      "click to filter": "clic para filtrar",
      "click to edit": "clic para editar",
      "move to the archive": "mover al archivo",
      "filter by": "filtrar por",
      "column options": "opciones de la columna",
      "type and press Enter — #tags, **bold**, [links](url)…": "escribe y pulsa Enter — #etiquetas, **negrita**, [enlaces](url)…",
      "name": "nombre",
      "remove item": "quitar elemento",
      "+ checklist item": "+ elemento de la lista",
      "close (Esc)": "cerrar (Esc)",
      "delete forever (cannot be undone)": "eliminar para siempre (no se puede deshacer)",
      "e.g. Paulo": "p. ej. Paulo",
      "switches the board for everyone": "cambia el tablero para todos",
      "new board name": "nombre del nuevo tablero",
      "no subfolders": "sin subcarpetas",
      "no project open": "ningún proyecto abierto",
      "loading…": "cargando…",
      "copy": "copiar",
      "copied!": "¡copiado!",
      "+ card": "+ tarjeta",
      "+ new column": "+ nueva columna",
      "by": "por",
      "archive": "archivar",
      "due": "vencimiento",
      "assignee": "responsable",
      "restore": "restaurar",
      "delete": "eliminar",
      "current": "actual",
      "switch": "cambiar",
      "create": "crear",
      "could not load the board list": "no se pudo cargar la lista de tableros",
      "No other tasks in this project.": "No hay otras tareas en este proyecto.",
      "No activity yet.": "Todavía no hay actividad.",
      "Nothing archived yet — finish a card (✓) and hit \"archive\".": "Nada archivado todavía — termina una tarjeta (✓) y pulsa \"archivar\".",
      "Names apply to everyone's screen: cursors, chips and card stamps. Empty = back to the IP.": "Los nombres valen en la pantalla de todos: cursores, etiquetas y sellos de las tarjetas. Vacío = vuelve a la IP.",
      "One board is active at a time — switching changes it for every connected machine.": "Un tablero activo a la vez — cambiarlo lo cambia para todas las máquinas conectadas.",
      "Only the host machine can switch or create boards.": "Solo la máquina anfitriona puede cambiar o crear tableros.",
      "Discard this new task?": "¿Descartar esta tarea nueva?",
      "Discard the changes to this task?": "¿Descartar los cambios en esta tarea?",
      "(top level)": "(nivel superior)",
      "Edit selected task": "Editar tarea seleccionada",
      "Duplicate selected task": "Duplicar tarea seleccionada",
      "Delete selected task": "Eliminar tarea seleccionada",
      "Undo": "Deshacer", "Redo": "Rehacer",
      "Auto-schedule (push successors)": "Autoprogramar (empujar sucesoras)",
      "Set baseline (snapshot plan)": "Fijar línea base (instantánea del plan)",
      "Clear baseline": "Borrar línea base",
      // PERT (estimación de tres puntos)
      "Apply PERT estimates": "Aplicar estimaciones PERT",
      "Every three-point estimate becomes a duration: (optimistic + 4×most likely + pessimistic) / 6":
        "Cada estimación de tres puntos se vuelve duración: (optimista + 4×más probable + pesimista) / 6",
      "Estimate (PERT)": "Estimación (PERT)",
      "PERT three-point estimate: the expected duration is (o + 4m + p)/6":
        "Estimación PERT de tres puntos: la duración esperada es (o + 4m + p)/6",
      "optimistic": "optimista",
      "most likely": "más probable",
      "pessimistic": "pesimista",
      "use as duration": "usar como duración",
      "no estimate": "sin estimación",
      "expected": "esperada",
      "PERT": "PERT",
      "estimated tasks on the critical path": "tareas estimadas en la ruta crítica",
      "Zoom: day": "Zoom: día", "Zoom: week": "Zoom: semana", "Zoom: month": "Zoom: mes",
      "Critical path": "Ruta crítica",
      "Go to today": "Ir a hoy",
      "Dark mode": "Modo oscuro",
      "Presentation mode": "Modo presentación",
      "Keyboard shortcuts": "Atajos de teclado",
      "About Perth": "Acerca de Perth",
      "save to": "guardar en",
      "Save": "Guardar",
      "Save in this folder": "Guardar en esta carpeta",
      "+ Task": "+ Tarea",
      "Day": "Día", "Week": "Semana", "Month": "Mes", "Today": "Hoy",
       "start": "inicio", "dur": "dur",
      "Density": "Densidad", "Cozy": "Cómoda", "Compact": "Compacta",
      "Task panel width": "Ancho del panel de tareas",
      "Weekend shading": "Sombrear fines de semana",
      "Bar labels": "Etiquetas en las barras",
      "Baseline bars": "Barras de línea base",
      "Language": "Idioma",
      "project schedules, from the REPL to the browser":
        "cronogramas de proyecto, del REPL al navegador",
      "New project": "Nuevo proyecto",
      "Import saved project": "Importar proyecto guardado",
      "Continue where I left off": "Continuar donde lo dejé",
      "recent": "recientes",
      "Task": "Tarea", "Name": "Nombre", "Assignee": "Responsable",
      "Collaborators": "Colaboradores",
      "Role": "Cargo", "Team": "Área", "Email": "Correo",
      "Lanes: none": "Carriles: ninguno",
      "Statistics…": "Estadísticas…",
      "Calendar bands…": "Períodos del calendario…",
      "Marked days…": "Días marcados…",
      "Fit": "Ajustar",
      "Zoom: fit": "Zoom: ajustar",
      "Fit the whole project on screen": "Ajustar todo el proyecto a la pantalla",
      "zoom day / week / month / fit": "zoom día / semana / mes / ajustar",
      "Drag to the task that follows": "Arrastra hasta la tarea que sigue",
      "Drag to the task that comes before": "Arrastra hasta la tarea anterior",
      "Double-click to remove": "Doble clic para quitar",
      "Already linked": "Esas dos ya están enlazadas",
      "A summary is scheduled by its subtasks — link one of them": "Un resumen lo programan sus subtareas — enlaza una de ellas",
      "A task and its own block are already tied": "Una tarea y su propio bloque ya están atados",
      "That would close a loop": "Eso cerraría un ciclo",
      "Collapse": "Contraer",
      "Expand": "Expandir",
      "Marked days": "Días marcados",
      "No marked days yet.": "Todavía no hay días marcados.",
      "Calendar bands": "Períodos del calendario",
      "No bands yet.": "Todavía no hay períodos.",
      "Colour": "Color",
      "Remove": "Quitar",
      "Statistics": "Estadísticas",
      "People": "Personas",
      "Teams": "Áreas",
      "Person": "Persona",
      "effort": "esfuerzo",
      "done": "hecho",
      "over": "exceso",
      "late": "atrasadas",
      "Nothing assigned yet.": "Nada asignado todavía.",
      "Could not load statistics": "No se pudieron cargar las estadísticas",
      "Lanes: assignee": "Carriles: responsable",
      "Lanes: team": "Carriles: área",
      "(no team)": "(sin área)",
      "Collaborators…": "Colaboradores…",
      "Add": "Añadir",
      "task": "tarea",
      "No collaborators registered yet.": "Aún no hay colaboradores registrados.",
      "Remove from list (tasks keep the name)": "Quitar de la lista (las tareas conservan el nombre)",
      "Also assigned in this project": "También aparecen en este proyecto",
      "Register these": "Registrar estos",
      "Parent (WBS)": "Padre (WBS)", "Start": "Inicio",
      "Duration (days)": "Duración (días)", "Progress (%)": "Progreso (%)",
      "Color": "Color", "Automatic": "Automático",
      "Julia purple": "Morado Julia", "Julia green": "Verde Julia",
      "Julia red": "Rojo Julia", "Julia blue": "Azul Julia", "Amber": "Ámbar",
      "Milestone": "Hito",
      // plazo (compromiso) y fecha fija
      "Deadline": "Fecha límite",
      "deadline": "fecha límite",
      "Pin start date": "Fijar la fecha de inicio",
      "pinned start": "fecha de inicio fija",
      "auto-schedule wants": "el auto-schedule quiere",
      "Past deadline": "Fuera de plazo",
      "Pinned start": "Fecha fija",
      "Commitment: never moves the task, but busting it turns the slack of this task and of everything feeding it negative":
        "Compromiso: nunca mueve la tarea, pero incumplirlo vuelve negativa la holgura de ella y de todo lo que la alimenta",
      "Contract date: auto-schedule leaves it where it is":
        "Fecha contractual: el auto-schedule no la mueve",
      "Summary task: start, duration and progress roll up from its subtasks.":
        "Tarea resumen: inicio, duración y progreso se derivan de sus subtareas.",
      "Depends on": "Depende de", "Notes": "Notas",
      "Delete": "Eliminar", "Cancel": "Cancelar", "Close": "Cerrar",
      "Perth.jl on GitHub": "Perth.jl en GitHub",
      "Source on GitHub": "Código en GitHub",
      "Toggle dark mode (D)": "Alternar modo oscuro (D)",
      "Presentation mode (P)": "Modo presentación (P)",
      "Exit presentation mode (Esc)": "Salir del modo presentación (Esc)",
      "Interface settings": "Configuración de la interfaz",
      "Mirror the project to a .perth.jl file on every save":
        "Reflejar el proyecto en un archivo .perth.jl en cada guardado",
      "Browse folders": "Explorar carpetas",
      "Parent folder": "Carpeta superior",
      "Active project": "Proyecto activo",
      "Highlight tasks by assignee, status or type":
        "Resaltar tareas por responsable, estado o tipo",
      "Center on today": "Centrar en hoy",
      "Project completion": "Avance del proyecto",
      "Board": "Tablero",
      "Switch board": "Cambiar de tablero",
      "New card": "Nueva tarjeta",
      "New column…": "Nueva columna…",
      "Boards…": "Tableros…",
      "Archived cards…": "Tarjetas archivadas…",
      "Share / QR…": "Compartir / QR…",
      // fundo da UI (Perth.background!)
      "Hide background": "Ocultar el fondo",
      "hide background image": "ocultar la imagen de fondo",
      // etiqueta de card criado hoje (kanban)
      "new": "nueva",
      "added today": "creada hoy",
      "hide new-card badges": "ocultar la etiqueta de tarjeta nueva",
      // transmitir (share): diálogo de compartilhamento e avisos
      "Transmit to your network": "Transmitir a tu red",
      "Transmitting — click to stop": "Transmitiendo — clic para parar",
      "Share this board": "Compartir este tablero",
      "Share this project": "Compartir este proyecto",
      "Transmitting to your network": "Transmitiendo a tu red",
      "Localhost only": "Solo en esta máquina",
      "Start transmitting": "Transmitir",
      "Stop transmitting": "Dejar de transmitir",
      "Transmission on": "Transmisión activada",
      "Transmission off": "Transmisión desactivada",
      "Nobody else can reach this board yet — start transmitting to hand out a link.":
        "Nadie más llega a este tablero todavía — transmite para poder pasar un enlace.",
      "Nobody else can reach this server yet — start transmitting to hand out a link.":
        "Nadie más llega a este servidor todavía — transmite para poder pasar un enlace.",
      "Localhost only — the machine running Perth turns transmission on.":
        "Solo en esta máquina — la máquina que ejecuta Perth activa la transmisión.",
      "Scan with a phone on the same Wi-Fi to open":
        "Escanea con un teléfono en la misma Wi-Fi para abrir",
      "Tip: run `using QRCoders` before Perth.kanban() to get a QR code here and in the terminal.":
        "Consejo: ejecuta `using QRCoders` antes de Perth.kanban() para ver un código QR aquí y en la terminal.",
      "Tip: run `using QRCoders` before Perth.run() to get a QR code here and in the terminal.":
        "Consejo: ejecuta `using QRCoders` antes de Perth.run() para ver un código QR aquí y en la terminal.",
      "The machine running Perth stopped transmitting this board.":
        "La máquina que ejecuta Perth dejó de transmitir este tablero.",
      "The machine running Perth stopped transmitting these projects.":
        "La máquina que ejecuta Perth dejó de transmitir estos proyectos.",
      "try again": "intentar de nuevo",
      "Access key": "Clave de acceso",
      "These projects require an access key. Ask whoever started the server.":
        "Estos proyectos requieren una clave de acceso. Pídesela a quien inició el servidor.",
      "This board requires an access key. Ask whoever started the server.":
        "Este tablero requiere una clave de acceso. Pídesela a quien inició el servidor.",
      "access key": "clave de acceso",
      "enter": "entrar",
      "enter board": "entrar al tablero",
      "Access key required": "Clave de acceso requerida",
      "No access key": "Sin clave de acceso",
      "starts before its dependencies allow": "empieza antes de lo que permiten sus dependencias",
      "can start on": "puede empezar el",
      "Label position": "Posición del texto",
      "Baseline": "Línea base",
      // glossário e vocabulário novo (0.8.8/0.8.9)
      "A date fixed by hand — a contract, a delivery window. Auto-schedule leaves it alone, and says so when the plan no longer fits it.":
        "Una fecha fijada a mano — un contrato, una ventana de entrega. La programación automática no la mueve, y avisa cuando el plan ya no cabe en ella.",
      "A date the task must not finish after. It never moves anything: it turns the slack of this task, and of everything feeding it, negative.":
        "Una fecha después de la cual la tarea no puede terminar. No mueve nada: vuelve negativa la holgura de esta tarea y de todo lo que la alimenta.",
      "A date with nothing lasting: a delivery, an approval, a signature. Drawn as a diamond and never has a duration.":
        "Una fecha sin nada que dure: una entrega, una aprobación, una firma. Se dibuja como rombo y nunca tiene duración.",
      "A frozen copy of the plan — what was promised. The ghost bars are the baseline; the difference between them and the bars is the slippage.":
        "Una copia congelada del plan — lo prometido. Las barras fantasma son la línea base; la diferencia entre ellas y las barras es el desvío.",
      "A named stretch of calendar shaded behind the chart: a sprint, a shutdown, the rainy season. Annotation — it never moves a task.":
        "Un tramo de calendario con nombre, sombreado detrás del gráfico: un sprint, una parada, la temporada de lluvias. Es anotación — nunca mueve una tarea.",
      "A named vertical line across the chart, like the today line: an inspection, a hand-over, a holiday.":
        "Una línea vertical con nombre que cruza el gráfico, como la línea de hoy: una inspección, una entrega, un feriado.",
      "A piece of work with a start and a duration — a bar on the chart.":
        "Un trabajo con un inicio y una duración — una barra en el gráfico.",
      "A task with subtasks. Its dates and its progress are not typed in — they are rolled up from its children.":
        "Una tarea con subtareas. Sus fechas y su avance no se escriben — suben desde sus hijas.",
      "A waits for B and B waits for A. Nothing can be scheduled until the loop is cut — this is the one warning that stops the engine.":
        "A espera a B y B espera a A. Nada puede programarse hasta cortar el lazo — es el único aviso que detiene el motor.",
      "Auto-schedule":
        "Programar automáticamente",
      "Calendar band":
        "Banda del calendario",
      "Dependency":
        "Dependencia",
      "Duration":
        "Duración",
      "Finish":
        "Término",
      "Group the rows by person or by team, instead of by the WBS.":
        "Agrupan las filas por persona o por equipo, en vez de por la EDT.",
      "How many days a task can slip before it starts pushing the finish. Zero slack is the critical path; negative slack is a promise already broken.":
        "Cuántos días puede atrasarse una tarea antes de empujar el término. Holgura cero es la ruta crítica; holgura negativa es una promesa ya rota.",
      "How much each person has on each day. It is what turns a plan into a question about people.":
        "Cuánto tiene cada persona cada día. Es lo que convierte un plan en una pregunta sobre gente.",
      "How much of the task is done, in percent. A summary averages its children, weighted by duration.":
        "Cuánto de la tarea está hecho, en porcentaje. Un resumen promedia sus hijas, ponderado por duración.",
      "How much of the work was planned to be done by each date, drawn against how much is done. The gap between the two curves is the delay, in work rather than in days.":
        "Cuánto del trabajo estaba previsto para cada fecha, dibujado contra cuánto está hecho. La distancia entre las dos curvas es el atraso, medido en trabajo y no en días.",
      "Lanes":
        "Carriles",
      "Length of the task in days. With a business-day calendar set, weekends and holidays do not count.":
        "El largo de la tarea en días. Con un calendario de días hábiles, fines de semana y feriados no cuentan.",
      "Marked day":
        "Día marcado",
      "Moves every task to the earliest date its dependencies allow. It never invents work — it only closes the gaps the plan does not need.":
        "Lleva cada tarea a la fecha más temprana que permiten sus dependencias. No inventa trabajo — solo cierra los huecos que el plan no necesita.",
      "On the chart":
        "En el gráfico",
      "P80":
        "P80",
      "Progress":
        "Avance",
      "Sequence (#)":
        "Secuencia (#)",
      "Slack":
        "Holgura",
      "Summary":
        "Resumen",
      "Task order — drag a row to change it":
        "Orden de las tareas — arrastra una fila para cambiarlo",
      "The breakdown of the plan into blocks and sub-blocks: which task is inside which. The indentation in the table is the WBS.":
        "El desglose del plan en bloques y subbloques: qué tarea está dentro de cuál. La sangría de la tabla es la EDT.",
      "The chain of tasks with no slack. A day lost in any of them is a day lost by the whole project — which is why it is worth looking at first.":
        "La cadena de tareas sin holgura. Un día perdido en cualquiera de ellas es un día perdido por todo el proyecto — por eso es lo primero que hay que mirar.",
      "The dates say one thing and the arrows say another: the task begins earlier than its predecessors let it. A dependency never moves anything on its own — auto-schedule (S) is what puts it where it can go, unless the start is pinned.":
        "Las fechas dicen una cosa y las flechas otra: la tarea empieza antes de lo que permiten sus predecesoras. Una dependencia no mueve nada por sí sola — quien la pone donde cabe es la programación automática (S), salvo que la fecha esté fijada.",
      "The day has passed and the task is not at 100%.":
        "El día pasó y la tarea no está al 100%.",
      "The end of the project as the engine computes it, from the dependencies and the durations.":
        "El fin del proyecto según lo calcula el motor, a partir de las dependencias y las duraciones.",
      "The finish date with an 80% chance of being met, from the PERT estimates. The date to promise when the plan has uncertainty in it.":
        "La fecha de término con 80% de probabilidad de cumplirse, a partir de las estimaciones PERT. Es la fecha que se promete cuando el plan tiene incertidumbre.",
      "The plan":
        "El plan",
      "The planned weight of the task, in whatever unit you use. Left at zero, the duration in person-days is the weight in the S-curve.":
        "El peso previsto de la tarea, en la unidad que uses. Dejado en cero, la duración en persona-día es el peso en la curva S.",
      "The position of the row. Drag a row up or down to choose it; where nobody chose, rows come by start date.":
        "La posición de la fila. Arrástrala hacia arriba o abajo para elegirla; donde nadie eligió, las filas van por fecha de inicio.",
      "Two tasks of the same person on a day that carries more work than it holds. With a capacity declared for that person, \"more than it holds\" means over the capacity; without one, it falls back to the cruder rule that any two tasks on the same day are too many.":
        "Dos tareas de la misma persona en un día que carga más trabajo del que cabe. Con una capacidad declarada para esa persona, \"más de lo que cabe\" significa por encima de la capacidad; sin ella, rige la regla más cruda de que dos tareas cualesquiera el mismo día ya son demasiadas.",
      "How much work a person absorbs in one working day, in the same unit as a task's effort — 8 for hours, 1 for a full-time person-day, 0.5 for half time. Declaring it is what lets two one-hour tasks stop counting as an overload. Empty means not declared, and the old rule applies.":
        "Cuánto trabajo absorbe una persona en un día hábil, en la misma unidad que el esfuerzo de la tarea — 8 para horas, 1 para una persona-día completa, 0.5 para media jornada. Declararlo es lo que hace que dos tareas de una hora dejen de contar como sobrecarga. Vacío significa no declarada, y rige la regla antigua.",
      "How much work a task is, in the same unit as a person's capacity. It never moves the task: two hours of work inside a task that spans a week is a statement about load, not about dates. Empty falls back to the cost, and then to the duration in person-days.":
        "Cuánto trabajo es una tarea, en la misma unidad que la capacidad de la persona. Nunca mueve la tarea: dos horas de trabajo dentro de una tarea que ocupa una semana es una afirmación sobre carga, no sobre fechas. Vacío cae en el costo, y luego en la duración en persona-días.",
      "The task finishes after the date it had promised.":
        "La tarea termina después de la fecha que había prometido.",
      "The task is later than it was in the frozen plan.":
        "La tarea está más tarde de lo que estaba en el plan congelado.",
      "Three estimates instead of one — optimistic, most likely, pessimistic — worth (o + 4m + p) / 6 as the expected duration. It says how uncertain a task is, not only how long it is.":
        "Tres estimaciones en vez de una — optimista, más probable, pesimista — que valen (o + 4m + p) / 6 como duración esperada. Dice cuán incierta es una tarea, no solo cuánto dura.",
      "Time":
        "Tiempo",
      "Turn lanes off to reorder tasks by hand.":
        "Apaga los carriles para ordenar las tareas a mano.",
      "View selected task":
        "Ver tarea seleccionada",
      "WBS":
        "EDT (WBS)",
      "What overallocation, slack, baseline, PERT and the rest actually mean":
        "Qué significan de verdad sobrecarga, holgura, línea base, PERT y el resto",
      "What the engine computes":
        "Lo que calcula el motor",
      "What the words mean":
        "Qué quieren decir las palabras",
      "Workload":
        "Carga",
      "\"This only starts after that.\" Finish-to-start is the default; start-to-start and finish-to-finish tie the two starts or the two finishes; lag adds or removes days.":
        "\"Esto solo empieza después de aquello.\" Fin-inicio es lo normal; inicio-inicio y fin-fin atan los dos comienzos o los dos finales; el desfase suma o resta días.",
      "overallocation":
        "sobrecarga",
      "past deadline":
        "plazo vencido",
      "move the selection": "mover la selección",
      "collapse / expand a summary": "plegar / abrir un resumen",
      "first / last task": "primera / última tarea",
      "zoom keeping the date under the pointer": "zoom manteniendo la fecha bajo el puntero",
      "Marked months": "Meses marcados",
      "Marked months…": "Meses marcados…",
      "No marked months yet.": "Ningún mes marcado todavía.",
      "Name (optional)": "Nombre (opcional)",
      "read-only": "solo lectura",
      "Read-only link — ask for an editing link to change anything.":
        "Enlace de solo lectura — pide un enlace de edición para cambiar algo.",
      "Read-only link on": "Enlace de solo lectura activo",
      "No read-only link": "Sin enlace de solo lectura",
      "new read-only key": "nueva clave de lectura",
      "read-only key": "clave de lectura",
      "Whoever opens the link below sees the projects and cannot change them — not even through the chat. This machine always edits, so the link starts at your network address.":
        "Quien abra el enlace de abajo ve los proyectos y no puede cambiarlos — ni por el chat. Esta máquina siempre edita, así que el enlace empieza en tu dirección de red.",
      "A second link that opens the projects and refuses to change them — for a client, a director, the whole site.":
        "Un segundo enlace que abre los proyectos y se niega a cambiarlos — para un cliente, una dirección, toda la obra.",
      "Start transmitting to get the read-only link.":
        "Enciende la transmisión para tener el enlace de solo lectura.",
      "new access key": "nueva clave",
      "apply": "aplicar",
      "remove": "quitar",
      "The links below already carry the key. Changing it disconnects everyone on the network — they are asked for the new one.":
        "Los enlaces de abajo ya llevan la clave. Cambiarla desconecta a todos en la red — a cada uno se le pide la nueva.",
      "Without a key, anyone on the network who knows the port can open and edit these projects.":
        "Sin clave, cualquiera en la red que sepa el puerto puede abrir y editar estos proyectos.",
      "Without a key, anyone on the network who knows the port can open and edit this board.":
        "Sin clave, cualquiera en la red que sepa el puerto puede abrir y editar este tablero.",
      "wrong key — try again": "clave incorrecta — inténtalo de nuevo",
      "could not load share info": "no se pudo cargar la información de compartir",
      "not sharing": "sin transmisión",
      "Rename machines…": "Renombrar máquinas…",
      "Auto-archive…": "Autoarchivar…",
      "Delete selected card": "Eliminar tarjeta seleccionada",
      "Reset board…": "Restablecer tablero…",
      "Resync with server": "Resincronizar con el servidor",
      "filter cards…  ( / )": "filtrar tarjetas…  ( / )",
      "your name (shown on your cursor)": "tu nombre (se muestra en tu cursor)",
      "e.g. dante": "p. ej. dante",
      "empty = shows the machine IP only": "vacío = muestra solo la IP de la máquina",
      "notification sound": "sonido de notificación",
      "your name on the board": "tu nombre en el tablero",
      "connected machines": "máquinas conectadas",
      "connecting…": "conectando…",
      "live": "en vivo",
      "reconnecting…": "reconectando…",
      "access denied": "acceso denegado",
      "Activity…": "Actividad…",
      "Export tasks (CSV)": "Exportar tareas (CSV)",
      "Export calendar (.ics)": "Exportar calendario (.ics)",
      "Milestones and deadlines as an .ics file for your calendar app":
        "Hitos y fechas límite en un archivo .ics para tu aplicación de calendario",
      "Export chart (PNG)": "Exportar gráfico (PNG)",
      "S-curve…": "Curva S…",
      "Metrics…": "Métricas…",
      "Cost": "Costo",
      "lag": "desfase",
      "Activity": "Actividad",
      "S-curve": "Curva S",
      "Metrics": "Métricas",
      "no activity yet": "sin actividad todavía",
      "planned": "planificado",
      "actual": "real",
      "planned to date": "planificado a la fecha",
      "earned to date": "realizado a la fecha",
      "total": "total",
      // panel de recursos (gantt)
      "Resources": "Recursos",
      "resources": "recursos",
      "Close (R)": "Cerrar (R)",
      "(unassigned)": "(sin responsable)",
      "no one assigned yet": "nadie asignado todavía",
      "busy days": "días ocupados",
      "peak": "pico",
      "person-days": "persona-días",
      "tasks": "tareas",
      "avg lead time": "lead time promedio",
      "days": "días",
      "done last 7 days": "completadas en los últimos 7 días",
      "done last 30 days": "completadas en los últimos 30 días",
      "cards in progress": "tarjetas en curso",
      "oldest in progress": "más antigua en curso",
      "not enough data yet — complete some cards first": "aún no hay datos suficientes — completa algunas tarjetas primero",
      "Project changed on another machine — reloaded": "El proyecto cambió en otra máquina — recargado",
      "Open Kanban": "Abrir el Kanban",
      "Open Gantt": "Abrir el Gantt",
      "Hide other cursors": "Ocultar cursores de los demás",
      "hide other people's cursors": "ocultar los cursores de los demás",
      "more connected machines": "más máquinas conectadas",
      "Permissions…": "Permisos…",
      "Permissions": "Permisos",
      "add card": "crear tarjeta",
      "edit card text": "editar texto de la tarjeta",
      "edit card description": "editar descripción de la tarjeta",
      "delete card": "eliminar tarjeta",
      "move card between columns": "mover tarjeta entre columnas",
      "mark card done": "completar tarjeta",
      "archive card": "archivar tarjeta",
      "restore from archive": "restaurar del archivo",
      "delete archived forever": "eliminar del archivo para siempre",
      "set assignee": "definir responsable",
      "set due date": "definir fecha límite",
      "attach images": "adjuntar imágenes",
      "add checklist item": "añadir elemento a la lista de verificación",
      "check/uncheck checklist item": "marcar/desmarcar elemento de la lista",
      "delete checklist item": "eliminar elemento de la lista",
      "add column": "crear columna",
      "rename column": "renombrar columna",
      "delete column": "eliminar columna",
      "reorder columns": "reordenar columnas",
      "set WIP limit": "definir límite de WIP",
      "sort column by due date": "ordenar columna por fecha límite",
      // o card como documento (caixa expandida, código, imagens)
      "Card": "Tarjeta",
      "card title — one line": "título de la tarjeta — una línea",
      "description — **bold**, `code`, ``` for a block · paste an image": "descripción — **negrita**, `código`, ``` para bloque · pega una imagen",
      "is editing this card right now": "está editando esta tarjeta ahora",
      "open card": "abrir tarjeta",
      "description…": "descripción…",
      "open card (description, code, images)": "abrir tarjeta (descripción, código, imágenes)",
      "description, code and images": "descripción, código e imágenes",
      "bold": "negrita",
      "italic": "cursiva",
      "strikethrough": "tachado",
      "inline code": "código",
      "code block": "bloque de código",
      "list item": "elemento de lista",
      "link": "enlace",
      "Link address": "Dirección del enlace",
      "text": "texto",
      "code": "código",
      "remove image": "quitar imagen",
      "attached image": "imagen adjunta",
      "a card holds at most": "una tarjeta admite como máximo",
      "images": "imágenes",
      "could not attach the image": "no se pudo adjuntar la imagen",
      "Restricted by the host": "Restringido por el host",
      "The host restricted this action for your machine": "El host restringió esta acción para tu máquina",
      "Someone changed this since your edit — undo skipped": "Alguien cambió esto después de tu edición — deshacer omitido",
      "Chat": "Chat",
      "Close (Esc)": "Cerrar (Esc)",
      "Send (Enter)": "Enviar (Enter)",
      "Message the team…": "Mensaje para el equipo…",
      "Message the board…": "Mensaje para el tablero…",
      "No messages yet — say hi.": "Aún no hay mensajes — saluda.",
      "No other machines have connected yet.": "Todavía no se ha conectado ninguna otra máquina.",
      "check/uncheck everything": "marcar/desmarcar todo",
      "check/uncheck this action for everyone": "marcar/desmarcar esta acción para todos",
      "check/uncheck this machine": "marcar/desmarcar esta máquina",
      "Unchecked = blocked on that machine. The host machine is always allowed here, no matter this matrix.":
        "Sin marcar = bloqueado en esa máquina. La máquina del host siempre tiene permiso aquí, sin importar esta matriz.",
      // etiqueta de versão (barra de status dos dois apps)
      "Perth version": "Versión de Perth",
    },

    fr: {
      "A task with zero slack that more than one other task is waiting on. The critical path already tells you a task cannot slip; the bottleneck tells you where the chain becomes a funnel, and that is the one worth protecting first. It is derived from the plan, never typed: a hand-set flag would be wrong the moment somebody drags a bar.":
        "Tâche à marge nulle que plus d'une autre attend. Le chemin critique dit déjà qu'elle ne peut pas glisser ; le goulot dit où la chaîne devient entonnoir, et c'est celle-là qu'il faut protéger d'abord. C'est dérivé du plan, jamais saisi : un indicateur posé à la main serait faux dès que quelqu'un déplace une barre.",
      "Work stopped and expected to resume — a state nothing in the plan can reveal, so it is the one thing you declare rather than Perth deducing. It changes no arithmetic: the task keeps its dates, its load and its place on the critical path. What it stops is the reader's assumption that a bar on the chart means somebody is on it.":
        "Le travail s'est arrêté et doit reprendre — un état que rien dans le plan ne révèle, et donc le seul qui se déclare au lieu que Perth le déduise. Cela ne change aucun calcul : la tâche garde ses dates, sa charge et sa place sur le chemin critique. Ce qu'il interrompt, c'est l'hypothèse du lecteur qu'une barre veut dire quelqu'un dessus.",
      // situação declarada e gargalo derivado
      "Status": "Situation",
      "Normal": "Normal",
      "On hold": "En pause",
      "Bottleneck": "Goulot d'étranglement",
      "A state only you can know: work stopped and expected to resume. It changes nothing in the schedule — the task keeps its dates, its load and its place on the critical path.":
        "Un état que vous seul connaissez : le travail s'est arrêté et doit reprendre. Cela ne change rien au planning — la tâche garde ses dates, sa charge et sa place sur le chemin critique.",
      "progress in tenths, on the whole selection (100% by dragging the fill)":
        "avancement par dixièmes, sur toute la sélection (100% en tirant le remplissage)",
      // mesclagem quando duas máquinas gravam o mesmo projeto
      "Merged with the change from the other machine":
        "Fusionné avec la modification de l'autre machine",
      "Merged with the other machine — theirs kept in":
        "Fusionné avec l'autre machine — sa version conservée sur",
      // curva-S: as duas réguas
      "work": "travail",
      "cost": "coût",
      // capacité par personne et charge de la tâche
      "Capacity per day": "Capacité par jour",
      "Effort": "Charge",
      "capacity": "capacité",
      "day": "jour",
      "of work": "de travail",
      "from": "depuis",
      "over capacity": "au-dessus de la capacité",
      "How much work this person absorbs in one working day, in the same unit as a task's effort. Empty = not declared.":
        "Combien de travail cette personne absorbe en un jour ouvré, dans la même unité que la charge d'une tâche. Vide = non déclarée.",
      "How much work this task is, in the same unit as a person's capacity per day. It never moves the task. Empty falls back to the cost, and then to the duration in person-days.":
        "Combien de travail représente cette tâche, dans la même unité que la capacité journalière d'une personne. Elle ne déplace jamais la tâche. Vide retombe sur le coût, puis sur la durée en jours-personne.",
      // sélection multiple et actions groupées (gantt et kanban)
      "Select all tasks": "Tout sélectionner",
      "Select all cards": "Sélectionner toutes les cartes",
      "Edit selected tasks…": "Modifier les tâches sélectionnées…",
      "Edit selected tasks": "Modifier les tâches sélectionnées",
      "Push the dates, change the assignee or the colour of everything selected, in one go":
        "Décaler les dates, changer le responsable ou la couleur de toute la sélection, d'un coup",
      "Mark selection done": "Terminer la sélection",
      "Assign selection…": "Affecter la sélection…",
      "Archive selection": "Archiver la sélection",
      "tasks selected": "tâches sélectionnées",
      "cards selected": "cartes sélectionnées",
      "Shift start dates by": "Décaler les dates de",
      "automatic": "automatique",
      "nobody": "personne",
      "Apply": "Appliquer",
      "a block moves its own subtasks — a summary has no date of its own":
        "un bloc décale ses propres sous-tâches — un résumé n'a pas de date propre",
      "Delete this task?": "Supprimer cette tâche ?",
      "Delete these tasks?": "Supprimer ces tâches ?",
      "Delete these cards?": "Supprimer ces cartes ?",
      "Assign to whom? (empty clears)": "Affecter à qui ? (vide efface)",
      "extend the selection": "étendre la sélection",
      "add or remove one task from the selection":
        "ajouter ou retirer une tâche de la sélection",
      "add or remove one card from the selection":
        "ajouter ou retirer une carte de la sélection",
      "select everything in between": "sélectionner tout ce qui est entre les deux",
      "select everything in between (same column)":
        "sélectionner tout entre les deux (même colonne)",
      "select all — with a filter on, only what it leaves lit":
        "tout sélectionner — avec un filtre actif, seulement ce qu'il laisse allumé",
      "edit the whole selection (dates, assignee, colour)":
        "modifier toute la sélection (dates, responsable, couleur)",
      "archive the selection": "archiver la sélection",
      "mark the selection done": "terminer la sélection",
      "File": "Fichier", "Edit": "Édition", "View": "Affichage", "Help": "Aide",
      "Home screen": "Écran d'accueil",
      "New project…": "Nouveau projet…",
      "Rename project…": "Renommer le projet…",
      "Import project (.jl)…": "Importer un projet (.jl)…",
      "Export project (.jl)": "Exporter le projet (.jl)",
      "Delete project…": "Supprimer le projet…",
      "New task": "Nouvelle tâche", "Edit task": "Modifier la tâche",
      "the plan cannot be scheduled while it exists": "le plan ne peut pas être planifié tant qu'il existe",
      "ended": "terminée le",
      "Warnings": "Avertissements",
      "Problems found in this plan": "Problèmes trouvés dans ce plan",
      "Problems that stop the plan from being scheduled": "Problèmes qui empêchent de planifier",
      "nothing wrong with this plan": "rien à signaler dans ce plan",
      "dependency cycle": "cycle de dépendances",
      "past the deadline": "échéance dépassée",
      "overdue": "en retard",
      "overallocated": "surcharge",
      "behind the baseline": "en retard sur la référence",
      "find a task…  ( / )": "chercher une tâche…  ( / )",
      "Find a task by name": "Chercher une tâche par son nom",
      "Import failed": "Échec de l'importation",
      "Auto-schedule failed": "Échec de la replanification",
      "could not open the gantt": "impossible d'ouvrir le gantt",
      "new task": "nouvelle tâche",
      "edit task": "modifier la tâche",
      "delete selected task": "supprimer la tâche sélectionnée",
      "duplicate selected task": "dupliquer la tâche sélectionnée",
      "undo": "annuler",
      "redo": "rétablir",
      "auto-schedule": "replanifier automatiquement",
      "toggle critical path": "afficher le chemin critique",
      "resource load": "charge des ressources",
      "toggle dark mode": "basculer le mode sombre",
      "presentation mode": "mode présentation",
      "go to today": "aller à aujourd'hui",
      "close / deselect / exit presentation": "fermer / désélectionner / quitter la présentation",
      "new card": "nouvelle carte",
      "edit selected card": "modifier la carte sélectionnée",
      "delete selected card": "supprimer la carte sélectionnée",
      "filter cards": "filtrer les cartes",
      "Gantt charts with a Julia backend.": "Diagrammes de Gantt avec un backend en Julia.",
      "Data lives on the local server; edit from the REPL too:": "Les données vivent sur le serveur local ; on peut aussi éditer depuis le REPL :",
      "my project": "mon projet",
      "double-click to rename": "double-cliquer pour renommer",
      "WIP limit exceeded": "limite d'en-cours dépassée",
      "assigned to": "de",
      "click to filter": "cliquer pour filtrer",
      "click to edit": "cliquer pour modifier",
      "move to the archive": "déplacer vers les archives",
      "filter by": "filtrer par",
      "column options": "options de la colonne",
      "type and press Enter — #tags, **bold**, [links](url)…": "écrivez et appuyez sur Entrée — #tags, **gras**, [liens](url)…",
      "name": "nom",
      "remove item": "retirer l'élément",
      "+ checklist item": "+ élément de la liste",
      "close (Esc)": "fermer (Échap)",
      "delete forever (cannot be undone)": "supprimer définitivement (irréversible)",
      "e.g. Paulo": "p. ex. Paulo",
      "switches the board for everyone": "change le tableau pour tout le monde",
      "new board name": "nom du nouveau tableau",
      "no subfolders": "aucun sous-dossier",
      "no project open": "aucun projet ouvert",
      "loading…": "chargement…",
      "copy": "copier",
      "copied!": "copié !",
      "+ card": "+ carte",
      "+ new column": "+ nouvelle colonne",
      "by": "par",
      "archive": "archiver",
      "due": "échéance",
      "assignee": "responsable",
      "restore": "restaurer",
      "delete": "supprimer",
      "current": "actuel",
      "switch": "changer",
      "create": "créer",
      "could not load the board list": "impossible de charger la liste des tableaux",
      "No other tasks in this project.": "Aucune autre tâche dans ce projet.",
      "No activity yet.": "Aucune activité pour le moment.",
      "Nothing archived yet — finish a card (✓) and hit \"archive\".": "Rien d'archivé pour le moment — terminez une carte (✓) puis cliquez sur \"archiver\".",
      "Names apply to everyone's screen: cursors, chips and card stamps. Empty = back to the IP.": "Les noms s'appliquent à l'écran de tous : curseurs, étiquettes et tampons des cartes. Vide = retour à l'IP.",
      "One board is active at a time — switching changes it for every connected machine.": "Un tableau actif à la fois — en changer le change pour toutes les machines connectées.",
      "Only the host machine can switch or create boards.": "Seule la machine hôte peut changer ou créer des tableaux.",
      "Discard this new task?": "Abandonner cette nouvelle tâche ?",
      "Discard the changes to this task?": "Abandonner les modifications de cette tâche ?",
      "(top level)": "(niveau supérieur)",
      "Edit selected task": "Modifier la tâche sélectionnée",
      "Duplicate selected task": "Dupliquer la tâche sélectionnée",
      "Delete selected task": "Supprimer la tâche sélectionnée",
      "Undo": "Annuler", "Redo": "Rétablir",
      "Auto-schedule (push successors)": "Planification auto (décaler les successeurs)",
      "Set baseline (snapshot plan)": "Définir la référence (instantané du plan)",
      "Clear baseline": "Effacer la référence",
      // PERT (estimation à trois points)
      "Apply PERT estimates": "Appliquer les estimations PERT",
      "Every three-point estimate becomes a duration: (optimistic + 4×most likely + pessimistic) / 6":
        "Chaque estimation à trois points devient une durée : (optimiste + 4×plus probable + pessimiste) / 6",
      "Estimate (PERT)": "Estimation (PERT)",
      "PERT three-point estimate: the expected duration is (o + 4m + p)/6":
        "Estimation PERT à trois points : la durée attendue est (o + 4m + p)/6",
      "optimistic": "optimiste",
      "most likely": "plus probable",
      "pessimistic": "pessimiste",
      "use as duration": "utiliser comme durée",
      "no estimate": "sans estimation",
      "expected": "attendue",
      "PERT": "PERT",
      "estimated tasks on the critical path": "tâches estimées sur le chemin critique",
      "Zoom: day": "Zoom : jour", "Zoom: week": "Zoom : semaine", "Zoom: month": "Zoom : mois",
      "Critical path": "Chemin critique",
      "Go to today": "Aller à aujourd'hui",
      "Dark mode": "Mode sombre",
      "Presentation mode": "Mode présentation",
      "Keyboard shortcuts": "Raccourcis clavier",
      "About Perth": "À propos de Perth",
      "save to": "enregistrer dans",
      "Save": "Enregistrer",
      "Save in this folder": "Enregistrer dans ce dossier",
      "+ Task": "+ Tâche",
      "Day": "Jour", "Week": "Semaine", "Month": "Mois", "Today": "Aujourd'hui",
       "start": "début", "dur": "dur",
      "Density": "Densité", "Cozy": "Confortable", "Compact": "Compacte",
      "Task panel width": "Largeur du panneau des tâches",
      "Weekend shading": "Griser les week-ends",
      "Bar labels": "Étiquettes des barres",
      "Baseline bars": "Barres de référence",
      "Language": "Langue",
      "project schedules, from the REPL to the browser":
        "plannings de projet, du REPL au navigateur",
      "New project": "Nouveau projet",
      "Import saved project": "Importer un projet enregistré",
      "Continue where I left off": "Reprendre où j'en étais",
      "recent": "récents",
      "Task": "Tâche", "Name": "Nom", "Assignee": "Responsable",
      "Collaborators": "Collaborateurs",
      "Role": "Poste", "Team": "Service", "Email": "Courriel",
      "Lanes: none": "Couloirs : aucun",
      "Statistics…": "Statistiques…",
      "Calendar bands…": "Périodes du calendrier…",
      "Marked days…": "Jours marqués…",
      "Fit": "Ajuster",
      "Zoom: fit": "Zoom : ajuster",
      "Fit the whole project on screen": "Ajuster tout le projet à l’écran",
      "zoom day / week / month / fit": "zoom jour / semaine / mois / ajuster",
      "Drag to the task that follows": "Glissez vers la tâche qui suit",
      "Drag to the task that comes before": "Glissez vers la tâche qui précède",
      "Double-click to remove": "Double-cliquez pour retirer",
      "Already linked": "Ces deux-là sont déjà liées",
      "A summary is scheduled by its subtasks — link one of them": "Un récapitulatif est planifié par ses sous-tâches — liez l’une d’elles",
      "A task and its own block are already tied": "Une tâche et son propre bloc sont déjà liés",
      "That would close a loop": "Cela fermerait une boucle",
      "Collapse": "Replier",
      "Expand": "Déplier",
      "Marked days": "Jours marqués",
      "No marked days yet.": "Aucun jour marqué pour l’instant.",
      "Calendar bands": "Périodes du calendrier",
      "No bands yet.": "Aucune période pour l’instant.",
      "Colour": "Couleur",
      "Remove": "Retirer",
      "Statistics": "Statistiques",
      "People": "Personnes",
      "Teams": "Services",
      "Person": "Personne",
      "effort": "charge",
      "done": "fait",
      "over": "surcharge",
      "late": "en retard",
      "Nothing assigned yet.": "Rien d’affecté pour l’instant.",
      "Could not load statistics": "Impossible de charger les statistiques",
      "Lanes: assignee": "Couloirs : responsable",
      "Lanes: team": "Couloirs : service",
      "(no team)": "(sans service)",
      "Collaborators…": "Collaborateurs…",
      "Add": "Ajouter",
      "task": "tâche",
      "No collaborators registered yet.": "Aucun collaborateur enregistré pour l’instant.",
      "Remove from list (tasks keep the name)": "Retirer de la liste (les tâches gardent le nom)",
      "Also assigned in this project": "Également affectés dans ce projet",
      "Register these": "Les enregistrer",
      "Parent (WBS)": "Parent (WBS)", "Start": "Début",
      "Duration (days)": "Durée (jours)", "Progress (%)": "Avancement (%)",
      "Color": "Couleur", "Automatic": "Automatique",
      "Julia purple": "Violet Julia", "Julia green": "Vert Julia",
      "Julia red": "Rouge Julia", "Julia blue": "Bleu Julia", "Amber": "Ambre",
      "Milestone": "Jalon",
      // échéance (engagement) et date épinglée
      "Deadline": "Échéance",
      "deadline": "échéance",
      "Pin start date": "Épingler la date de début",
      "pinned start": "date de début épinglée",
      "auto-schedule wants": "l'auto-planification veut",
      "Past deadline": "Hors délai",
      "Pinned start": "Début épinglé",
      "Commitment: never moves the task, but busting it turns the slack of this task and of everything feeding it negative":
        "Engagement : ne déplace jamais la tâche, mais le dépasser rend négative la marge de celle-ci et de tout ce qui l'alimente",
      "Contract date: auto-schedule leaves it where it is":
        "Date contractuelle : l'auto-planification ne la déplace pas",
      "Summary task: start, duration and progress roll up from its subtasks.":
        "Tâche récapitulative : début, durée et avancement dérivent des sous-tâches.",
      "Depends on": "Dépend de", "Notes": "Notes",
      "Delete": "Supprimer", "Cancel": "Annuler", "Close": "Fermer",
      "Perth.jl on GitHub": "Perth.jl sur GitHub",
      "Source on GitHub": "Code source sur GitHub",
      "Toggle dark mode (D)": "Basculer le mode sombre (D)",
      "Presentation mode (P)": "Mode présentation (P)",
      "Exit presentation mode (Esc)": "Quitter le mode présentation (Échap)",
      "Interface settings": "Réglages de l'interface",
      "Mirror the project to a .perth.jl file on every save":
        "Refléter le projet dans un fichier .perth.jl à chaque enregistrement",
      "Browse folders": "Parcourir les dossiers",
      "Parent folder": "Dossier parent",
      "Active project": "Projet actif",
      "Highlight tasks by assignee, status or type":
        "Surligner les tâches par responsable, statut ou type",
      "Center on today": "Centrer sur aujourd'hui",
      "Project completion": "Avancement du projet",
      "Board": "Tableau",
      "Switch board": "Changer de tableau",
      "New card": "Nouvelle carte",
      "New column…": "Nouvelle colonne…",
      "Boards…": "Tableaux…",
      "Archived cards…": "Cartes archivées…",
      "Share / QR…": "Partager / QR…",
      // fundo da UI (Perth.background!)
      "Hide background": "Masquer le fond",
      "hide background image": "masquer l'image de fond",
      // etiqueta de card criado hoje (kanban)
      "new": "nouveau",
      "added today": "ajouté aujourd'hui",
      "hide new-card badges": "masquer le badge des nouvelles cartes",
      // transmitir (share): diálogo de compartilhamento e avisos
      "Transmit to your network": "Diffuser sur votre réseau",
      "Transmitting — click to stop": "Diffusion en cours — cliquez pour arrêter",
      "Share this board": "Partager ce tableau",
      "Share this project": "Partager ce projet",
      "Transmitting to your network": "Diffusion sur votre réseau",
      "Localhost only": "Cette machine uniquement",
      "Start transmitting": "Diffuser",
      "Stop transmitting": "Arrêter la diffusion",
      "Transmission on": "Diffusion activée",
      "Transmission off": "Diffusion désactivée",
      "Nobody else can reach this board yet — start transmitting to hand out a link.":
        "Personne d'autre n'atteint ce tableau — lancez la diffusion pour partager un lien.",
      "Nobody else can reach this server yet — start transmitting to hand out a link.":
        "Personne d'autre n'atteint ce serveur — lancez la diffusion pour partager un lien.",
      "Localhost only — the machine running Perth turns transmission on.":
        "Cette machine uniquement — la machine qui exécute Perth active la diffusion.",
      "Scan with a phone on the same Wi-Fi to open":
        "Scannez avec un téléphone sur le même Wi-Fi pour ouvrir",
      "Tip: run `using QRCoders` before Perth.kanban() to get a QR code here and in the terminal.":
        "Astuce : lancez `using QRCoders` avant Perth.kanban() pour afficher un QR code ici et dans le terminal.",
      "Tip: run `using QRCoders` before Perth.run() to get a QR code here and in the terminal.":
        "Astuce : lancez `using QRCoders` avant Perth.run() pour afficher un QR code ici et dans le terminal.",
      "The machine running Perth stopped transmitting this board.":
        "La machine qui exécute Perth a arrêté de diffuser ce tableau.",
      "The machine running Perth stopped transmitting these projects.":
        "La machine qui exécute Perth a arrêté de diffuser ces projets.",
      "try again": "réessayer",
      "Access key": "Clé d'accès",
      "These projects require an access key. Ask whoever started the server.":
        "Ces projets demandent une clé d'accès. Demandez-la à qui a lancé le serveur.",
      "This board requires an access key. Ask whoever started the server.":
        "Ce tableau demande une clé d'accès. Demandez-la à qui a lancé le serveur.",
      "access key": "clé d'accès",
      "enter": "entrer",
      "enter board": "entrer dans le tableau",
      "Access key required": "Clé d'accès exigée",
      "No access key": "Sans clé d'accès",
      "starts before its dependencies allow": "commence avant ce que ses dépendances permettent",
      "can start on": "peut commencer le",
      "Label position": "Position du nom",
      "Baseline": "Ligne de base",
      // glossário e vocabulário novo (0.8.8/0.8.9)
      "A date fixed by hand — a contract, a delivery window. Auto-schedule leaves it alone, and says so when the plan no longer fits it.":
        "Une date fixée à la main — un contrat, une fenêtre de livraison. La planification automatique n'y touche pas, et le dit quand le plan n'y tient plus.",
      "A date the task must not finish after. It never moves anything: it turns the slack of this task, and of everything feeding it, negative.":
        "Une date après laquelle la tâche ne doit pas finir. Elle ne déplace rien : elle rend négative la marge de cette tâche et de tout ce qui l'alimente.",
      "A date with nothing lasting: a delivery, an approval, a signature. Drawn as a diamond and never has a duration.":
        "Une date sans rien qui dure : une livraison, une approbation, une signature. Dessinée en losange, elle n'a jamais de durée.",
      "A frozen copy of the plan — what was promised. The ghost bars are the baseline; the difference between them and the bars is the slippage.":
        "Une copie gelée du plan — ce qui a été promis. Les barres fantômes sont la ligne de base ; l'écart entre elles et les barres, c'est le glissement.",
      "A named stretch of calendar shaded behind the chart: a sprint, a shutdown, the rainy season. Annotation — it never moves a task.":
        "Une portion de calendrier nommée, ombrée derrière le graphique : un sprint, un arrêt, la saison des pluies. C'est une annotation — elle ne déplace jamais une tâche.",
      "A named vertical line across the chart, like the today line: an inspection, a hand-over, a holiday.":
        "Une ligne verticale nommée en travers du graphique, comme la ligne d'aujourd'hui : une inspection, une remise, un jour férié.",
      "A piece of work with a start and a duration — a bar on the chart.":
        "Un travail avec un début et une durée — une barre sur le graphique.",
      "A task with subtasks. Its dates and its progress are not typed in — they are rolled up from its children.":
        "Une tâche avec des sous-tâches. Ses dates et son avancement ne se saisissent pas — ils remontent de ses enfants.",
      "A waits for B and B waits for A. Nothing can be scheduled until the loop is cut — this is the one warning that stops the engine.":
        "A attend B et B attend A. Rien ne peut être planifié tant que la boucle n'est pas coupée — c'est le seul avertissement qui arrête le moteur.",
      "Auto-schedule":
        "Planifier automatiquement",
      "Calendar band":
        "Bande de calendrier",
      "Dependency":
        "Dépendance",
      "Duration":
        "Durée",
      "Finish":
        "Fin",
      "Group the rows by person or by team, instead of by the WBS.":
        "Regroupent les lignes par personne ou par équipe, au lieu du WBS.",
      "How many days a task can slip before it starts pushing the finish. Zero slack is the critical path; negative slack is a promise already broken.":
        "Combien de jours une tâche peut glisser avant de pousser la fin. Marge nulle, c'est le chemin critique ; marge négative, c'est une promesse déjà rompue.",
      "How much each person has on each day. It is what turns a plan into a question about people.":
        "Ce que chaque personne a chaque jour. C'est ce qui transforme un plan en une question sur les gens.",
      "How much of the task is done, in percent. A summary averages its children, weighted by duration.":
        "Quelle part de la tâche est faite, en pourcentage. Un récapitulatif fait la moyenne de ses enfants, pondérée par la durée.",
      "How much of the work was planned to be done by each date, drawn against how much is done. The gap between the two curves is the delay, in work rather than in days.":
        "Quelle part du travail était prévue à chaque date, tracée contre ce qui est fait. L'écart entre les deux courbes est le retard, mesuré en travail plutôt qu'en jours.",
      "Lanes":
        "Couloirs",
      "Length of the task in days. With a business-day calendar set, weekends and holidays do not count.":
        "La longueur de la tâche en jours. Avec un calendrier de jours ouvrés, week-ends et jours fériés ne comptent pas.",
      "Marked day":
        "Jour marqué",
      "Moves every task to the earliest date its dependencies allow. It never invents work — it only closes the gaps the plan does not need.":
        "Amène chaque tâche à la date la plus tôt que ses dépendances permettent. N'invente aucun travail — ferme seulement les trous dont le plan n'a pas besoin.",
      "On the chart":
        "Sur le graphique",
      "P80":
        "P80",
      "Progress":
        "Avancement",
      "Sequence (#)":
        "Séquence (#)",
      "Slack":
        "Marge",
      "Summary":
        "Récapitulatif",
      "Task order — drag a row to change it":
        "Ordre des tâches — faites glisser une ligne pour le changer",
      "The breakdown of the plan into blocks and sub-blocks: which task is inside which. The indentation in the table is the WBS.":
        "Le découpage du plan en blocs et sous-blocs : quelle tâche est dans laquelle. L'indentation du tableau, c'est le WBS.",
      "The chain of tasks with no slack. A day lost in any of them is a day lost by the whole project — which is why it is worth looking at first.":
        "La chaîne des tâches sans marge. Un jour perdu sur l'une d'elles est un jour perdu par tout le projet — d'où l'intérêt de la regarder en premier.",
      "The dates say one thing and the arrows say another: the task begins earlier than its predecessors let it. A dependency never moves anything on its own — auto-schedule (S) is what puts it where it can go, unless the start is pinned.":
        "Les dates disent une chose et les flèches une autre : la tâche commence plus tôt que ses prédécesseurs ne le permettent. Une dépendance ne déplace rien toute seule — c'est la planification automatique (S) qui la met là où elle tient, sauf si la date est fixée.",
      "The day has passed and the task is not at 100%.":
        "Le jour est passé et la tâche n'est pas à 100 %.",
      "The end of the project as the engine computes it, from the dependencies and the durations.":
        "La fin du projet telle que le moteur la calcule, à partir des dépendances et des durées.",
      "The finish date with an 80% chance of being met, from the PERT estimates. The date to promise when the plan has uncertainty in it.":
        "La date de fin qui a 80 % de chances d'être tenue, d'après les estimations PERT. C'est la date à promettre quand le plan porte de l'incertitude.",
      "The plan":
        "Le plan",
      "The planned weight of the task, in whatever unit you use. Left at zero, the duration in person-days is the weight in the S-curve.":
        "Le poids prévu de la tâche, dans l'unité que vous employez. Laissé à zéro, la durée en jours-personne fait office de poids dans la courbe en S.",
      "The position of the row. Drag a row up or down to choose it; where nobody chose, rows come by start date.":
        "La position de la ligne. Faites-la glisser vers le haut ou le bas pour la choisir ; là où personne n'a choisi, les lignes viennent par date de début.",
      "Two tasks of the same person on a day that carries more work than it holds. With a capacity declared for that person, \"more than it holds\" means over the capacity; without one, it falls back to the cruder rule that any two tasks on the same day are too many.":
        "Deux tâches de la même personne un jour qui porte plus de travail qu'il n'en contient. Avec une capacité déclarée pour cette personne, \"plus qu'il n'en contient\" veut dire au-dessus de la capacité ; sans elle, c'est la règle plus grossière : deux tâches quelconques le même jour, c'est déjà trop.",
      "How much work a person absorbs in one working day, in the same unit as a task's effort — 8 for hours, 1 for a full-time person-day, 0.5 for half time. Declaring it is what lets two one-hour tasks stop counting as an overload. Empty means not declared, and the old rule applies.":
        "Combien de travail une personne absorbe en un jour ouvré, dans la même unité que la charge d'une tâche — 8 pour des heures, 1 pour un jour-personne à plein temps, 0.5 pour un mi-temps. C'est en le déclarant que deux tâches d'une heure cessent de compter comme une surcharge. Vide veut dire non déclarée, et l'ancienne règle s'applique.",
      "How much work a task is, in the same unit as a person's capacity. It never moves the task: two hours of work inside a task that spans a week is a statement about load, not about dates. Empty falls back to the cost, and then to the duration in person-days.":
        "Combien de travail représente une tâche, dans la même unité que la capacité d'une personne. Elle ne déplace jamais la tâche : deux heures de travail dans une tâche qui s'étale sur une semaine est une affirmation sur la charge, pas sur les dates. Vide retombe sur le coût, puis sur la durée en jours-personne.",
      "The task finishes after the date it had promised.":
        "La tâche finit après la date qu'elle avait promise.",
      "The task is later than it was in the frozen plan.":
        "La tâche est plus tard qu'elle ne l'était dans le plan gelé.",
      "Three estimates instead of one — optimistic, most likely, pessimistic — worth (o + 4m + p) / 6 as the expected duration. It says how uncertain a task is, not only how long it is.":
        "Trois estimations au lieu d'une — optimiste, la plus probable, pessimiste — valant (o + 4m + p) / 6 comme durée attendue. Elle dit à quel point une tâche est incertaine, pas seulement combien elle dure.",
      "Time":
        "Temps",
      "Turn lanes off to reorder tasks by hand.":
        "Désactivez les couloirs pour ordonner les tâches à la main.",
      "View selected task":
        "Voir la tâche sélectionnée",
      "WBS":
        "WBS (OTP)",
      "What overallocation, slack, baseline, PERT and the rest actually mean":
        "Ce que veulent vraiment dire surcharge, marge, ligne de base, PERT et le reste",
      "What the engine computes":
        "Ce que le moteur calcule",
      "What the words mean":
        "Ce que veulent dire les mots",
      "Workload":
        "Charge",
      "\"This only starts after that.\" Finish-to-start is the default; start-to-start and finish-to-finish tie the two starts or the two finishes; lag adds or removes days.":
        "« Ceci ne commence qu'après cela. » Fin-début est la règle par défaut ; début-début et fin-fin lient les deux débuts ou les deux fins ; le décalage ajoute ou retire des jours.",
      "overallocation":
        "surcharge",
      "past deadline":
        "délai dépassé",
      "move the selection": "déplacer la sélection",
      "collapse / expand a summary": "replier / ouvrir un récapitulatif",
      "first / last task": "première / dernière tâche",
      "zoom keeping the date under the pointer": "zoom en gardant la date sous le pointeur",
      "Marked months": "Mois marqués",
      "Marked months…": "Mois marqués…",
      "No marked months yet.": "Aucun mois marqué pour l'instant.",
      "Name (optional)": "Nom (facultatif)",
      "read-only": "lecture seule",
      "Read-only link — ask for an editing link to change anything.":
        "Lien en lecture seule — demandez un lien d'édition pour changer quoi que ce soit.",
      "Read-only link on": "Lien en lecture seule actif",
      "No read-only link": "Pas de lien en lecture seule",
      "new read-only key": "nouvelle clé de lecture",
      "read-only key": "clé de lecture",
      "Whoever opens the link below sees the projects and cannot change them — not even through the chat. This machine always edits, so the link starts at your network address.":
        "Qui ouvre le lien ci-dessous voit les projets et ne peut pas les modifier — pas même par le chat. Cette machine modifie toujours, donc le lien commence à votre adresse réseau.",
      "A second link that opens the projects and refuses to change them — for a client, a director, the whole site.":
        "Un deuxième lien qui ouvre les projets et refuse de les modifier — pour un client, une direction, tout le chantier.",
      "Start transmitting to get the read-only link.":
        "Activez la diffusion pour obtenir le lien en lecture seule.",
      "new access key": "nouvelle clé",
      "apply": "appliquer",
      "remove": "retirer",
      "The links below already carry the key. Changing it disconnects everyone on the network — they are asked for the new one.":
        "Les liens ci-dessous portent déjà la clé. La changer déconnecte tout le monde sur le réseau — la nouvelle leur est demandée.",
      "Without a key, anyone on the network who knows the port can open and edit these projects.":
        "Sans clé, quiconque sur le réseau connaît le port peut ouvrir et modifier ces projets.",
      "Without a key, anyone on the network who knows the port can open and edit this board.":
        "Sans clé, quiconque sur le réseau connaît le port peut ouvrir et modifier ce tableau.",
      "wrong key — try again": "clé incorrecte — réessayez",
      "could not load share info": "impossible de charger les infos de partage",
      "not sharing": "pas de diffusion",
      "Rename machines…": "Renommer les machines…",
      "Auto-archive…": "Archivage auto…",
      "Delete selected card": "Supprimer la carte sélectionnée",
      "Reset board…": "Réinitialiser le tableau…",
      "Resync with server": "Resynchroniser avec le serveur",
      "filter cards…  ( / )": "filtrer les cartes…  ( / )",
      "your name (shown on your cursor)": "votre nom (affiché sur votre curseur)",
      "e.g. dante": "ex. : dante",
      "empty = shows the machine IP only": "vide = affiche uniquement l'IP de la machine",
      "notification sound": "son de notification",
      "your name on the board": "votre nom sur le tableau",
      "connected machines": "machines connectées",
      "connecting…": "connexion…",
      "live": "en direct",
      "reconnecting…": "reconnexion…",
      "access denied": "accès refusé",
      "Activity…": "Activité…",
      "Export tasks (CSV)": "Exporter les tâches (CSV)",
      "Export calendar (.ics)": "Exporter le calendrier (.ics)",
      "Milestones and deadlines as an .ics file for your calendar app":
        "Jalons et échéances dans un fichier .ics pour votre application de calendrier",
      "Export chart (PNG)": "Exporter le diagramme (PNG)",
      "S-curve…": "Courbe en S…",
      "Metrics…": "Métriques…",
      "Cost": "Coût",
      "lag": "décalage",
      "Activity": "Activité",
      "S-curve": "Courbe en S",
      "Metrics": "Métriques",
      "no activity yet": "aucune activité pour l'instant",
      "planned": "prévu",
      "actual": "réalisé",
      "planned to date": "prévu à ce jour",
      "earned to date": "réalisé à ce jour",
      "total": "total",
      // panneau des ressources (gantt)
      "Resources": "Ressources",
      "resources": "ressources",
      "Close (R)": "Fermer (R)",
      "(unassigned)": "(non assigné)",
      "no one assigned yet": "personne d'assigné pour l'instant",
      "busy days": "jours occupés",
      "peak": "pointe",
      "person-days": "personnes-jours",
      "tasks": "tâches",
      "avg lead time": "lead time moyen",
      "days": "jours",
      "done last 7 days": "terminées ces 7 derniers jours",
      "done last 30 days": "terminées ces 30 derniers jours",
      "cards in progress": "cartes en cours",
      "oldest in progress": "la plus ancienne en cours",
      "not enough data yet — complete some cards first": "pas encore assez de données — terminez d'abord quelques cartes",
      "Project changed on another machine — reloaded": "Le projet a changé sur une autre machine — rechargé",
      "Open Kanban": "Ouvrir le Kanban",
      "Open Gantt": "Ouvrir le Gantt",
      "Hide other cursors": "Masquer les curseurs des autres",
      "hide other people's cursors": "masquer les curseurs des autres",
      "more connected machines": "plus de machines connectées",
      "Permissions…": "Permissions…",
      "Permissions": "Permissions",
      "add card": "créer une carte",
      "edit card text": "modifier le texte de la carte",
      "edit card description": "modifier la description de la carte",
      "delete card": "supprimer la carte",
      "move card between columns": "déplacer la carte entre colonnes",
      "mark card done": "terminer la carte",
      "archive card": "archiver la carte",
      "restore from archive": "restaurer depuis les archives",
      "delete archived forever": "supprimer définitivement des archives",
      "set assignee": "définir le responsable",
      "set due date": "définir l'échéance",
      "attach images": "joindre des images",
      "add checklist item": "ajouter un élément à la liste de contrôle",
      "check/uncheck checklist item": "cocher/décocher un élément de la liste",
      "delete checklist item": "supprimer un élément de la liste",
      "add column": "créer une colonne",
      "rename column": "renommer la colonne",
      "delete column": "supprimer la colonne",
      "reorder columns": "réordonner les colonnes",
      "set WIP limit": "définir la limite de WIP",
      "sort column by due date": "trier la colonne par échéance",
      // o card como documento (caixa expandida, código, imagens)
      "Card": "Carte",
      "card title — one line": "titre de la carte — une ligne",
      "description — **bold**, `code`, ``` for a block · paste an image": "description — **gras**, `code`, ``` pour un bloc · collez une image",
      "is editing this card right now": "modifie cette carte en ce moment",
      "open card": "ouvrir la carte",
      "description…": "description…",
      "open card (description, code, images)": "ouvrir la carte (description, code, images)",
      "description, code and images": "description, code et images",
      "bold": "gras",
      "italic": "italique",
      "strikethrough": "barré",
      "inline code": "code",
      "code block": "bloc de code",
      "list item": "élément de liste",
      "link": "lien",
      "Link address": "Adresse du lien",
      "text": "texte",
      "code": "code",
      "remove image": "retirer l'image",
      "attached image": "image jointe",
      "a card holds at most": "une carte contient au plus",
      "images": "images",
      "could not attach the image": "impossible de joindre l'image",
      "Restricted by the host": "Restreint par l'hôte",
      "The host restricted this action for your machine": "L'hôte a restreint cette action pour votre machine",
      "Someone changed this since your edit — undo skipped": "Quelqu'un a modifié ceci après votre modification — annulation ignorée",
      "Chat": "Discussion",
      "Close (Esc)": "Fermer (Échap)",
      "Send (Enter)": "Envoyer (Entrée)",
      "Message the team…": "Message à l'équipe…",
      "Message the board…": "Message au tableau…",
      "No messages yet — say hi.": "Pas encore de messages — dites bonjour.",
      "No other machines have connected yet.": "Aucune autre machine ne s'est encore connectée.",
      "check/uncheck everything": "tout cocher/décocher",
      "check/uncheck this action for everyone": "cocher/décocher cette action pour tout le monde",
      "check/uncheck this machine": "cocher/décocher cette machine",
      "Unchecked = blocked on that machine. The host machine is always allowed here, no matter this matrix.":
        "Décoché = bloqué sur cette machine. La machine hôte est toujours autorisée ici, quelle que soit cette matrice.",
      // etiqueta de versão (barra de status dos dois apps)
      "Perth version": "Version de Perth",
    },

    zh: {
      "A task with zero slack that more than one other task is waiting on. The critical path already tells you a task cannot slip; the bottleneck tells you where the chain becomes a funnel, and that is the one worth protecting first. It is derived from the plan, never typed: a hand-set flag would be wrong the moment somebody drags a bar.":
        "一个总时差为零、并且被不止一个其他任务等待的任务。关键路径已经告诉你它不能拖延；瓶颈告诉你链条在哪里变成漏斗，那才是最先值得保护的。它由计划推导而来，从不手工填写：手工标记会在有人拖动一根条形图的瞬间变错。",
      "Work stopped and expected to resume — a state nothing in the plan can reveal, so it is the one thing you declare rather than Perth deducing. It changes no arithmetic: the task keeps its dates, its load and its place on the critical path. What it stops is the reader's assumption that a bar on the chart means somebody is on it.":
        "工作停了，预计还会继续 — 这是计划里任何东西都无法揭示的状态，因此也是唯一需要声明而非由 Perth 推导的。它不改变任何计算：任务保留它的日期、负荷和在关键路径上的位置。它打断的是读者的假设：图上有一根条，就有人在做。",
      // situação declarada e gargalo derivado
      "Status": "状态",
      "Normal": "正常",
      "On hold": "已暂停",
      "Bottleneck": "瓶颈",
      "A state only you can know: work stopped and expected to resume. It changes nothing in the schedule — the task keeps its dates, its load and its place on the critical path.":
        "只有你才知道的状态：工作停了，预计还会继续。它不改变任何排期 — 任务保留它的日期、负荷和在关键路径上的位置。",
      "progress in tenths, on the whole selection (100% by dragging the fill)":
        "以十分之一设置进度，作用于整个选择（拖动填充条到头即 100%）",
      // mesclagem quando duas máquinas gravam o mesmo projeto
      "Merged with the change from the other machine":
        "已与另一台机器的改动合并",
      "Merged with the other machine — theirs kept in":
        "已与另一台机器合并 — 以下保留了对方的版本",
      // curva-S: as duas réguas
      "work": "工作量",
      "cost": "成本",
      // 每人产能与任务工作量
      "Capacity per day": "每日产能",
      "Effort": "工作量",
      "capacity": "产能",
      "day": "天",
      "of work": "的工作量",
      "from": "自",
      "over capacity": "超出产能",
      "How much work this person absorbs in one working day, in the same unit as a task's effort. Empty = not declared.":
        "此人在一个工作日内能承担多少工作，单位与任务的工作量相同。留空 = 未声明。",
      "How much work this task is, in the same unit as a person's capacity per day. It never moves the task. Empty falls back to the cost, and then to the duration in person-days.":
        "这个任务有多少工作量，单位与每人每日产能相同。它从不移动任务。留空则回退到成本，再回退到以人天计的工期。",
      // 多选与批量操作（甘特图与看板）
      "Select all tasks": "选择所有任务",
      "Select all cards": "选择所有卡片",
      "Edit selected tasks…": "编辑所选任务…",
      "Edit selected tasks": "编辑所选任务",
      "Push the dates, change the assignee or the colour of everything selected, in one go":
        "一次性调整所选内容的日期、负责人或颜色",
      "Mark selection done": "将所选标记为完成",
      "Assign selection…": "指派所选…",
      "Archive selection": "归档所选",
      "tasks selected": "项任务已选",
      "cards selected": "张卡片已选",
      "Shift start dates by": "开始日期顺延",
      "automatic": "自动",
      "nobody": "无人",
      "Apply": "应用",
      "a block moves its own subtasks — a summary has no date of its own":
        "移动一个阶段就是移动它的子任务 — 汇总本身没有日期",
      "Delete this task?": "删除这个任务？",
      "Delete these tasks?": "删除这些任务？",
      "Delete these cards?": "删除这些卡片？",
      "Assign to whom? (empty clears)": "指派给谁？（留空则清除）",
      "extend the selection": "扩展选择",
      "add or remove one task from the selection": "从选择中添加或移除一个任务",
      "add or remove one card from the selection": "从选择中添加或移除一张卡片",
      "select everything in between": "选中两者之间的全部",
      "select everything in between (same column)": "选中两者之间的全部（同一列）",
      "select all — with a filter on, only what it leaves lit":
        "全选 — 启用筛选时，只选中未被淡出的部分",
      "edit the whole selection (dates, assignee, colour)": "编辑整个选择（日期、负责人、颜色）",
      "archive the selection": "归档所选",
      "mark the selection done": "将所选标记为完成",
      "File": "文件", "Edit": "编辑", "View": "视图", "Help": "帮助",
      "Home screen": "主屏幕",
      "New project…": "新建项目…",
      "Rename project…": "重命名项目…",
      "Import project (.jl)…": "导入项目 (.jl)…",
      "Export project (.jl)": "导出项目 (.jl)",
      "Delete project…": "删除项目…",
      "New task": "新建任务", "Edit task": "编辑任务",
      "the plan cannot be scheduled while it exists": "存在时无法排程",
      "ended": "结束于",
      "Warnings": "警告",
      "Problems found in this plan": "该计划中发现的问题",
      "Problems that stop the plan from being scheduled": "导致无法排程的问题",
      "nothing wrong with this plan": "该计划没有问题",
      "dependency cycle": "依赖环",
      "past the deadline": "超过截止日期",
      "overdue": "已逾期",
      "overallocated": "资源冲突",
      "behind the baseline": "落后于基线",
      "find a task…  ( / )": "查找任务…（ / ）",
      "Find a task by name": "按名称查找任务",
      "Import failed": "导入失败",
      "Auto-schedule failed": "自动排程失败",
      "could not open the gantt": "无法打开甘特图",
      "new task": "新建任务",
      "edit task": "编辑任务",
      "delete selected task": "删除选中的任务",
      "duplicate selected task": "复制选中的任务",
      "undo": "撤销",
      "redo": "重做",
      "auto-schedule": "自动排程",
      "toggle critical path": "切换关键路径",
      "resource load": "资源负载",
      "toggle dark mode": "切换深色模式",
      "presentation mode": "演示模式",
      "go to today": "跳到今天",
      "close / deselect / exit presentation": "关闭 / 取消选择 / 退出演示",
      "new card": "新建卡片",
      "edit selected card": "编辑选中的卡片",
      "delete selected card": "删除选中的卡片",
      "filter cards": "筛选卡片",
      "Gantt charts with a Julia backend.": "基于 Julia 后端的甘特图。",
      "Data lives on the local server; edit from the REPL too:": "数据保存在本地服务器；也可以从 REPL 编辑：",
      "my project": "我的项目",
      "double-click to rename": "双击重命名",
      "WIP limit exceeded": "超出在制品上限",
      "assigned to": "负责人",
      "click to filter": "点击筛选",
      "click to edit": "点击编辑",
      "move to the archive": "移入归档",
      "filter by": "按此筛选",
      "column options": "列选项",
      "type and press Enter — #tags, **bold**, [links](url)…": "输入后按 Enter — #标签、**粗体**、[链接](url)…",
      "name": "姓名",
      "remove item": "移除条目",
      "+ checklist item": "+ 清单条目",
      "close (Esc)": "关闭（Esc）",
      "delete forever (cannot be undone)": "永久删除（无法撤销）",
      "e.g. Paulo": "例如：Paulo",
      "switches the board for everyone": "为所有人切换看板",
      "new board name": "新看板名称",
      "no subfolders": "无子文件夹",
      "no project open": "未打开项目",
      "loading…": "加载中…",
      "copy": "复制",
      "copied!": "已复制！",
      "+ card": "+ 卡片",
      "+ new column": "+ 新建列",
      "by": "由",
      "archive": "归档",
      "due": "截止",
      "assignee": "负责人",
      "restore": "恢复",
      "delete": "删除",
      "current": "当前",
      "switch": "切换",
      "create": "创建",
      "could not load the board list": "无法加载看板列表",
      "No other tasks in this project.": "该项目中没有其他任务。",
      "No activity yet.": "暂无动态。",
      "Nothing archived yet — finish a card (✓) and hit \"archive\".": "尚未归档任何内容 — 完成一张卡片（✓）后点击\"归档\"。",
      "Names apply to everyone's screen: cursors, chips and card stamps. Empty = back to the IP.": "名称对所有人的屏幕生效：光标、标签和卡片署名。留空 = 恢复为 IP。",
      "One board is active at a time — switching changes it for every connected machine.": "同一时间只有一个看板处于活动状态 — 切换会对所有已连接的机器生效。",
      "Only the host machine can switch or create boards.": "只有主机可以切换或创建看板。",
      "Discard this new task?": "放弃这个新任务？",
      "Discard the changes to this task?": "放弃对该任务的修改？",
      "(top level)": "(顶层)",
      "Edit selected task": "编辑所选任务",
      "Duplicate selected task": "复制所选任务",
      "Delete selected task": "删除所选任务",
      "Undo": "撤销", "Redo": "重做",
      "Auto-schedule (push successors)": "自动排程（顺延后继任务）",
      "Set baseline (snapshot plan)": "设定基线（计划快照）",
      "Clear baseline": "清除基线",
      // PERT（三点估算）
      "Apply PERT estimates": "应用 PERT 估算",
      "Every three-point estimate becomes a duration: (optimistic + 4×most likely + pessimistic) / 6":
        "每个三点估算都会变成工期：(乐观 + 4×最可能 + 悲观) / 6",
      "Estimate (PERT)": "估算（PERT）",
      "PERT three-point estimate: the expected duration is (o + 4m + p)/6":
        "PERT 三点估算：期望工期为 (o + 4m + p)/6",
      "optimistic": "乐观",
      "most likely": "最可能",
      "pessimistic": "悲观",
      "use as duration": "用作工期",
      "no estimate": "无估算",
      "expected": "期望",
      "PERT": "PERT",
      "estimated tasks on the critical path": "关键路径上已估算的任务",
      "Zoom: day": "缩放：日", "Zoom: week": "缩放：周", "Zoom: month": "缩放：月",
      "Critical path": "关键路径",
      "Go to today": "转到今天",
      "Dark mode": "深色模式",
      "Presentation mode": "演示模式",
      "Keyboard shortcuts": "键盘快捷键",
      "About Perth": "关于 Perth",
      "save to": "保存到",
      "Save": "保存",
      "Save in this folder": "保存到此文件夹",
      "+ Task": "+ 任务",
      "Day": "日", "Week": "周", "Month": "月", "Today": "今天",
       "start": "开始", "dur": "工期",
      "Density": "密度", "Cozy": "宽松", "Compact": "紧凑",
      "Task panel width": "任务面板宽度",
      "Weekend shading": "周末底纹",
      "Bar labels": "条形标签",
      "Baseline bars": "基线条",
      "Language": "语言",
      "project schedules, from the REPL to the browser":
        "项目排程，从 REPL 到浏览器",
      "New project": "新建项目",
      "Import saved project": "导入已保存的项目",
      "Continue where I left off": "从上次继续",
      "recent": "最近",
      "Task": "任务", "Name": "名称", "Assignee": "负责人",
      "Collaborators": "协作者",
      "Role": "职位", "Team": "部门", "Email": "邮箱",
      "Lanes: none": "泳道：无",
      "Statistics…": "统计…",
      "Calendar bands…": "日历时段…",
      "Marked days…": "标记日…",
      "Fit": "适应",
      "Zoom: fit": "缩放：适应",
      "Fit the whole project on screen": "让整个项目适应屏幕",
      "zoom day / week / month / fit": "缩放 日 / 周 / 月 / 适应",
      "Drag to the task that follows": "拖到后续任务",
      "Drag to the task that comes before": "拖到前置任务",
      "Double-click to remove": "双击移除",
      "Already linked": "这两个已经关联",
      "A summary is scheduled by its subtasks — link one of them": "摘要由其子任务决定排程 — 请关联其中一个",
      "A task and its own block are already tied": "任务与自己所在的块本就相连",
      "That would close a loop": "这会形成环",
      "Collapse": "折叠",
      "Expand": "展开",
      "Marked days": "标记日",
      "No marked days yet.": "尚无标记日。",
      "Calendar bands": "日历时段",
      "No bands yet.": "尚无时段。",
      "Colour": "颜色",
      "Remove": "移除",
      "Statistics": "统计",
      "People": "人员",
      "Teams": "部门",
      "Person": "人员",
      "effort": "工作量",
      "done": "完成",
      "over": "超载",
      "late": "逾期",
      "Nothing assigned yet.": "尚未分配任何任务。",
      "Could not load statistics": "无法加载统计数据",
      "Lanes: assignee": "泳道：负责人",
      "Lanes: team": "泳道：部门",
      "(no team)": "（无部门）",
      "Collaborators…": "协作者…",
      "Add": "添加",
      "task": "个任务",
      "No collaborators registered yet.": "尚未登记协作者。",
      "Remove from list (tasks keep the name)": "从列表中移除（任务仍保留该名字）",
      "Also assigned in this project": "本项目中还出现",
      "Register these": "登记这些",
      "Parent (WBS)": "父级 (WBS)", "Start": "开始",
      "Duration (days)": "工期（天）", "Progress (%)": "进度 (%)",
      "Color": "颜色", "Automatic": "自动",
      "Julia purple": "Julia 紫", "Julia green": "Julia 绿",
      "Julia red": "Julia 红", "Julia blue": "Julia 蓝", "Amber": "琥珀",
      "Milestone": "里程碑",
      // 截止期限（承诺）与固定日期
      "Deadline": "截止期限",
      "deadline": "截止期限",
      "Pin start date": "固定开始日期",
      "pinned start": "开始日期已固定",
      "auto-schedule wants": "自动排程建议",
      "Past deadline": "已超期",
      "Pinned start": "固定开始",
      "Commitment: never moves the task, but busting it turns the slack of this task and of everything feeding it negative":
        "承诺：从不移动任务，但一旦超期，该任务及其所有前置任务的浮动时间都会变为负数",
      "Contract date: auto-schedule leaves it where it is":
        "合同日期：自动排程不会移动它",
      "Summary task: start, duration and progress roll up from its subtasks.":
        "摘要任务：开始、工期和进度由子任务汇总而来。",
      "Depends on": "依赖于", "Notes": "备注",
      "Delete": "删除", "Cancel": "取消", "Close": "关闭",
      "Perth.jl on GitHub": "GitHub 上的 Perth.jl",
      "Source on GitHub": "GitHub 源码",
      "Toggle dark mode (D)": "切换深色模式 (D)",
      "Presentation mode (P)": "演示模式 (P)",
      "Exit presentation mode (Esc)": "退出演示模式 (Esc)",
      "Interface settings": "界面设置",
      "Mirror the project to a .perth.jl file on every save":
        "每次保存时将项目镜像到 .perth.jl 文件",
      "Browse folders": "浏览文件夹",
      "Parent folder": "上级文件夹",
      "Active project": "当前项目",
      "Highlight tasks by assignee, status or type":
        "按负责人、状态或类型高亮任务",
      "Center on today": "定位到今天",
      "Project completion": "项目完成度",
      "Board": "看板",
      "Switch board": "切换看板",
      "New card": "新建卡片",
      "New column…": "新建列…",
      "Boards…": "看板…",
      "Archived cards…": "已归档卡片…",
      "Share / QR…": "分享 / 二维码…",
      // fundo da UI (Perth.background!)
      "Hide background": "隐藏背景",
      "hide background image": "隐藏背景图片",
      // etiqueta de card criado hoje (kanban)
      "new": "新",
      "added today": "今天创建",
      "hide new-card badges": "隐藏新卡片标记",
      // transmitir (share): diálogo de compartilhamento e avisos
      "Transmit to your network": "向局域网广播",
      "Transmitting — click to stop": "正在广播 — 点击停止",
      "Share this board": "分享此看板",
      "Share this project": "分享此项目",
      "Transmitting to your network": "正在向局域网广播",
      "Localhost only": "仅本机",
      "Start transmitting": "开始广播",
      "Stop transmitting": "停止广播",
      "Transmission on": "广播已开启",
      "Transmission off": "广播已关闭",
      "Nobody else can reach this board yet — start transmitting to hand out a link.":
        "目前其他人无法访问此看板 — 开始广播后即可分享链接。",
      "Nobody else can reach this server yet — start transmitting to hand out a link.":
        "目前其他人无法访问此服务器 — 开始广播后即可分享链接。",
      "Localhost only — the machine running Perth turns transmission on.":
        "仅本机 — 由运行 Perth 的机器开启广播。",
      "Scan with a phone on the same Wi-Fi to open": "用同一 Wi-Fi 下的手机扫码打开",
      "Tip: run `using QRCoders` before Perth.kanban() to get a QR code here and in the terminal.":
        "提示：在 Perth.kanban() 之前运行 `using QRCoders`，即可在这里和终端显示二维码。",
      "Tip: run `using QRCoders` before Perth.run() to get a QR code here and in the terminal.":
        "提示：在 Perth.run() 之前运行 `using QRCoders`，即可在这里和终端显示二维码。",
      "The machine running Perth stopped transmitting this board.":
        "运行 Perth 的机器已停止广播此看板。",
      "The machine running Perth stopped transmitting these projects.":
        "运行 Perth 的机器已停止广播这些项目。",
      "try again": "重试",
      "Access key": "访问密钥",
      "These projects require an access key. Ask whoever started the server.":
        "这些项目需要访问密钥。请向启动服务器的人索取。",
      "This board requires an access key. Ask whoever started the server.":
        "此看板需要访问密钥。请向启动服务器的人索取。",
      "access key": "访问密钥",
      "enter": "进入",
      "enter board": "进入看板",
      "Access key required": "需要访问密钥",
      "No access key": "没有访问密钥",
      "starts before its dependencies allow": "早于依赖允许的时间开始",
      "can start on": "最早可开始于",
      "Label position": "标签位置",
      "Baseline": "基线",
      // glossário e vocabulário novo (0.8.8/0.8.9)
      "A date fixed by hand — a contract, a delivery window. Auto-schedule leaves it alone, and says so when the plan no longer fits it.":
        "手工钉住的日期 — 一份合同、一个交付窗口。自动排程不会挪动它，计划装不下时会明说。",
      "A date the task must not finish after. It never moves anything: it turns the slack of this task, and of everything feeding it, negative.":
        "任务不得晚于此日完成。它不挪动任何东西：它让这个任务以及上游所有任务的浮时变成负数。",
      "A date with nothing lasting: a delivery, an approval, a signature. Drawn as a diamond and never has a duration.":
        "没有持续时间的日期：一次交付、一次批准、一个签字。画成菱形，永远没有工期。",
      "A frozen copy of the plan — what was promised. The ghost bars are the baseline; the difference between them and the bars is the slippage.":
        "计划的冻结副本 — 当初承诺的样子。虚影条就是基线；它和实条之间的差就是偏移。",
      "A named stretch of calendar shaded behind the chart: a sprint, a shutdown, the rainy season. Annotation — it never moves a task.":
        "在图后加底色的一段有名字的日历：一个冲刺、一次停工、雨季。它是标注 — 从不挪动任务。",
      "A named vertical line across the chart, like the today line: an inspection, a hand-over, a holiday.":
        "横贯图表的一条有名字的竖线，就像今天线：一次验收、一次移交、一个节日。",
      "A piece of work with a start and a duration — a bar on the chart.":
        "有开始日期和工期的一段工作 — 图上的一根条。",
      "A task with subtasks. Its dates and its progress are not typed in — they are rolled up from its children.":
        "带子任务的任务。它的日期和进度不是填写的 — 是从子任务汇总上来的。",
      "A waits for B and B waits for A. Nothing can be scheduled until the loop is cut — this is the one warning that stops the engine.":
        "A 等 B，B 等 A。不剪断这个环就什么都排不了 — 这是唯一会让引擎停下的警告。",
      "Auto-schedule":
        "自动排程",
      "Calendar band":
        "日历色带",
      "Dependency":
        "依赖",
      "Duration":
        "工期",
      "Finish":
        "完工",
      "Group the rows by person or by team, instead of by the WBS.":
        "按人或按团队分组显示行，取代 WBS 的层级。",
      "How many days a task can slip before it starts pushing the finish. Zero slack is the critical path; negative slack is a promise already broken.":
        "任务可以拖延几天而不推迟完工。浮时为零就是关键路径；浮时为负说明承诺已经落空。",
      "How much each person has on each day. It is what turns a plan into a question about people.":
        "每个人每天有多少活。它把一份计划变成一个关于人的问题。",
      "How much of the task is done, in percent. A summary averages its children, weighted by duration.":
        "任务完成的百分比。摘要任务按工期加权取子任务的平均值。",
      "How much of the work was planned to be done by each date, drawn against how much is done. The gap between the two curves is the delay, in work rather than in days.":
        "到每个日期原计划完成多少工作，与实际完成量对照。两条曲线之间的差距就是延误 — 以工作量计，而非天数。",
      "Lanes":
        "泳道",
      "Length of the task in days. With a business-day calendar set, weekends and holidays do not count.":
        "任务的天数。设了工作日日历后，周末和节假日不计入。",
      "Marked day":
        "标记日",
      "Moves every task to the earliest date its dependencies allow. It never invents work — it only closes the gaps the plan does not need.":
        "把每个任务挪到依赖允许的最早日期。它不会凭空造出工作 — 只是合上计划不需要的空档。",
      "On the chart":
        "图上",
      "P80":
        "P80",
      "Progress":
        "进度",
      "Sequence (#)":
        "序号 (#)",
      "Slack":
        "浮时",
      "Summary":
        "摘要任务",
      "Task order — drag a row to change it":
        "任务顺序 — 拖动一行即可更改",
      "The breakdown of the plan into blocks and sub-blocks: which task is inside which. The indentation in the table is the WBS.":
        "把计划拆成块与子块：哪个任务在哪个之内。表格里的缩进就是 WBS。",
      "The chain of tasks with no slack. A day lost in any of them is a day lost by the whole project — which is why it is worth looking at first.":
        "没有浮时的任务链。其中任何一个耽误一天，整个项目就耽误一天 — 所以要先看它。",
      "The dates say one thing and the arrows say another: the task begins earlier than its predecessors let it. A dependency never moves anything on its own — auto-schedule (S) is what puts it where it can go, unless the start is pinned.":
        "日期说的是一回事，箭头说的是另一回事：任务的开始早于前置任务所允许的时间。依赖本身从不挪动任何东西 — 把它放到能放的位置的是自动排程 (S)，除非开始日期被钉住。",
      "The day has passed and the task is not at 100%.":
        "日子过去了，任务还不到 100%。",
      "The end of the project as the engine computes it, from the dependencies and the durations.":
        "引擎依据依赖和工期算出的项目结束日。",
      "The finish date with an 80% chance of being met, from the PERT estimates. The date to promise when the plan has uncertainty in it.":
        "由 PERT 估计得出、有 80% 把握达成的完工日期。计划中存在不确定性时，就承诺这个日期。",
      "The plan":
        "计划",
      "The planned weight of the task, in whatever unit you use. Left at zero, the duration in person-days is the weight in the S-curve.":
        "任务的计划权重，单位随你。留为零时，以人天工期作为 S 曲线中的权重。",
      "The position of the row. Drag a row up or down to choose it; where nobody chose, rows come by start date.":
        "行的位置。上下拖动一行即可指定；没有人指定的地方，按开始日期排列。",
      "Two tasks of the same person on a day that carries more work than it holds. With a capacity declared for that person, \"more than it holds\" means over the capacity; without one, it falls back to the cruder rule that any two tasks on the same day are too many.":
        "同一个人的两个任务落在同一天，而那天承载的工作超过了它容得下的量。若为该成员声明了产能，\"超过容量\"就是指超出产能；未声明时，则退回更粗略的规则：同一天有任意两个任务就算太多。",
      "How much work a person absorbs in one working day, in the same unit as a task's effort — 8 for hours, 1 for a full-time person-day, 0.5 for half time. Declaring it is what lets two one-hour tasks stop counting as an overload. Empty means not declared, and the old rule applies.":
        "一个人在一个工作日内能承担多少工作，单位与任务的工作量相同 — 按小时算是 8，全职一人天是 1，半职是 0.5。正是声明了它，两个一小时的任务才不再算作超载。留空表示未声明，沿用旧规则。",
      "How much work a task is, in the same unit as a person's capacity. It never moves the task: two hours of work inside a task that spans a week is a statement about load, not about dates. Empty falls back to the cost, and then to the duration in person-days.":
        "一个任务有多少工作量，单位与成员产能相同。它从不移动任务：跨越一周的任务里只有两小时的工作，说的是负荷，不是日期。留空则回退到成本，再回退到以人天计的工期。",
      "The task finishes after the date it had promised.":
        "任务的完成时间晚于它承诺的日期。",
      "The task is later than it was in the frozen plan.":
        "任务比冻结计划里的时间更晚。",
      "Three estimates instead of one — optimistic, most likely, pessimistic — worth (o + 4m + p) / 6 as the expected duration. It says how uncertain a task is, not only how long it is.":
        "用三个估计代替一个 — 乐观、最可能、悲观 — 期望工期为 (o + 4m + p) / 6。它说明任务有多不确定，而不只是有多长。",
      "Time":
        "时间",
      "Turn lanes off to reorder tasks by hand.":
        "关掉泳道才能手工调整任务顺序。",
      "View selected task":
        "查看所选任务",
      "WBS":
        "WBS 工作分解",
      "What overallocation, slack, baseline, PERT and the rest actually mean":
        "超负荷、浮时、基线、PERT 等词到底是什么意思",
      "What the engine computes":
        "引擎算出来的",
      "What the words mean":
        "这些词是什么意思",
      "Workload":
        "负荷",
      "\"This only starts after that.\" Finish-to-start is the default; start-to-start and finish-to-finish tie the two starts or the two finishes; lag adds or removes days.":
        "「这个要等那个结束才开始。」默认是完成-开始；开始-开始和完成-完成绑定两者的开始或结束；延时可加减天数。",
      "overallocation":
        "超负荷",
      "past deadline":
        "超过期限",
      "move the selection": "移动选择",
      "collapse / expand a summary": "折叠 / 展开摘要任务",
      "first / last task": "第一个 / 最后一个任务",
      "zoom keeping the date under the pointer": "缩放时保持指针下的日期不动",
      "Marked months": "标记的月份",
      "Marked months…": "标记的月份…",
      "No marked months yet.": "还没有标记的月份。",
      "Name (optional)": "名称（可选）",
      "read-only": "只读",
      "Read-only link — ask for an editing link to change anything.":
        "只读链接 — 需要改动请索取可编辑链接。",
      "Read-only link on": "只读链接已开启",
      "No read-only link": "没有只读链接",
      "new read-only key": "新的只读密钥",
      "read-only key": "只读密钥",
      "Whoever opens the link below sees the projects and cannot change them — not even through the chat. This machine always edits, so the link starts at your network address.":
        "打开下面链接的人只能查看项目，无法更改 — 聊天也不行。本机始终可编辑，因此链接从你的网络地址开始。",
      "A second link that opens the projects and refuses to change them — for a client, a director, the whole site.":
        "第二个链接：能打开项目、拒绝改动 — 给客户、给领导、给整个工地。",
      "Start transmitting to get the read-only link.":
        "开启传输后即可获得只读链接。",
      "new access key": "新密钥",
      "apply": "应用",
      "remove": "移除",
      "The links below already carry the key. Changing it disconnects everyone on the network — they are asked for the new one.":
        "下面的链接已带上密钥。更换密钥会断开网络上所有人的连接 — 他们会被要求输入新密钥。",
      "Without a key, anyone on the network who knows the port can open and edit these projects.":
        "没有密钥，网络上任何知道端口的人都能打开并编辑这些项目。",
      "Without a key, anyone on the network who knows the port can open and edit this board.":
        "没有密钥，网络上任何知道端口的人都能打开并编辑此看板。",
      "wrong key — try again": "密钥错误 — 请重试",
      "could not load share info": "无法加载分享信息",
      "not sharing": "未广播",
      "Rename machines…": "重命名设备…",
      "Auto-archive…": "自动归档…",
      "Delete selected card": "删除所选卡片",
      "Reset board…": "重置看板…",
      "Resync with server": "与服务器重新同步",
      "filter cards…  ( / )": "筛选卡片…  ( / )",
      "your name (shown on your cursor)": "你的名字（显示在光标上）",
      "e.g. dante": "例如 dante",
      "empty = shows the machine IP only": "留空 = 仅显示设备 IP",
      "notification sound": "通知声音",
      "your name on the board": "看板上的名字",
      "connected machines": "已连接设备",
      "connecting…": "连接中…",
      "live": "在线",
      "reconnecting…": "重连中…",
      "access denied": "拒绝访问",
      "Activity…": "动态…",
      "Export tasks (CSV)": "导出任务 (CSV)",
      "Export calendar (.ics)": "导出日历 (.ics)",
      "Milestones and deadlines as an .ics file for your calendar app":
        "将里程碑与截止期限导出为 .ics 文件，供日历应用使用",
      "Export chart (PNG)": "导出图表 (PNG)",
      "S-curve…": "S 曲线…",
      "Metrics…": "指标…",
      "Cost": "成本",
      "lag": "延迟",
      "Activity": "动态",
      "S-curve": "S 曲线",
      "Metrics": "指标",
      "no activity yet": "暂无动态",
      "planned": "计划",
      "actual": "实际",
      "planned to date": "截至今日计划",
      "earned to date": "截至今日完成",
      "total": "总计",
      // 资源面板（甘特图）
      "Resources": "资源",
      "resources": "资源",
      "Close (R)": "关闭 (R)",
      "(unassigned)": "(未分配)",
      "no one assigned yet": "尚无负责人",
      "busy days": "忙碌天数",
      "peak": "峰值",
      "person-days": "人天",
      "tasks": "任务",
      "avg lead time": "平均前置时间",
      "days": "天",
      "done last 7 days": "近 7 天完成",
      "done last 30 days": "近 30 天完成",
      "cards in progress": "进行中卡片",
      "oldest in progress": "最早的进行中卡片",
      "not enough data yet — complete some cards first": "数据不足——请先完成一些卡片",
      "Project changed on another machine — reloaded": "项目已在其他设备上更改——已重新加载",
      "Open Kanban": "打开看板",
      "Open Gantt": "打开甘特图",
      "Hide other cursors": "隐藏他人光标",
      "hide other people's cursors": "隐藏他人的光标",
      "more connected machines": "更多已连接设备",
      "Permissions…": "权限…",
      "Permissions": "权限",
      "add card": "新建卡片",
      "edit card text": "编辑卡片内容",
      "edit card description": "编辑卡片描述",
      "delete card": "删除卡片",
      "move card between columns": "在列之间移动卡片",
      "mark card done": "标记卡片完成",
      "archive card": "归档卡片",
      "restore from archive": "从归档恢复",
      "delete archived forever": "彻底删除归档",
      "set assignee": "设置负责人",
      "set due date": "设置截止日期",
      "attach images": "附加图片",
      "add checklist item": "添加清单项",
      "check/uncheck checklist item": "勾选/取消勾选清单项",
      "delete checklist item": "删除清单项",
      "add column": "新建列",
      "rename column": "重命名列",
      "delete column": "删除列",
      "reorder columns": "重新排列列",
      "set WIP limit": "设置在制品上限",
      "sort column by due date": "按截止日期排序列",
      // o card como documento (caixa expandida, código, imagens)
      "Card": "卡片",
      "card title — one line": "卡片标题 — 一行",
      "description — **bold**, `code`, ``` for a block · paste an image": "描述 — **粗体**、`代码`、``` 代码块 · 粘贴图片",
      "is editing this card right now": "正在编辑这张卡片",
      "open card": "打开卡片",
      "description…": "描述…",
      "open card (description, code, images)": "打开卡片（描述、代码、图片）",
      "description, code and images": "描述、代码和图片",
      "bold": "粗体",
      "italic": "斜体",
      "strikethrough": "删除线",
      "inline code": "行内代码",
      "code block": "代码块",
      "list item": "列表项",
      "link": "链接",
      "Link address": "链接地址",
      "text": "文本",
      "code": "代码",
      "remove image": "移除图片",
      "attached image": "附加的图片",
      "a card holds at most": "一张卡片最多可放",
      "images": "张图片",
      "could not attach the image": "无法附加图片",
      "Restricted by the host": "主机已限制",
      "The host restricted this action for your machine": "主机已为你的设备限制此操作",
      "Someone changed this since your edit — undo skipped": "你编辑之后有人修改了它 — 已跳过撤销",
      "Chat": "聊天",
      "Close (Esc)": "关闭 (Esc)",
      "Send (Enter)": "发送 (回车)",
      "Message the team…": "给团队发消息…",
      "Message the board…": "给看板发消息…",
      "No messages yet — say hi.": "还没有消息——打个招呼吧。",
      "No other machines have connected yet.": "尚无其他设备连接。",
      "check/uncheck everything": "全选/取消全选",
      "check/uncheck this action for everyone": "为所有人勾选/取消此操作",
      "check/uncheck this machine": "勾选/取消此设备",
      "Unchecked = blocked on that machine. The host machine is always allowed here, no matter this matrix.":
        "未勾选 = 在该设备上被阻止。无论此矩阵如何设置，主机设备始终被允许。",
      // etiqueta de versão (barra de status dos dois apps)
      "Perth version": "Perth 版本",
    },
  };

  /* --------------------------------------------- seletores traduzíveis */
  // Onde procurar texto estático para traduzir (primeiro nó de texto do
  // elemento; filhos como <kbd> e <svg> são preservados). Elementos
  // dinâmicos cujo texto não está no dicionário passam intactos.
  const TEXT_SELECTORS = [
    ".menu-title", "#menubar .menu-drop button", ".fb-label", ".sp-label",
    ".seg button", "#fb-choose", "#save-path-btn",
    ".toolbar button", ".toolbar select option",
    ".zoom-group button", ".tt-head span", ".tt-lane .lane-name",
    ".w-tagline", ".w-actions button", ".w-recent-title",
    ".modal h2", ".form-grid label", ".form-grid option",
    ".summary-hint", ".modal-actions button",
    ".pert-title", "#f-pert-apply",
    ".settings-drop label", ".settings-hint", ".settings-check label",
    ".settings-lang label", "#conn-label", ".chat-head span",
    ".res-head span",
  ];
  const ATTRS = ["title", "placeholder", "aria-label"];

  // Preferências vindas do botão de troca gantt<->kanban: cada porta é
  // uma origem com localStorage próprio, então idioma/nome viajam na URL,
  // são gravados aqui e a URL é limpa (preservando ?key= do share).
  try {
    const q = new URLSearchParams(location.search);
    const pl = q.get("pref-lang");
    if (pl && LANG_NAMES[pl]) localStorage.setItem("perth-lang", pl);
    const pn = q.get("pref-name");
    if (pn !== null && pn !== "") {
      localStorage.setItem("perth-name", pn);
      localStorage.setItem("perth-kanban-name", pn);
    }
    if ([...q.keys()].some((k) => k.startsWith("pref-"))) {
      for (const k of [...q.keys()])
        if (k.startsWith("pref-")) q.delete(k);
      const rest = q.toString();
      history.replaceState(null, "",
        location.pathname + (rest ? "?" + rest : ""));
    }
  } catch (e) { /* URL/storage indisponível: segue com os defaults */ }

  let lang = localStorage.getItem("perth-lang") || "en";
  if (!LANG_NAMES[lang]) lang = "en";

  const norm = (s) => s.replace(/\u00a0/g, " ").trim();

  function t(key) {
    const k = norm(String(key));
    if (lang === "en") return k;
    return (STR[lang] && STR[lang][k]) || k;
  }

  function firstTextNode(el) {
    for (const n of el.childNodes)
      if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) return n;
    return null;
  }

  function apply(root = document) {
    // texto: memoriza a chave (inglês) no primeiro passe para poder
    // alternar de idioma quantas vezes for preciso
    for (const sel of TEXT_SELECTORS) {
      for (const el of root.querySelectorAll(sel)) {
        const node = firstTextNode(el);
        if (!node) continue;
        if (!el.dataset.i18nKey) el.dataset.i18nKey = norm(node.textContent);
        const raw = node.textContent;
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        node.textContent = lead + t(el.dataset.i18nKey) + trail;
      }
    }
    // atributos: title/placeholder/aria-label estáticos em toda a página
    for (const attr of ATTRS) {
      const dkey = "i18n" + attr.replace(/-(\w)/g, (_, c) => c.toUpperCase())
                              .replace(/^\w/, (c) => c.toUpperCase());
      for (const el of root.querySelectorAll(`[${attr}]`)) {
        if (!el.dataset[dkey]) {
          const v = norm(el.getAttribute(attr) || "");
          if (!v) continue;
          el.dataset[dkey] = v;
        }
        const tr = t(el.dataset[dkey]);
        if (tr !== el.getAttribute(attr)) el.setAttribute(attr, tr);
      }
    }
    document.documentElement.lang = lang;
  }

  function set(l) {
    lang = LANG_NAMES[l] ? l : "en";
    localStorage.setItem("perth-lang", lang);
    apply();
    syncSelects();
  }

  /* ------------------------------------------------ seletor de idioma */

  function syncSelects() {
    for (const sel of document.querySelectorAll("#lang-select, [data-lang-select]"))
      sel.value = lang;
  }

  function mountSelects() {
    for (const sel of document.querySelectorAll("#lang-select, [data-lang-select]")) {
      if (sel.dataset.i18nMounted) continue;
      sel.dataset.i18nMounted = "1";
      sel.textContent = "";
      for (const [code, name] of Object.entries(LANG_NAMES)) {
        const o = document.createElement("option");
        o.value = code;
        o.textContent = name;   // nome no próprio idioma, nunca traduzido
        sel.append(o);
      }
      sel.value = lang;
      sel.addEventListener("change", () => set(sel.value));
      // dentro de um dropdown de menu: interagir não deve fechar o menu
      sel.addEventListener("click", (e) => e.stopPropagation());
    }
  }

  // O script é carregado no fim do <body>: o DOM estático já existe
  mountSelects();
  apply();

  return { t, set, apply, current: () => lang,
           months: () => MONTHS[lang] || MONTHS.en,
           languages: () => ({ ...LANG_NAMES }) };
})();
