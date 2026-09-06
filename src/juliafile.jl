# Formato de intercâmbio .perth.jl: o projeto exportado é código Julia
# legível — diffável em git e reconstruível no REPL. A leitura NÃO usa
# eval/include: um avaliador restrito caminha a AST e aceita apenas os
# construtores da whitelist. Qualquer outra chamada (run, readline, …)
# é rejeitada, então importar um arquivo de terceiros é seguro.
#
# O armazenamento interno em ~/.perth continua JSON (parsing rápido e
# inequívoco na inicialização); .jl é o formato de exportação/importação.

const _SAFE_CONSTRUCTORS = Dict{Symbol,Any}(
    :Project   => Project,
    :GanttTask => GanttTask,
    :Person    => Person,
    :Band     => Band,
    :Marker   => Marker,
    :MonthMark => MonthMark,
    :Date      => Dates.Date,
    :DateTime  => Dates.DateTime,
)

# ---------------------------------------------------------------------------
# Escrita
# ---------------------------------------------------------------------------

# Gera o código-fonte do projeto. Campos com valor default são omitidos
# para o arquivo ficar limpo e os diffs, mínimos.
function _to_julia_source(p::Project)
    io = IOBuffer()
    println(io, "# Perth project — readable, executable Julia source")
    println(io, "# Rebuild in the REPL:  using Perth;  p = Perth.load(\"file.perth.jl\")")
    println(io, "# (Perth.load uses a restricted parser and never executes code)")
    println(io, "Project(")
    println(io, "    id = ", repr(p.id), ",")
    println(io, "    name = ", repr(p.name), ",")
    isempty(p.calendar) ||
        println(io, "    calendar = ", repr(p.calendar), ",")
    if !isempty(p.markers)
        println(io, "    markers = [")
        for m in p.markers
            campos = ["name = " * repr(m.name),
                     "date = Date(" * repr(string(m.date)) * ")"]
            isempty(m.color) || push!(campos, "color = " * repr(m.color))
            m.label_at == 0 || push!(campos, "label_at = " * string(m.label_at))
            println(io, "        Marker(", join(campos, ", "), "),")
        end
        println(io, "    ],")
    end
    if !isempty(p.month_marks)
        println(io, "    month_marks = [")
        for m in p.month_marks
            campos = ["month = Date(" * repr(string(m.month)) * ")"]
            isempty(m.name) || push!(campos, "name = " * repr(m.name))
            isempty(m.color) || push!(campos, "color = " * repr(m.color))
            println(io, "        MonthMark(", join(campos, ", "), "),")
        end
        println(io, "    ],")
    end
    if !isempty(p.bands)
        println(io, "    bands = [")
        for f in p.bands
            campos = ["name = " * repr(f.name),
                     "from = Date(" * repr(string(f.from)) * ")",
                     "to = Date(" * repr(string(f.to)) * ")"]
            isempty(f.color) || push!(campos, "color = " * repr(f.color))
            println(io, "        Band(", join(campos, ", "), "),")
        end
        println(io, "    ],")
    end
    if !isempty(p.people)
        println(io, "    people = [")
        for pe in p.people
            campos = ["name = " * repr(pe.name)]
            for c in (:role, :team, :email, :notes)
                v = getfield(pe, c)
                isempty(v) || push!(campos, string(c) * " = " * repr(v))
            end
            # capacity é número: o "vazio" dele é o zero, não o isempty acima
            pe.capacity > 0 && push!(campos, "capacity = " * repr(pe.capacity))
            println(io, "        Person(", join(campos, ", "), "),")
        end
        println(io, "    ],")
    end
    p.baseline_at === nothing ||
        println(io, "    baseline_at = DateTime(", repr(string(p.baseline_at)), "),")
    println(io, "    created_at = DateTime(", repr(string(p.created_at)), "),")
    println(io, "    updated_at = DateTime(", repr(string(p.updated_at)), "),")
    println(io, "    tasks = [")
    for t in p.tasks
        println(io, "        GanttTask(")
        println(io, "            id = ", repr(t.id), ",")
        println(io, "            name = ", repr(t.name), ",")
        println(io, "            start = Date(", repr(string(t.start)), "),")
        t.milestone || println(io, "            duration = ", t.duration, ",")
        t.progress != 0 && println(io, "            progress = ", t.progress, ",")
        isempty(t.dependencies) ||
            println(io, "            dependencies = ", repr(t.dependencies), ",")
        isempty(t.color) || println(io, "            color = ", repr(t.color), ",")
        isempty(t.assignee) || println(io, "            assignee = ", repr(t.assignee), ",")
        isempty(t.notes) || println(io, "            notes = ", repr(t.notes), ",")
        # cost saía do arquivo pelo caminho de nunca ter sido escrito: um
        # projeto com custos salvo em .perth.jl e recarregado voltava zerado.
        # O formato é o de intercâmbio para gente e para controle de versão —
        # campo que ele engole é campo que some no primeiro git pull.
        t.cost == 0 || println(io, "            cost = ", t.cost, ",")
        t.effort == 0 || println(io, "            effort = ", t.effort, ",")
        t.milestone && println(io, "            milestone = true,")
        isempty(t.parent) || println(io, "            parent = ", repr(t.parent), ",")
        t.order == 0 || println(io, "            order = ", t.order, ",")
        t.baseline_start === nothing ||
            println(io, "            baseline_start = Date(", repr(string(t.baseline_start)), "),")
        t.baseline_duration == 0 ||
            println(io, "            baseline_duration = ", t.baseline_duration, ",")
        t.deadline === nothing ||
            println(io, "            deadline = Date(", repr(string(t.deadline)), "),")
        t.pinned && println(io, "            pinned = true,")
        isempty(t.status) || println(io, "            status = ", repr(t.status), ",")
        if has_estimate(t)   # os três juntos ou nenhum: meia estimativa não diz nada
            println(io, "            optimistic = ", t.optimistic, ",")
            println(io, "            most_likely = ", t.most_likely, ",")
            println(io, "            pessimistic = ", t.pessimistic, ",")
        end
        println(io, "        ),")
    end
    println(io, "    ],")
    print(io, ")")
    return String(take!(io))
