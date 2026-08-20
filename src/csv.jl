# A planilha como porta de entrada e de saída.
#
# O CSV já saía daqui; entrar, não. Era a metade que faltava, e a que mais
# importa: quase todo plano NASCE numa planilha, e sem leitura o Perth só
# aceitava um plano que já era um plano do Perth.
#
# POR QUE NÃO CSV.jl. Ler quinze colunas não paga uma dependência — e o
# pacote já escrevia o CSV à mão, então o leitor à mão é o par do que já
# existia, não uma exceção. O que este leitor cobre do RFC 4180: aspas,
# aspas duplicadas dentro de aspas, separador e quebra de linha DENTRO do
# campo, CRLF, última linha sem quebra, linhas em branco no meio. O que ele
# não cobre: nada além disso — não há inferência de tipo, não há índice, não
# há streaming. Um arquivo de plano tem dezenas de linhas, não milhões.
#
# AS DUAS CONCESSÕES AO EXCEL, que são o motivo de metade dos CSVs do mundo
# não abrirem em lugar nenhum: o BOM no começo do arquivo (que faria a
# primeira coluna se chamar "﻿id" e sumir do cabeçalho) e o PONTO E
# VÍRGULA como separador, que é o que o Excel grava em português, espanhol e
# francês. Farejar o separador é uma linha de código e evita que o usuário
# tenha de saber por que o arquivo dele "não tem colunas".
#
# REFERÊNCIA POR ID OU POR NOME. Este arquivo só entrega células; quem
# monta tarefa é add_tasks!. Mas vale dizer aqui por quê: o CSV que o Perth
# exporta cita `parent` e `dependencies` por ID, e a planilha que uma pessoa
# escreve cita por NOME — ninguém digita "a3f81c02" numa célula. As duas
# formas são a mesma coluna vista de dois lugares, e resolver as duas é o
# que faz o arquivo exportado voltar inteiro E a planilha de alguém entrar.

const _CSV_DELIMS = (',', ';', '\t')

# Colunas que não são texto. O CSV não tem tipos: o que decide é o nome da
# coluna, porque é o esquema da tarefa que sabe o que cada uma significa.
# Inferir pelo conteúdo seria pior — um `assignee` chamado "2024" viraria
# número e a tarefa não teria responsável.
# As colunas que o Perth conhece. Servem para duas coisas: farejar (uma
# planilha de tarefas tem pelo menos uma delas no cabeçalho) e dizer, quando
# falta o `name`, o que o arquivo tinha em vez dele.
const _CSV_COLS = (:id, :name, :start, :duration, :deadline, :pinned, :progress,
                   :assignee, :cost, :effort, :status, :milestone, :parent,
                   :dependencies, :notes, :color,
                   :optimistic, :most_likely, :pessimistic)

const _CSV_INT   = (:duration, :progress, :optimistic, :most_likely, :pessimistic)
const _CSV_FLOAT = (:cost, :effort)
const _CSV_BOOL  = (:milestone, :pinned)

# Escapa uma célula na saída: aspas só quando precisa (separador, aspas ou
# quebra de linha dentro do valor), e aspas dentro viram aspas duplicadas.
function _csv_esc(x)
    v = string(x)
    return (occursin(",", v) || occursin("\"", v) || occursin("\n", v)) ?
        "\"" * replace(v, "\"" => "\"\"") * "\"" : v
end

# As tarefas do projeto como CSV. `effort` fica ao lado de `cost` — quem
# exporta para conferir a carga de alguém numa planilha precisa do número
# que a carga usa —, e as colunas estruturais ficam no fim, então quem lê
# por nome não se mexe quando uma coluna nova entra.
function _to_csv(p::Project)
    io = IOBuffer()
    println(io, "id,name,start,duration,deadline,pinned,progress,assignee,cost," *
                "effort,status,milestone,parent,dependencies,notes")
    for t in p.tasks
        println(io, join(_csv_esc.([t.id, t.name, t.start, t.duration,
                                    something(t.deadline, ""), t.pinned, t.progress,
                                    t.assignee, t.cost, t.effort, t.status,
                                    t.milestone, t.parent,
                                    join(t.dependencies, " "), t.notes]), ","))
    end
    return String(take!(io))
end

# Separador do arquivo, decidido na primeira linha física. Vírgula é o
# padrão e o desempate; ponto e vírgula ganha quando aparece mais, que é o
# arquivo que o Excel de meio mundo grava.
function _csv_delim(head::AbstractString)
    melhor, n = ',', 0
    for d in _CSV_DELIMS
        c = count(==(d), head)
        c > n && ((melhor, n) = (d, c))
    end
    return melhor
end

# Quebra de linha uniforme e sem o BOM do Excel. As duas coisas têm de
# valer também para quem só FAREJA o arquivo: com o BOM na frente, a
# primeira coluna se chamaria "\ufeffid" e o cabeçalho não seria reconhecido.
function _csv_clean(text::AbstractString)
    s = replace(String(text), "\r\n" => "\n", "\r" => "\n")
    return startswith(s, '\ufeff') ? s[nextind(s, 1):end] : s
end

