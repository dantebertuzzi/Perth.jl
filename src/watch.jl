# Observador do arquivo espelhado (.perth.jl).
#
# O espelho já ia do Perth para o disco: cada salvamento regrava o arquivo
# apontado por file_path. Faltava a volta — editar o arquivo no editor e ver
# o navegador acompanhar. Sem isso, quem prefere código tinha que voltar ao
# REPL e chamar Perth.load à mão, e pior: com o projeto aberto no navegador,
# o próximo salvamento pela UI passava por cima do que tinha sido editado.
#
# Como o servidor avisa os navegadores: _save! bumpa a revisão e chama
# _notify_rev, que o run() liga ao broadcast do WebSocket. Então recarregar
# do disco e salvar já faz a tela se atualizar sozinha — nada novo é preciso
# do lado do navegador.

const _WATCHERS = Dict{String,String}()      # id do projeto → caminho observado
const _WATCH_LOCK = ReentrantLock()
const _WATCH_ON = Ref(true)                  # run(watch = false) desliga
const _WATCH_TIMEOUT = 5.0                   # acorda para reavaliar se ainda vale

"""
    _watch_reload!(id, path) -> Symbol

Lê o arquivo e, se ele descreve algo diferente do que está em memória,
substitui o projeto. Devolve o que aconteceu, para o teste poder afirmar
sobre cada caminho: `:reloaded`, `:same`, `:invalid`, `:gone` ou `:unlinked`.

O que o arquivo NÃO decide é o mesmo de sempre (ver _put_source em api.jl):
id, created_at e o próprio file_path. Um arquivo editado à mão continua
sendo o conteúdo de um projeto, não a identidade dele.
"""
function _watch_reload!(id::AbstractString, path::AbstractString)
    isfile(path) || return :gone
    src = try
        read(path, String)
    catch
        return :invalid
    end
    return _with_state(st -> begin
        haskey(st.projects, id) || return :unlinked
        atual = st.projects[id]
        atual.file_path == path || return :unlinked
        # A escrita foi nossa? O conteúdo bate com o que geraríamos agora.
        # Comparar conteúdo (e não carimbo de tempo) evita depender de
        # relógio e de ordem de eventos — e o laço fecha em um ciclo extra
        # sem efeito, porque a normalização do _save! é idempotente.
        _to_julia_source(atual) == src && return :same
        novo = try
            _parse_project_source(src)
        catch
            return :invalid          # arquivo salvo pela metade, ou inválido
        end
        # Muta o objeto EXISTENTE em vez de trocá-lo no dicionário: quem
        # tem `p = project("obra")` aberto no REPL continua com uma alça
        # válida. Trocar o objeto deixaria essa alça órfã — e o próximo
        # add_task! nela ressuscitaria o estado antigo por cima do arquivo.
        # id, created_at e file_path ficam: o arquivo traz conteúdo, não
        # identidade.
        atual.name = novo.name
        atual.tasks = novo.tasks
        atual.calendar = novo.calendar
        atual.baseline_at = novo.baseline_at
        atual.updated_at = novo.updated_at
        _save!(st, atual)            # grava, bumpa rev, avisa os navegadores
        _log_activity!(st, "file", "edit", "reloaded from $(basename(path))")
        return :reloaded
    end)
end

# Uma tarefa por projeto espelhado. watch_file bloqueia até o arquivo mudar;
# o timeout existe para a tarefa acordar e conferir se ainda deve observar
# (o projeto pode ter sido desvinculado, apagado, ou o servidor parado).
function _watch_task(id::AbstractString, path::AbstractString)
    return @async begin
        try
            while _WATCH_ON[] && get(_WATCHERS, id, "") == path
                ev = try
                    FileWatching.watch_file(path, _WATCH_TIMEOUT)
                catch
                    break                      # caminho sumiu debaixo de nós
                end
                (ev.timedout || !_WATCH_ON[]) && continue
                # Editor grava em etapas (trunca e escreve, ou renomeia por
                # cima): sem esta pausa a leitura pega arquivo pela metade e
                # o parser recusa por sintaxe.
                sleep(0.12)
                r = _watch_reload!(id, path)
                (r === :unlinked || r === :gone) && break
            end
        finally
            lock(_WATCH_LOCK) do
                get(_WATCHERS, id, "") == path && delete!(_WATCHERS, id)
            end
        end
    end
end

"""
    _watch_sync!(st)

Acerta o conjunto de observadores com os projetos que têm espelho. Chamado
de onde o estado muda (`_save!`, `_delete!`) e na subida do servidor, para
não precisar instrumentar cada ponto de mutação.
"""
function _watch_sync!(st::AppState)
    _WATCH_ON[] || return nothing
    lock(_WATCH_LOCK) do
        atuais = Dict(p.id => p.file_path for p in values(st.projects)
                      if !isempty(p.file_path))
        for (id, path) in atuais
            get(_WATCHERS, id, "") == path && continue
            _WATCHERS[id] = path              # a tarefa antiga sai sozinha
            _watch_task(id, path)
        end
        for id in collect(keys(_WATCHERS))
            haskey(atuais, id) || delete!(_WATCHERS, id)
        end
    end
    return nothing
end

# Desliga tudo (Perth.stop()). As tarefas acordam no timeout e saem.
function _watch_stop_all!()
    lock(_WATCH_LOCK) do
        empty!(_WATCHERS)
    end
    return nothing
end