end

"""
    Perth.save(p::Project, path::AbstractString) -> String

Write `p` to `path` as readable, git-diffable Julia source
(the `.perth.jl` interchange format). Returns the path.
"""
function save(p::Project, path::AbstractString)
    write(path, _to_julia_source(p))
    return String(path)
end

# Normaliza o caminho digitado pelo usuário (UI ou REPL) para um arquivo
# .perth.jl absoluto:
#   ~            -> expandido
#   diretório/   -> anexa "<slug-do-nome>.perth.jl"
#   sem .jl      -> anexa ".perth.jl"
# Lança ArgumentError se o diretório-pai não existir (não criamos diretórios
# silenciosamente: um typo não deve espalhar pastas pelo disco).
function _resolve_save_path(p::Project, raw::AbstractString)
    raw = strip(raw)
    path = abspath(expanduser(raw))
    if isdir(path) || endswith(raw, '/') || endswith(raw, '\\')
        # acento é transliterado, não descartado: sem isto "Análise
        # estatística" virava o arquivo "an-lise-estat-stica.perth.jl".
        # Mesma armadilha do slug de board no kanban (ver _slugify), e este
        # é um nome que o usuário vê e convive.
        ascii = Unicode.normalize(lowercase(p.name); stripmark = true)
        slug = strip(replace(ascii, r"[^a-z0-9]+" => "-"), '-')
        isempty(slug) && (slug = p.id)
        path = joinpath(path, "$(slug).perth.jl")
    end
    endswith(lowercase(path), ".jl") || (path *= ".perth.jl")
    dir = dirname(path)
    isdir(dir) || throw(ArgumentError("directory does not exist: $dir"))
    return path
end

"""
    set_file_path!(p::Project, path::AbstractString) -> String
    set_file_path!(p::Project, nothing) -> String

Link `p` to a `.perth.jl` file on disk (Pluto-style): the file is written
immediately and re-written on every subsequent save, from the web UI or
the REPL. `~` is expanded; a directory path gets a filename derived from
the project name; a missing `.jl` extension is appended.

Pass `nothing` (or an empty string) to unlink the project from the file.
Returns the resolved path (empty string when unlinked).
"""
function set_file_path!(p::Project, path::Union{Nothing,AbstractString})
    raw = path === nothing ? "" : strip(path)
    if isempty(raw)
        p.file_path = ""
        _with_state(st -> _save!(st, p))
        return ""
    end
    resolved = _resolve_save_path(p, raw)
    write(resolved, _to_julia_source(p))  # falha aqui aborta antes de vincular
    p.file_path = resolved
    _with_state(st -> begin
        _save!(st, p)
        _remember_save_dir!(st, resolved)
    end)
    return resolved