# O texto virando linhas de células. Um varredor de caracteres, porque
# split() não sabe que uma vírgula entre aspas não separa nada.
function _csv_split(text::AbstractString)
    s = _csv_clean(text)
    delim = _csv_delim(first(split(s, '\n'; limit = 2)))
    linhas, atual, campo, aspas = Vector{String}[], String[], IOBuffer(), false
    i = firstindex(s)
    while i <= lastindex(s)
        c = s[i]
        if aspas
            if c == '"'
                j = nextind(s, i)
                if j <= lastindex(s) && s[j] == '"'
                    print(campo, '"')       # "" dentro de aspas é uma aspa
                    i = j
                else
                    aspas = false
                end
            else
                print(campo, c)             # separador e \n aqui dentro são texto
            end
        elseif c == '"'
            aspas = true
        elseif c == delim
            push!(atual, String(take!(campo)))
        elseif c == '\n'
            push!(atual, String(take!(campo)))
            push!(linhas, atual)
            atual = String[]
        else
            print(campo, c)
        end
        i = nextind(s, i)
    end
    push!(atual, String(take!(campo)))       # a última linha, com ou sem \n no fim
    push!(linhas, atual)
    # Linha inteiramente vazia não é linha: é o \n final do arquivo, ou o
    # espaço que alguém deixou entre dois blocos da planilha.
    return (delim, filter(l -> any(!isempty ∘ strip, l), linhas))
end

# Cabeçalho -> símbolo: sem maiúsculas, sem espaço em volta, e com espaço ou
# hífen no meio virando "_" ("most likely" é a mesma coluna que
# "most_likely"). Coluna que não é do esquema não vira erro — ela é
# ignorada, porque uma planilha de verdade tem colunas que são de quem a
# escreveu, não do Perth.
_csv_key(s) = Symbol(replace(lowercase(strip(String(s))), r"[ \-]+" => "_"))

# Mensagem de erro que diz a CÉLULA, não só o tipo: numa planilha de duzentas
# linhas, "expected a whole number" sem endereço é uma caça ao tesouro.
_csv_bad(lin, col, esperado, v) = throw(ArgumentError(
    "CSV row $(lin), column `$(col)`: expected $(esperado), got $(repr(v))"))

function _csv_int(v, lin, col)
    n = tryparse(Int, v)
    n === nothing && _csv_bad(lin, col, "a whole number", v)
    return n
end

function _csv_float(v, lin, col, delim)
    # Vírgula decimal só quando o separador é ponto e vírgula — é a mesma
    # planilha em português/espanhol/francês que grava as duas coisas. Com
    # vírgula separando colunas, "1,5" já teria virado duas células.
    txt = (delim == ';' && occursin(r"^-?\d+,\d+$", v)) ? replace(v, "," => ".") : v
    x = tryparse(Float64, txt)
    x === nothing && _csv_bad(lin, col, "a number", v)
    return x
end

function _csv_bool(v, lin, col)
    b = lowercase(v)
    b in ("true", "1", "yes") && return true
    b in ("false", "0", "no") && return false
    _csv_bad(lin, col, "true or false", v)
end

"""
Linhas Tables.jl a partir de um texto CSV, prontas para `add_tasks!`.

Célula vazia devolve `missing` de propósito: é o que `_cell` já entende como
"não disse", e o default da coluna vale. Isso é o que faz uma planilha de
três colunas funcionar sem inventar zeros para as outras doze.
"""
function _csv_task_rows(text::AbstractString)
    delim, linhas = _csv_split(text)
    isempty(linhas) && throw(ArgumentError("CSV is empty"))
    cols = _csv_key.(popfirst!(linhas))
    :name in cols || throw(ArgumentError(
        "CSV needs a `name` column; this file has: " * join(string.(cols), ", ")))
    rows = NamedTuple{Tuple(cols)}[]
    for (n, l) in enumerate(linhas)
        vals = Any[]
        for (k, col) in enumerate(cols)
            v = k <= length(l) ? strip(l[k]) : ""   # linha curta: célula vazia
            push!(vals, isempty(v) ? missing :
                  col in _CSV_INT   ? _csv_int(v, n + 1, col) :
                  col in _CSV_FLOAT ? _csv_float(v, n + 1, col, delim) :
                  col in _CSV_BOOL  ? _csv_bool(v, n + 1, col) : String(v))
        end
        push!(rows, NamedTuple{Tuple(cols)}(Tuple(vals)))
    end
    return rows
end


# Isto é uma planilha de tarefas? A pergunta é feita na primeira linha não
# vazia: se um dos campos dela é a coluna `name`, é cabeçalho de CSV. É
# estreito de propósito — um .perth.jl começa por comentário e traz
# `name = "Obra"` (que normaliza para `name_=_"obra"`, e não para `name`),
# então nenhum dos dois formatos antigos cai aqui por acidente.
function _csv_looks_like(text::AbstractString)
    linha = ""
    for l in split(_csv_clean(text), '\n')
        isempty(strip(l)) || (linha = l; break)
    end
    isempty(linha) && return false
    cols = _csv_key.(split(linha, _csv_delim(linha)))
    # QUALQUER coluna conhecida basta, e não o `name` — um arquivo com
    # `titulo,duration` é uma planilha com a coluna errada, e merece ouvir
    # isso de _csv_task_rows em vez de ser oferecido ao parser de .perth.jl,
    # que responderia sobre expressões de Julia a quem mandou uma tabela.
    return any(c -> c in _CSV_COLS, cols)
end

# Um projeto novo a partir do texto de uma planilha. O nome vem de fora (do
# arquivo que o navegador mandou): uma tabela de tarefas não carrega o nome
# do plano, e inventar um a partir da primeira tarefa seria adivinhação.
function _project_from_csv(text::AbstractString, nome::AbstractString)
    rows = _csv_task_rows(text)      # erra ANTES de existir projeto nenhum
    p = Project(name = isempty(strip(nome)) ? "Imported" : String(strip(nome)))
    _append_tasks!(p, rows)
    return p
end
