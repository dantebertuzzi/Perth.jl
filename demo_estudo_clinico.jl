#!/usr/bin/env julia
#=
Projeto realista simulado: Análise Estatística para um Estudo Clínico
=============================================================
Este script demonstra o Perth.jl como ferramenta de planejamento
de um projeto estatístico real de um estudo clínico randomizado.

Execute com:
  julia --project=. demo_estudo_clinico.jl
=#

using Perth
using Dates

println("="^64)
println("  Perth.jl — Projeto: Análise Estatística de Estudo Clínico")
println("="^64)
println()

# ═══════════════════════════════════════════════════════════
# Fase 1: Definição do Escopo e Protocolo
# ═══════════════════════════════════════════════════════════
println("📋 Criando projeto...")
p = create_project("Estudo Clínico Randomizado — Eficácia do Tratamento X")

# ── Revisão de Literatura ──
lit = add_task!(p, "Revisão sistemática de literatura";
    start = Date(2026, 8, 3), duration = 10,
    assignee = "Maria (Bioestatística)", color = "#bd93f9")

# ── Protocolo ──
proto = add_task!(p, "Redação do protocolo estatístico";
    start = Date(2026, 8, 3), duration = 12,
    dependencies = [lit.id],
    assignee = "João (Estatístico Chefe)", color = "#ff79c6")

# ── Submissão ao Comitê de Ética ──
ethics = add_task!(p, "Submissão ao Comitê de Ética";
    start = Date(2026, 8, 3), duration = 5,
    dependencies = [proto.id],
    assignee = "Ana (Coordenadora)", color = "#8be9fd",
    progress = 100)

# ── Aprovação ── (espera de 30 dias úteis pelo comitê)
approval = add_task!(p, "Aprovação do Comitê de Ética";
    start = Date(2026, 9, 7), duration = 30,
    dependencies = [ethics.id],
    assignee = "Comitê externo", color = "#ffb86c",
    notes = "Prazo legal: até 30 dias. Aguardando resposta.")

# ═══════════════════════════════════════════════════════════
# Fase 2: Coleta e Preparação de Dados
# ═══════════════════════════════════════════════════════════

# ── CRF / Banco de dados ──
crf = add_task!(p, "Desenho do CRF e banco de dados (REDCap)";
    start = Date(2026, 8, 3), duration = 15,
    dependencies = [proto.id],
    assignee = "Carlos (Data Manager)", color = "#50fa7b")

# ── Recrutamento ──
recruit = add_task!(p, "Recrutamento de pacientes (n=200)";
    start = Date(2026, 10, 7), duration = 60,
    dependencies = [approval.id, crf.id],
    assignee = "Equipe clínica", color = "#ff5555",
    notes = "Meta: 5 pacientes/semana em 3 centros")

# ── Digitação ──
digit = add_task!(p, "Dupla digitação e validação dos dados";
    start = Date(2026, 10, 7), duration = 70,
    dependencies = [recruit.id],
    assignee = "Carlos (Data Manager)", color = "#50fa7b")

# ── Query / Data cleaning ──
cleaning = add_task!(p, "Resolução de queries e data cleaning";
    start = Date(2026, 10, 7), duration = 15,
    dependencies = [digit.id],
    assignee = "Carlos + Monitores", color = "#f1fa8c")

# ── Lock do banco ──
lock = add_task!(p, "Lock do banco de dados";
    start = Date(2026, 10, 7), duration = 2,
    dependencies = [cleaning.id],
    assignee = "Carlos", color = "#ffb86c",
    milestone = true)

# ═══════════════════════════════════════════════════════════
# Fase 3: Análise Estatística
# ═══════════════════════════════════════════════════════════

# ── SAP ──
sap = add_task!(p, "Statistical Analysis Plan (SAP)";
    start = Date(2026, 8, 3), duration = 10,
    dependencies = [proto.id],
    assignee = "João (Estatístico Chefe)", color = "#ff79c6",
    progress = 80)

# ── Programação das tabelas ──
tables = add_task!(p, "Programação das tabelas e figuras (SAS/R)";
    start = Date(2026, 8, 3), duration = 20,
    dependencies = [sap.id, crf.id],
    assignee = "Maria (Bioestatística)", color = "#bd93f9",
    progress = 30)

# ── Análise primária ──
primary = add_task!(p, "Análise do desfecho primário (mixed-model)";
    start = Date(2026, 10, 7), duration = 10,
    dependencies = [lock.id, tables.id],
    assignee = "João (Estatístico Chefe)", color = "#ff79c6")

# ── Análises secundárias ──
secondary = add_task!(p, "Análises de desfechos secundários";
    start = Date(2026, 10, 7), duration = 12,
    dependencies = [primary.id],
    assignee = "Maria + João", color = "#bd93f9")