end

# ---------------------------------------------------------------------------
# Leitura: tokenizador + parser ITERATIVOS, sem Meta.parseall
# ---------------------------------------------------------------------------
#
# A gramática do formato cabe em cinco linhas — chamada de construtor, literal
# e vetor — e era lida pelo parser completo do Julia, que é recursivo e morre
# com core dump em vez de lançar. Nenhuma guarda de texto dá conta disso: o
# que faz o parser recursar é a FORMA da expressão, não o tamanho, e um
# projeto de 1000 tarefas carrega cinco vezes mais caractere estrutural que o
# menor fonte que derruba o processo. Não há teto que separe os dois.
#
# Este parser tem pilha explícita e teto nela, então não existe entrada que o
# faça recursar. É o que encerra a categoria, em vez de fechar mais um caso.
#
#   valor  := chamada | literal | vetor
#   chamada:= IDENT '(' (arg (',' | ';') ...)* ')'
#   arg    := IDENT '=' valor | valor
#   vetor  := '[' (valor ',' ...)* ']'
#   literal:= string | número | true | false | nothing

struct _Tok
    tipo::Symbol          # :ident :str :num :lit :abre :fecha :abrev :fechav :virg :igual
    valor::Any
end

_ident_inicio(c) = isletter(c) || c == '_'
_ident_corpo(c) = isletter(c) || isdigit(c) || c == '_' || c == '!'

# Um número começa por dígito, por ponto seguido de dígito (`.5`) ou por sinal
# antes de um dos dois (`-.5`). Ponto inicial e separador `_` são Julia válido e
# gente escreve os dois à mão, então o leitor aceita — o escritor nunca emite.
function _num_inicio(src, i)
    c = src[i]
    isdigit(c) && return true
    j = i
    if c == '-'
        j = nextind(src, j)
        j > lastindex(src) && return false
        c = src[j]
        isdigit(c) && return true
    end
    if c == '.'
        k = nextind(src, j)
        return k <= lastindex(src) && isdigit(src[k])
    end
    return false
end

function _tokenize(src::AbstractString)
    toks = _Tok[]
    i = firstindex(src)
    while i <= lastindex(src)
        c = src[i]
        if isspace(c)
            i = nextind(src, i)
        elseif c == '#'
            i = _peek(src, i) == '=' ? _skip_block_comment(src, i) : _skip_line_comment(src, i)
        elseif c == '"'
            j = _skip_string(src, i)
            # Desescapar à mão é onde mora o bug sutil. Um literal de string
            # sozinho não recursa, então o parser do Julia pode lê-lo — e aí
            # \n, \x41 e """ valem exatamente o que valem em Julia.
            # Meta.parse lanca ParseError, nao ArgumentError, quando o
            # literal e' malformado ("20$26" e afins). Deixar escapar viraria
            # 500 no /api/import em vez do 400 que o resto deste parser da'.
            texto = try
                Meta.parse(String(SubString(src, i, prevind(src, j))))
            catch err
                err isa InterruptException && rethrow()
                throw(ArgumentError("Perth: project file has a malformed string literal"))
            end
            texto isa AbstractString || throw(ArgumentError(
                "Perth: project file has a string that is not a plain literal"))
            push!(toks, _Tok(:str, String(texto)))
            i = j
        elseif _num_inicio(src, i)
            j, viu_ponto = i, false
            c == '-' && (j = nextind(src, j))
            while j <= lastindex(src)
                d = src[j]
                if isdigit(d)
                    j = nextind(src, j)
                elseif d == '_' && (m = nextind(src, j); m <= lastindex(src) &&
                        isdigit(src[m]) && isdigit(src[prevind(src, j)]))
                    j = nextind(src, j)
                elseif d == '.' && !viu_ponto
                    viu_ponto = true; j = nextind(src, j)
                elseif (d == 'e' || d == 'E') && (m = nextind(src, j);
                        m <= lastindex(src) && (isdigit(src[m]) || src[m] in ('+', '-')))
                    viu_ponto = true; j = nextind(src, nextind(src, j))
                else
                    break
                end
            end
            texto = replace(String(SubString(src, i, prevind(src, j))), '_' => "")
            n = viu_ponto ? tryparse(Float64, texto) : tryparse(Int, texto)
            n === nothing && throw(ArgumentError("Perth: project file has a bad number $(repr(texto))"))
            push!(toks, _Tok(:num, n))
            i = j
        elseif _ident_inicio(c)
            j = i
            while j <= lastindex(src) && _ident_corpo(src[j])
                j = nextind(src, j)
            end
            nome = String(SubString(src, i, prevind(src, j)))
            push!(toks, nome == "true"    ? _Tok(:lit, true) :
                        nome == "false"   ? _Tok(:lit, false) :
                        nome == "nothing" ? _Tok(:lit, nothing) :
                                            _Tok(:ident, Symbol(nome)))
            i = j
        else
            tipo = c == '(' ? :abre : c == ')' ? :fecha :
                   c == '[' ? :abrev : c == ']' ? :fechav :
                   c == ',' || c == ';' ? :virg : c == '=' ? :igual : :nao
            tipo === :nao && throw(ArgumentError(
                "Perth: project file uses a character the format never writes: $(repr(c))"))
            push!(toks, _Tok(tipo, nothing))
            i = nextind(src, i)
        end
    end
    return toks
