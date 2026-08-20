# test/update.jl — aviso de versão nova.
#
# Duas regras valem para o arquivo inteiro:
#   • todo teste que ESCREVE cache roda dentro de withenv("PERTH_DATA_DIR"),
#     porque _update_file() usa _default_data_dir() e não o estado da suíte —
#     sem isso a suíte escreveria no ~/.perth de quem está rodando o teste;
#   • nada aqui depende de rede, e o registro pode legitimamente faltar
#     (máquina sem General clonado), então _registry_latest() é testado por
#     tipo, não por valor.

using Test

_tmpdata(f) = withenv(f, "PERTH_DATA_DIR" => mktempdir())
_nofx_u(s) = replace(String(s), r"\x1b\[[0-9;?]*[a-zA-Z]" => "")

@testset "update" begin

    @testset "registro local" begin
        v = Perth._registry_latest()
        @test v === nothing || v isa VersionNumber
        # A primeira chamada da sessão carrega o Pkg por Base.require: sem o
        # invokelatest ela caía em MethodError por world age e devolvia nothing
        # enquanto a segunda acertava. As duas têm que concordar.
        @test v == Perth._registry_latest()
        v === nothing || @test v >= v"0.1.0"
    end

    @testset "cache: ida e volta" begin
        _tmpdata() do
            @test Perth._update_cache() === nothing        # nada gravado ainda
            @test Perth._update_stale()                    # sem cache ⇒ vencido
            Perth._update_cache!(v"9.9.9")
            c = Perth._update_cache()
            @test c !== nothing
            @test c.latest == v"9.9.9"
            @test !Perth._update_stale(c)                  # acabou de ser escrito
            @test isfile(joinpath(ENV["PERTH_DATA_DIR"], "update-check.json"))
        end
    end

    @testset "cache ilegível não derruba nada" begin
        _tmpdata() do
            write(joinpath(ENV["PERTH_DATA_DIR"], "update-check.json"), "{isto não é json")
            @test Perth._update_cache() === nothing
            @test Perth._update_available() === nothing
            @test Perth._update_stale()
        end
    end

    @testset "cache vencido" begin
        _tmpdata() do
            write(joinpath(ENV["PERTH_DATA_DIR"], "update-check.json"),
                  """{"checked":1,"latest":"0.1.0"}""")
            @test Perth._update_stale()
            t = Perth._update_refresh_async()
            @test t !== nothing
            wait(t)
            # Sem registro na máquina a revalidação não escreve nada — e é
            # exatamente isso que queremos: o cache velho continua velho e a
            # próxima sessão tenta de novo, em vez de gravar um "não sei".
            c = Perth._update_cache()
            if Perth._registry_latest() === nothing
                @test c.latest == v"0.1.0"
            else
                @test !Perth._update_stale(c)
            end
        end
    end

    @testset "o aviso só aparece quando há versão nova" begin
        atual = Perth._current_version()
        @test atual isa VersionNumber
        _tmpdata() do
            Perth._update_cache!(atual)                    # em dia
            @test Perth._update_available() === nothing
            Perth._update_cache!(VersionNumber(atual.major, atual.minor, atual.patch + 1))
            @test Perth._update_available() !== nothing
            @test Perth._update_available() > atual
            # PERTH_UPDATE_CHECK=0 desliga tudo, cache novo ou não
            withenv("PERTH_UPDATE_CHECK" => "0") do
                @test Perth._update_available() === nothing
                @test Perth._update_refresh_async() === nothing
            end
        end
    end

    @testset "o arquivo de cache não vira projeto fantasma" begin
        # Mora no mesmo diretório dos projetos; _init_state! tem que ignorá-lo.
        dir = mktempdir()
        withenv("PERTH_DATA_DIR" => dir) do
            Perth._update_cache!(v"9.9.9")
            st = Perth._init_state!(dir)
            @test isempty(st.projects)
        end
        Perth._init_state!(tmp)                            # devolve a suíte ao lugar
    end

    @testset "linha no bloco de entrada" begin
        _forced() do
            _tmpdata() do
                atual = Perth._current_version()
                Perth._update_cache!(atual)
                base_est = Perth._bloco(string(atual), 0)
                base_nav = Perth._bloco(string(atual), 1)

                nova = VersionNumber(atual.major, atual.minor, atual.patch + 1)
                Perth._update_cache!(nova)
                com_est = Perth._bloco(string(atual), 0)
                com_nav = Perth._bloco(string(atual), 1)

                @test length(com_est) == length(base_est) + 1   # uma linha, as duas formas
                @test length(com_nav) == length(base_nav) + 1
                @test occursin(string(nova), _nofx_u(com_est[end]))
                @test occursin(string(nova), _nofx_u(com_nav[end]))
                # as portas continuam intactas
                @test com_est[1:length(base_est)] == base_est
                @test com_nav[1:length(base_nav)] == base_nav

                buf = IOBuffer()
                Perth._hint(buf; version = string(atual))
                @test occursin(string(nova), _nofx_u(String(take!(buf))))
            end
        end
    end

    @testset "check_update imprime e não levanta" begin
        _tmpdata() do
            buf = IOBuffer()
            r = _forced() do
                Perth.check_update(buf)
            end
            @test r === nothing || r isa VersionNumber
            saida = _nofx_u(String(take!(buf)))
            @test occursin("perth", saida)
            # fora de TTY vira @info, sem escrever no io
            withenv("PERTH_SPLASH" => nothing, "CI" => "true") do
                buf2 = IOBuffer()
                with_logger(NullLogger()) do
                    @test Perth.check_update(buf2) isa Union{VersionNumber,Nothing}
                end
                @test isempty(take!(buf2))
            end
        end
    end
end