# ── Análise de subgrupos ──
subgroup = add_task!(p, "Análises de subgrupos pré-especificadas";
    start = Date(2026, 10, 7), duration = 8,
    dependencies = [primary.id],
    assignee = "Maria (Bioestatística)", color = "#bd93f9")

# ── Análise de segurança ──
safety = add_task!(p, "Análise de eventos adversos (CTCAE)";
    start = Date(2026, 10, 7), duration = 10,
    dependencies = [primary.id],
    assignee = "João (Estatístico Chefe)", color = "#ff79c6")

# ── Revisão cega ──
blind = add_task!(p, "Reunião de revisão cega dos resultados";
    start = Date(2026, 10, 7), duration = 2,
    dependencies = [secondary.id, subgroup.id, safety.id],
    assignee = "Equipe completa", color = "#f1fa8c",
    milestone = true)

# ═══════════════════════════════════════════════════════════
# Fase 4: Relatório e Publicação
# ═══════════════════════════════════════════════════════════

# ── Relatório ──
report = add_task!(p, "Redação do relatório estatístico final";
    start = Date(2026, 10, 7), duration = 15,
    dependencies = [blind.id],
    assignee = "João (Estatístico Chefe)", color = "#ff79c6")

# ── Manuscript ──
manuscript = add_task!(p, "Redação do manuscrito (CONSORT)";
    start = Date(2026, 10, 7), duration = 20,
    dependencies = [report.id],
    assignee = "Equipe clínica + João", color = "#8be9fd")

# ── Revisão interna ──
review = add_task!(p, "Revisão interna por coautores";
    start = Date(2026, 10, 7), duration = 10,
    dependencies = [manuscript.id],
    assignee = "Todos os coautores", color = "#ffb86c")

# ── Submissão ──
submit = add_task!(p, "Submissão ao periódico (NEJM/Lancet)";
    start = Date(2026, 10, 7), duration = 3,
    dependencies = [review.id],
    assignee = "Ana (Coordenadora)", color = "#50fa7b",
    milestone = true)

println("   ✓ $(length(p.tasks)) tarefas criadas")
println()

# ═══════════════════════════════════════════════════════════
# CPM Scheduling
# ═══════════════════════════════════════════════════════════
println("="^64)
println("  CRITICAL PATH METHOD (CPM)")
println("="^64)
println()

println("⏱️  Executando schedule! (forward pass)...")
schedule!(p)

println("   Projeto finaliza em: $(project_finish(p))")
println("   Span total: $(span(p)[1]) → $(span(p)[2])")
println()

# Caminho crítico
cp = critical_path(p)
println("🔴 Caminho Crítico (tarefas com slack = 0):")
for (i, tid) in enumerate(cp)
    t = p.tasks[findfirst(t -> t.id == tid, p.tasks)]
    println("   $(i). $(t.name)  [$(t.start) → $(end_date(p, t)), $(t.duration)d]")
end
println()

# Análise de folga
println("📊 Análise de Folga (Slack Analysis):")
println(rpad("Tarefa", 48), "Slack  Crítica?  Início       Fim")
println(repeat("-", 88))
for row in slack(p)
    flag = row.critical ? "🔴 SIM  " : "🟢 NÃO  "
    println(rpad(row.name, 48), lpad(row.slack_days, 4), "d  ", flag,
            "  ", row.early_start, "  ", row.early_finish)
end
println()

# ═══════════════════════════════════════════════════════════
# Visualização: Gantt no REPL (Unicode)
# ═══════════════════════════════════════════════════════════
println("="^64)
println("  DIAGRAMA DE GANTT (REPL)")
println("="^64)
println()
show(stdout, MIME("text/plain"), p)
println()

# ═══════════════════════════════════════════════════════════
# Resumo do Projeto
# ═══════════════════════════════════════════════════════════
println("="^64)
println("  RESUMO DO PROJETO")
println("="^64)
println()

n_milestones = count(t -> t.milestone, p.tasks)
n_done = count(t -> t.progress == 100, p.tasks)
n_in_progress = count(t -> 0 < t.progress < 100, p.tasks)
total_progress = round(Int, sum(t.progress for t in p.tasks) / length(p.tasks))

println("   Nome:           $(p.name)")
println("   ID:             $(p.id)")
println("   Tarefas:        $(length(p.tasks)) ($(n_milestones) milestones)")
println("   Concluídas:     $n_done (100%)")
println("   Em andamento:   $n_in_progress")
println("   Progresso médio: $(total_progress)%")
println("   Caminho crítico: $(length(cp)) tarefas")
println("   Data de término: $(project_finish(p))")
println()

println("="^64)
println("  Demo concluída com sucesso! ✅")
println("="^64)