end

# Um quadro por nível aberto. A pilha é a profundidade, e o teto nela é o que
# torna impossível estourar: não há chamada recursiva a estourar.
mutable struct _Quadro
    tipo::Symbol                        # :chamada ou :vetor
    nome::Symbol
    args::Vector{Any}
    kws::Vector{Pair{Symbol,Any}}
    chave::Union{Nothing,Symbol}        # kwarg cujo valor ainda não chegou
end

function _emitir!(pilha, pronto, valor)
    if isempty(pilha)
        pronto[] === nothing || throw(ArgumentError(
            "Perth: project file must contain exactly one expression"))
        pronto[] = valor
        return nothing
    end
    q = pilha[end]
    if q.chave !== nothing
        push!(q.kws, q.chave => valor)
        q.chave = nothing
    else
        push!(q.args, valor)
    end
    return nothing
end

function _parse_restricted(src::AbstractString)
    toks = _tokenize(src)
    pilha = _Quadro[]
    pronto = Ref{Any}(nothing)
    i = 1
    while i <= length(toks)
        t = toks[i]
        if t.tipo === :ident
            prox = i < length(toks) ? toks[i + 1].tipo : :fim
            if prox === :abre
                haskey(_SAFE_CONSTRUCTORS, t.valor) || throw(ArgumentError(
                    "Perth: call not allowed in project file: $(t.valor)"))
                push!(pilha, _Quadro(:chamada, t.valor, Any[], Pair{Symbol,Any}[], nothing))
                length(pilha) <= _MAX_SOURCE_DEPTH || throw(ArgumentError(
                    "Perth: project file nests too deeply (over $(_MAX_SOURCE_DEPTH) levels)"))
                i += 2
            elseif prox === :igual
                isempty(pilha) && throw(ArgumentError(
                    "Perth: project file has a keyword outside a constructor call"))
                pilha[end].chave === nothing || throw(ArgumentError("Perth: unsupported keyword syntax"))
                pilha[end].chave = t.valor
                i += 2
            else
                throw(ArgumentError("Perth: name not allowed in project file: $(t.valor)"))
            end
        elseif t.tipo === :str || t.tipo === :num || t.tipo === :lit
            _emitir!(pilha, pronto, t.valor)
            i += 1
        elseif t.tipo === :abrev
            push!(pilha, _Quadro(:vetor, :vetor, Any[], Pair{Symbol,Any}[], nothing))
            length(pilha) <= _MAX_SOURCE_DEPTH || throw(ArgumentError(
                "Perth: project file nests too deeply (over $(_MAX_SOURCE_DEPTH) levels)"))
            i += 1
        elseif t.tipo === :fecha || t.tipo === :fechav
            esperado = t.tipo === :fecha ? :chamada : :vetor
            (!isempty(pilha) && pilha[end].tipo === esperado) || throw(ArgumentError(
                "Perth: project file has unbalanced brackets"))
            q = pop!(pilha)
            q.chave === nothing || throw(ArgumentError("Perth: project file has a keyword with no value"))
            valor = if q.tipo === :vetor
                q.args
            else
                try
                    _SAFE_CONSTRUCTORS[q.nome](q.args...; q.kws...)
                catch err
                    err isa InterruptException && rethrow()
                    throw(ArgumentError("Perth: $(q.nome) rejected this file: $(sprint(showerror, err))"))
                end
            end
            _emitir!(pilha, pronto, valor)
            i += 1
        elseif t.tipo === :virg
            i += 1
        else
            throw(ArgumentError("Perth: project file has a stray '='"))
        end
    end
    isempty(pilha) || throw(ArgumentError("Perth: project file has unbalanced brackets"))
    pronto[] === nothing && throw(ArgumentError(
        "Perth: project file must contain exactly one expression"))
    return pronto[]
