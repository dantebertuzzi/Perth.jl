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
      // menus (gantt)
      "File": "Arquivo", "Edit": "Editar", "View": "Exibir", "Help": "Ajuda",
      "Home screen": "Tela inicial",
      "New project…": "Novo projeto…",
      "Rename project…": "Renomear projeto…",
      "Import project (.jl)…": "Importar projeto (.jl)…",
      "Export project (.jl)": "Exportar projeto (.jl)",
      "Delete project…": "Excluir projeto…",
      "New task": "Nova tarefa",
      "Edit selected task": "Editar tarefa selecionada",
      "Duplicate selected task": "Duplicar tarefa selecionada",
      "Delete selected task": "Excluir tarefa selecionada",
      "Undo": "Desfazer", "Redo": "Refazer",
      "Auto-schedule (push successors)": "Auto-agendar (empurrar sucessoras)",
      "Set baseline (snapshot plan)": "Definir linha de base (foto do plano)",
      "Clear baseline": "Limpar linha de base",
      "Zoom: day": "Zoom: dia", "Zoom: week": "Zoom: semana", "Zoom: month": "Zoom: mês",
      "Critical path": "Caminho crítico",
      "Go to today": "Ir para hoje",
      "Dark mode": "Modo escuro",
      "Keyboard shortcuts": "Atalhos de teclado",
      "About Perth": "Sobre o Perth",
      // caixa de caminho / toolbar / tabela (gantt)
      "save to": "salvar em",
      "Save": "Salvar",
      "Save in this folder": "Salvar nesta pasta",
      "+ Task": "+ Tarefa",
      "Day": "Dia", "Week": "Semana", "Month": "Mês", "Today": "Hoje",
      "task": "tarefa", "start": "início", "dur": "dur",
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
      "Parent (WBS)": "Pai (WBS)", "Start": "Início",
      "Duration (days)": "Duração (dias)", "Progress (%)": "Progresso (%)",
      "Color": "Cor", "Automatic": "Automática",
      "Julia purple": "Roxo Julia", "Julia green": "Verde Julia",
      "Julia red": "Vermelho Julia", "Julia blue": "Azul Julia", "Amber": "Âmbar",
      "Milestone": "Marco",
      "Summary task: start, duration and progress roll up from its subtasks.":
        "Tarefa-resumo: início, duração e progresso derivam das subtarefas.",
      "Depends on": "Depende de", "Notes": "Notas",
      "Delete": "Excluir", "Cancel": "Cancelar",
      // títulos/tooltips (gantt)
      "Perth.jl on GitHub": "Perth.jl no GitHub",
      "Source on GitHub": "Código no GitHub",
      "Toggle dark mode (D)": "Alternar modo escuro (D)",
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
      "Activity…": "Atividade…",
      "Share / QR…": "Compartilhar / QR…",
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
    },

    es: {
      "File": "Archivo", "Edit": "Editar", "View": "Ver", "Help": "Ayuda",
      "Home screen": "Pantalla de inicio",
      "New project…": "Nuevo proyecto…",
      "Rename project…": "Renombrar proyecto…",
      "Import project (.jl)…": "Importar proyecto (.jl)…",
      "Export project (.jl)": "Exportar proyecto (.jl)",
      "Delete project…": "Eliminar proyecto…",
      "New task": "Nueva tarea",
      "Edit selected task": "Editar tarea seleccionada",
      "Duplicate selected task": "Duplicar tarea seleccionada",
      "Delete selected task": "Eliminar tarea seleccionada",
      "Undo": "Deshacer", "Redo": "Rehacer",
      "Auto-schedule (push successors)": "Autoprogramar (empujar sucesoras)",
      "Set baseline (snapshot plan)": "Fijar línea base (instantánea del plan)",
      "Clear baseline": "Borrar línea base",
      "Zoom: day": "Zoom: día", "Zoom: week": "Zoom: semana", "Zoom: month": "Zoom: mes",
      "Critical path": "Ruta crítica",
      "Go to today": "Ir a hoy",
      "Dark mode": "Modo oscuro",
      "Keyboard shortcuts": "Atajos de teclado",
      "About Perth": "Acerca de Perth",
      "save to": "guardar en",
      "Save": "Guardar",
      "Save in this folder": "Guardar en esta carpeta",
      "+ Task": "+ Tarea",
      "Day": "Día", "Week": "Semana", "Month": "Mes", "Today": "Hoy",
      "task": "tarea", "start": "inicio", "dur": "dur",
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
      "Parent (WBS)": "Padre (WBS)", "Start": "Inicio",
      "Duration (days)": "Duración (días)", "Progress (%)": "Progreso (%)",
      "Color": "Color", "Automatic": "Automático",
      "Julia purple": "Morado Julia", "Julia green": "Verde Julia",
      "Julia red": "Rojo Julia", "Julia blue": "Azul Julia", "Amber": "Ámbar",
      "Milestone": "Hito",
      "Summary task: start, duration and progress roll up from its subtasks.":
        "Tarea resumen: inicio, duración y progreso se derivan de sus subtareas.",
      "Depends on": "Depende de", "Notes": "Notas",
      "Delete": "Eliminar", "Cancel": "Cancelar",
      "Perth.jl on GitHub": "Perth.jl en GitHub",
      "Source on GitHub": "Código en GitHub",
      "Toggle dark mode (D)": "Alternar modo oscuro (D)",
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
      "Activity…": "Actividad…",
      "Share / QR…": "Compartir / QR…",
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
    },

    fr: {
      "File": "Fichier", "Edit": "Édition", "View": "Affichage", "Help": "Aide",
      "Home screen": "Écran d'accueil",
      "New project…": "Nouveau projet…",
      "Rename project…": "Renommer le projet…",
      "Import project (.jl)…": "Importer un projet (.jl)…",
      "Export project (.jl)": "Exporter le projet (.jl)",
      "Delete project…": "Supprimer le projet…",
      "New task": "Nouvelle tâche",
      "Edit selected task": "Modifier la tâche sélectionnée",
      "Duplicate selected task": "Dupliquer la tâche sélectionnée",
      "Delete selected task": "Supprimer la tâche sélectionnée",
      "Undo": "Annuler", "Redo": "Rétablir",
      "Auto-schedule (push successors)": "Planification auto (décaler les successeurs)",
      "Set baseline (snapshot plan)": "Définir la référence (instantané du plan)",
      "Clear baseline": "Effacer la référence",
      "Zoom: day": "Zoom : jour", "Zoom: week": "Zoom : semaine", "Zoom: month": "Zoom : mois",
      "Critical path": "Chemin critique",
      "Go to today": "Aller à aujourd'hui",
      "Dark mode": "Mode sombre",
      "Keyboard shortcuts": "Raccourcis clavier",
      "About Perth": "À propos de Perth",
      "save to": "enregistrer dans",
      "Save": "Enregistrer",
      "Save in this folder": "Enregistrer dans ce dossier",
      "+ Task": "+ Tâche",
      "Day": "Jour", "Week": "Semaine", "Month": "Mois", "Today": "Aujourd'hui",
      "task": "tâche", "start": "début", "dur": "dur",
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
      "Parent (WBS)": "Parent (WBS)", "Start": "Début",
      "Duration (days)": "Durée (jours)", "Progress (%)": "Avancement (%)",
      "Color": "Couleur", "Automatic": "Automatique",
      "Julia purple": "Violet Julia", "Julia green": "Vert Julia",
      "Julia red": "Rouge Julia", "Julia blue": "Bleu Julia", "Amber": "Ambre",
      "Milestone": "Jalon",
      "Summary task: start, duration and progress roll up from its subtasks.":
        "Tâche récapitulative : début, durée et avancement dérivent des sous-tâches.",
      "Depends on": "Dépend de", "Notes": "Notes",
      "Delete": "Supprimer", "Cancel": "Annuler",
      "Perth.jl on GitHub": "Perth.jl sur GitHub",
      "Source on GitHub": "Code source sur GitHub",
      "Toggle dark mode (D)": "Basculer le mode sombre (D)",
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
      "Activity…": "Activité…",
      "Share / QR…": "Partager / QR…",
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
    },

    zh: {
      "File": "文件", "Edit": "编辑", "View": "视图", "Help": "帮助",
      "Home screen": "主屏幕",
      "New project…": "新建项目…",
      "Rename project…": "重命名项目…",
      "Import project (.jl)…": "导入项目 (.jl)…",
      "Export project (.jl)": "导出项目 (.jl)",
      "Delete project…": "删除项目…",
      "New task": "新建任务",
      "Edit selected task": "编辑所选任务",
      "Duplicate selected task": "复制所选任务",
      "Delete selected task": "删除所选任务",
      "Undo": "撤销", "Redo": "重做",
      "Auto-schedule (push successors)": "自动排程（顺延后继任务）",
      "Set baseline (snapshot plan)": "设定基线（计划快照）",
      "Clear baseline": "清除基线",
      "Zoom: day": "缩放：日", "Zoom: week": "缩放：周", "Zoom: month": "缩放：月",
      "Critical path": "关键路径",
      "Go to today": "转到今天",
      "Dark mode": "深色模式",
      "Keyboard shortcuts": "键盘快捷键",
      "About Perth": "关于 Perth",
      "save to": "保存到",
      "Save": "保存",
      "Save in this folder": "保存到此文件夹",
      "+ Task": "+ 任务",
      "Day": "日", "Week": "周", "Month": "月", "Today": "今天",
      "task": "任务", "start": "开始", "dur": "工期",
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
      "Parent (WBS)": "父级 (WBS)", "Start": "开始",
      "Duration (days)": "工期（天）", "Progress (%)": "进度 (%)",
      "Color": "颜色", "Automatic": "自动",
      "Julia purple": "Julia 紫", "Julia green": "Julia 绿",
      "Julia red": "Julia 红", "Julia blue": "Julia 蓝", "Amber": "琥珀",
      "Milestone": "里程碑",
      "Summary task: start, duration and progress roll up from its subtasks.":
        "摘要任务：开始、工期和进度由子任务汇总而来。",
      "Depends on": "依赖于", "Notes": "备注",
      "Delete": "删除", "Cancel": "取消",
      "Perth.jl on GitHub": "GitHub 上的 Perth.jl",
      "Source on GitHub": "GitHub 源码",
      "Toggle dark mode (D)": "切换深色模式 (D)",
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
      "Activity…": "动态…",
      "Share / QR…": "分享 / 二维码…",
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
    },
  };

  /* --------------------------------------------- seletores traduzíveis */
  // Onde procurar texto estático para traduzir (primeiro nó de texto do
  // elemento; filhos como <kbd> e <svg> são preservados). Elementos
  // dinâmicos cujo texto não está no dicionário passam intactos.
  const TEXT_SELECTORS = [
    ".menu-title", "#menubar .menu-drop button", ".fb-label", ".sp-label",
    ".seg button", "#fb-choose", "#save-path-btn",
    ".toolbar button", ".zoom-group button", ".tt-head span",
    ".w-tagline", ".w-actions button", ".w-recent-title",
    ".modal h2", ".form-grid label", ".form-grid option",
    ".summary-hint", ".modal-actions button",
    ".settings-drop label", ".settings-hint", ".settings-check label",
    ".settings-lang label", "#conn-label",
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