end

# Tetos do fonte aceito. Um .perth.jl real aninha 4 níveis (Project → tasks
# → GanttTask → Date); 32 é folga de sobra. O motivo de existirem é grave: o
# parser do PRÓPRIO Julia é recursivo e morre — não lança exceção, derruba o
# processo com core dump — em poucos milhares de colchetes aninhados. Como
# fonte chega por HTTP (import e o painel "ver código"), sem este teto
# qualquer cliente derruba o servidor com alguns KB de "[[[[[".
const _MAX_SOURCE_BYTES = 4 * 1024 * 1024
const _MAX_SOURCE_DEPTH = 32

# Cadeia de sinal unário é o outro jeito de fazer o parser recursar, e não
# gasta colchete nenhum: "-"^25_000 já derruba. Um número do formato leva no
# máximo um sinal, então 4 seguidos é folga e ainda assim fica 3 ordens de
# grandeza abaixo do ponto de quebra.
const _MAX_SIGN_RUN = 4

# Os únicos caracteres que um .perth.jl usa FORA de string e de comentário.
# O formato é gerado por máquina e o parser só aceita chamada de
# construtor, literal e vetor — então tudo que esta lista barra JÁ seria
# recusado adiante, e nenhum arquivo que antes era aceito passa a falhar.
#
# A lista não é estética: é ela que torna o contador de profundidade
# confiável. Sem `'` não existe literal de char cujo `)` finja de fechamento;
# sem `?` e `:` não existe ternário, que recursa sem abrir colchete algum.
const _SOURCE_CHARS = Set{Char}("()[],;=.+-_ \t\r\n" *
                                "0123456789" *
                                "abcdefghijklmnopqrstuvwxyz" *
                                "ABCDEFGHIJKLMNOPQRSTUVWXYZ")

_peek(src, i) = (j = nextind(src, i); j <= lastindex(src) ? src[j] : '\0')

# Consome até o fim da linha; devolve o índice do '\n' (ou passa do fim).
function _skip_line_comment(src, i)
    while i <= lastindex(src) && src[i] != '\n'
        i = nextind(src, i)
    end
    return i
end

# Comentário de bloco aninha em Julia: #= #= =# =# é UM comentário só. Contar
# o nível é o que impede que o `=#` de dentro devolva o scanner ao código cedo
# demais — e com ele todos os ")" seguintes viravam decremento de verdade.
function _skip_block_comment(src, i)
    nivel = 0
    while i <= lastindex(src)
        c, prox = src[i], _peek(src, i)
        if c == '#' && prox == '='
            nivel += 1
            i = nextind(src, nextind(src, i))
        elseif c == '=' && prox == '#'
            nivel -= 1
            i = nextind(src, nextind(src, i))
            nivel == 0 && return i
        else
            i = nextind(src, i)
        end
    end
    throw(ArgumentError("Perth: project file has an unterminated block comment"))
end

# Três aspas a partir de i? Serve tanto para abrir quanto para fechar.
function _is_triple(src, i)
    j = nextind(src, i)
    j <= lastindex(src) && src[j] == '"' || return false
    k = nextind(src, j)
    return k <= lastindex(src) && src[k] == '"'
end

# Fecha a string e devolve o índice logo depois dela. Tratar """ é o que
# fecha o desvio mais silencioso: `"""a"b"""` tem sete aspas, e o scanner de
# aspas simples terminava ACHANDO que ainda estava dentro de uma string —
# daí em diante ignorava todo colchete e a profundidade nunca mais subia.
function _skip_string(src, i)
    tripla = _is_triple(src, i)
    i = tripla ? nextind(src, nextind(src, nextind(src, i))) : nextind(src, i)
    while i <= lastindex(src)
        c = src[i]
        if c == '\\'
            i = nextind(src, i)
            i > lastindex(src) && break
            i = nextind(src, i)
        elseif c == '"'
            if tripla && !_is_triple(src, i)
                i = nextind(src, i)          # aspa solta DENTRO de \"\"\"…\"\"\"
            elseif tripla
                return nextind(src, nextind(src, nextind(src, i)))
            else
                return nextind(src, i)
            end
        else
            i = nextind(src, i)
        end
    end
    throw(ArgumentError("Perth: project file has an unterminated string"))
end

# Recusa fonte que o parser do Julia não sobreviveria a ler. String e
# comentário são pulados inteiros — um nome de tarefa com "(((" não é
# aninhamento, e recusá-lo seria falso positivo em projeto legítimo; fora
# deles, só passa o que o formato realmente usa (ver _SOURCE_CHARS).
function _guard_source(src::AbstractString)
    sizeof(src) <= _MAX_SOURCE_BYTES || throw(ArgumentError(
        "Perth: project file is too large " *
        "(over $(_MAX_SOURCE_BYTES ÷ 1024^2) MB)"))
    depth = 0
    sinais = 0
    i = firstindex(src)
    while i <= lastindex(src)
        c = src[i]
        if c == '#'
            i = _peek(src, i) == '=' ? _skip_block_comment(src, i) :
                                       _skip_line_comment(src, i)
            continue
        elseif c == '"'
            i = _skip_string(src, i)
            continue
        end
        c in _SOURCE_CHARS || throw(ArgumentError(
            "Perth: project file uses a character the format never writes: " *
            "$(repr(c)) — only constructor calls, literals and vectors belong here"))
        if c == '+' || c == '-'
            sinais += 1
            sinais <= _MAX_SIGN_RUN || throw(ArgumentError(
                "Perth: project file chains too many signs " *
                "(over $(_MAX_SIGN_RUN) in a row)"))
        elseif !isspace(c)
            sinais = 0
        end
        if c == '(' || c == '['
            depth += 1
            depth <= _MAX_SOURCE_DEPTH || throw(ArgumentError(
                "Perth: project file nests too deeply " *
                "(over $(_MAX_SOURCE_DEPTH) levels)"))
        elseif c == ')' || c == ']'
            depth = max(depth - 1, 0)
        end
        i = nextind(src, i)
    end
    return nothing
end

# Faz o parse do fonte completo e exige exatamente uma expressão Project(...)
function _parse_project_source(src::AbstractString)
    _guard_source(src)          # peneira barata; o teto de verdade é a pilha
    val = _parse_restricted(src)
    val isa Project ||
        throw(ArgumentError("Perth: file does not evaluate to a Project"))
    # file_path é caminho de espelhamento DESTA máquina e, por isso, nunca é
    # escrito no formato (ver types.jl). O leitor precisa dizer o mesmo: um
    # arquivo que o declare faz o primeiro salvamento gravar por cima do que
    # ele apontar — ~/.ssh/authorized_keys, um fonte, um documento. Recusar é
    # melhor que ignorar: arquivo de terceiros com esse campo não é engano de
    # digitação, e falhar alto é o que o resto deste parser faz.
    isempty(val.file_path) ||
        throw(ArgumentError("Perth: file_path is machine-specific and never " *
                            "part of a project file — set it with set_file_path!"))
    _prune_dependencies!(val)
    _prune_parents!(val)
    _rollup_summaries!(val)
    foreach(_normalize!, val.tasks)
    return val
end

"""
    Perth.load(path::AbstractString; register = true) -> Project

Read a `.perth.jl` project file using a restricted AST evaluator —
no code in the file is ever executed; only `Project`, `GanttTask`,
`Date`, `DateTime`, literals and vectors are accepted.

With `register = true` (default) the project is stored (a project with
the same `id` is replaced), so it appears in the web UI immediately.
"""
function load(path::AbstractString; register::Bool = true)
    p = _parse_project_source(read(path, String))
    register && _with_state(st -> begin
        st.projects[p.id] = p
        _save!(st, p)
    end)
    return p
end
