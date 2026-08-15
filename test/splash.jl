# test/splash.jl — testes do TUI de inicialização.
#
# Nada aqui depende de TTY nem imprime na saída do Pkg.test: o
# withenv("PERTH_SPLASH" => "always") força o caminho "fancy" mesmo escrevendo
# num IOBuffer, e nenhum teste usa `stdout`.

using Test, Logging

# Remove sequências ANSI (SGR, cursor) e os wrappers de hyperlink OSC 8,
# para medir a largura visível das linhas do painel.
# ESC e a barra final vão por código hex: em literais r"..." o Julia colapsa
# \\ numa barra só, e o PCRE rejeita padrão terminado em barra solta.
_nofx(s) = replace(String(s),
                   r"\x1b\]8;;[^\x1b]*\x1b\x5c" => "",
                   r"\x1b\[[0-9;?]*[a-zA-Z]" => "")

_forced(f) = withenv(f, "PERTH_SPLASH" => "always")

@testset "splash" begin

    # ── silencioso fora de TTY: é o modo do CI e dos pipes ──────────────
    # O withenv limpando PERTH_SPLASH não é cosmético: se a variável estiver
    # exportada como "always" no ambiente, `logo` entraria no laço esperando
    # uma tecla e a suíte TRAVARIA. Nunca chame logo() sem essa garantia.
    @testset "no-op sem TTY" begin
        withenv("PERTH_SPLASH" => nothing) do
            buf = IOBuffer()
            @test Perth.splash(buf) === nothing
            @test Perth._flow(buf) === nothing
            @test Perth.logo(buf) === nothing
            @test isempty(take!(buf))
        end
    end

    # ── geometria e anti-aliasing do raster ────────────────────────────
    @testset "raster" begin
        for w in (16, 20, 27, 34)
            idx, cov = Perth._raster(w)
            @test size(idx) == size(cov)
            @test size(idx, 2) == w
            @test iseven(size(idx, 1))                  # fecha em meios-blocos
            @test all(c -> 0 <= c <= 1, cov)
            @test any(c -> c > 0.99, cov)                # tem pixel cheio
            @test count(c -> 0 < c < 1, cov) > 0         # tem borda suavizada
            @test issubset(Set(idx), Set(Int8[0, 1, 2, 3]))
            @test all(b -> any(==(Int8(b)), idx), 1:3)   # as três barras aparecem
            @test all(iszero, cov[idx .== 0])            # índice 0 ⇔ cobertura 0
        end
    end

    @testset "crescimento e fade" begin
        _, c0 = Perth._raster(24; lens = (0.0, 0.0, 0.0))
        @test all(iszero, c0)                            # nada aceso no t=0

        _, chalf = Perth._raster(24; lens = (0.5, 0.0, 0.0))
        _, cfull = Perth._raster(24)
        @test 0 < sum(chalf) < sum(cfull)                # cresce monotonicamente

        # alpha uniforme escala a cobertura sem trocar o vencedor de cada pixel
        idim, cdim = Perth._raster(24; alphas = (0.5, 0.5, 0.5))
        ifull, _   = Perth._raster(24)
        @test idim == ifull
        @test sum(cdim) ≈ 0.5 * sum(cfull) rtol = 1e-4

        # comprimento ~0 degenera na cápsula redonda do ponto de partida
        _, cdot = Perth._raster(24; lens = (0.02, 0.0, 0.0))
        @test 0 < sum(cdot) < 0.25 * sum(cfull)
    end

    @testset "easing" begin
        @test Perth._easeq(0) == 0
        @test Perth._easeq(1) == 1
        @test Perth._easeq(-3) == 0 && Perth._easeq(3) == 1   # clampeado
        @test issorted([Perth._easeq(t) for t in 0:0.05:1])
        @test Perth._easeq(0.5) > 0.5                          # ease-OUT
    end

    @testset "roda de cores" begin
        # as quatro paradas caem exatamente nos hex da marca
        @test Perth._hue(0.00) == (0xCB, 0x3C, 0x33)
        @test Perth._hue(0.25) == (0x38, 0x98, 0x26)
        @test Perth._hue(0.50) == (0x40, 0x63, 0xD8)
        @test Perth._hue(0.75) == (0x95, 0x58, 0xB2)
        # cíclica: _hue(t) e _hue(t+1) são a mesma cor
        @test all(t -> Perth._hue(t) == Perth._hue(t + 1), 0:0.07:1)
        # sempre em faixa válida, sem tons barrentos (nunca cinza puro)
        for t in 0:0.01:1
            c = Perth._hue(t)
            @test all(v -> 0 <= v <= 255, c)
            @test maximum(c) - minimum(c) > 20
        end
    end

    @testset "paint" begin
        idx, cov = Perth._raster(20)
        buf = IOBuffer()
        Perth._paint(buf, idx, cov, Perth._brandc)
        s = String(take!(buf))
        @test occursin("\e[", s)                                  # emitiu ANSI
        @test any(ch -> occursin(ch, s), ('█', '▀', '▄'))
        @test count(==('\n'), s) == size(idx, 1) ÷ 2 - 1          # sem \n final
        # o sheen clareia: mais branco que o quadro base
        buf2 = IOBuffer()
        Perth._paint(buf2, idx, cov, Perth._sheenc(Perth._brandc, 0.5))
        @test length(String(take!(buf2))) != length(s)
    end

    @testset "splash forçado" begin
        _forced() do
            buf = IOBuffer()
            Perth.splash(buf; animate = 0, version = "9.9.9",
                         subtitle = "sub-teste", width = 20)
            s = String(take!(buf))
            @test occursin("9.9.9", s)
            @test occursin("sub-teste", s)
            @test occursin("\e[?25h", s)          # cursor sempre restaurado
        end
    end

    # ── etapas: valor de retorno, propagação de erro, marcas ✓/✗ ───────
    @testset "_step" begin
        @test Perth._step(devnull, "x", () -> 42) == 42
        r0 = Perth._step(devnull, "x") do
            7
        end
        @test r0 == 7
        @test_throws ErrorException Perth._step(devnull, "x", () -> error("boom"))

        _forced() do
            buf = IOBuffer()
            r = Perth._step(buf, "Fazendo algo") do
                sleep(0.05)
                :ok
            end
            s = String(take!(buf))
            @test r === :ok
            @test occursin("Fazendo algo", s)
            @test occursin("✓", s)
            @test occursin("ms", s) || occursin(" s", s)
            @test occursin("·", s)                # leader pontilhado

            buf = IOBuffer()
            @test_throws ErrorException Perth._step(buf, "Falha") do
                error("boom")
            end
            @test occursin("✗", String(take!(buf)))
        end
    end

    @testset "_quiet" begin
        # @info é engolido, @warn sobrevive
        @test Perth._quiet(() -> 1) == 1
        @test_logs Perth._quiet() do
            @info "não deve aparecer"
        end
        @test_logs (:warn, "deve aparecer") Perth._quiet() do
            @warn "deve aparecer"
        end
    end

    # ── painel final ───────────────────────────────────────────────────
    @testset "ready sem TTY" begin
        # degrada para @info — e os avisos de segurança sobrevivem
        with_logger(NullLogger()) do
            @test Perth._ready(devnull; url = "http://localhost:8123",
                              projects = 3, dir = homedir()) === nothing
        end
        @test_logs (:info,) (:info,) match_mode = :any begin
            Perth._ready(devnull; url = "http://localhost:8123", projects = 3,
                        dir = homedir(),
                        notes = ["Do not expose this port to the internet."])
        end
    end

    @testset "ready com TTY" begin
        _forced() do
            buf = IOBuffer()
            Perth._ready(buf; url = "http://localhost:8123", projects = 3,
                        dir = joinpath(homedir(), ".perth"), threads = 4,
                        network = ["http://192.168.0.9:8123?key=abc"],
                        notes = ["aviso um", "aviso dois"],
                        tail = io -> println(io, "QR-AQUI"))
            s = String(take!(buf))
            @test occursin("localhost:8123", s)
            @test occursin("192.168.0.9", s)
            # homedir abreviado; o separador é o da plataforma (~\.perth no Windows)
            @test occursin("3 in " * joinpath("~", ".perth"), s)
            @test occursin("aviso um", s) && occursin("aviso dois", s)
            @test occursin("QR-AQUI", s)                # tail antes do rodapé
            @test occursin("Perth.stop()", s)
            @test occursin("\e]8;;", s)                 # hyperlink OSC 8

            # ordem: caixa → notas → tail → rodapé
            @test findfirst("aviso um", s)[1] < findfirst("QR-AQUI", s)[1] <
                  findfirst("Perth.stop()", s)[1]

            # alinhamento: toda linha da moldura tem a mesma largura visível
            box = filter(l -> !isempty(l) && first(strip(l)) in ('╭', '│', '╰'),
                         split(_nofx(s), '\n'))
            @test length(box) == 6            # topo + 3 fixas + 1 network + base
            @test length(unique(textwidth.(box))) == 1
        end
    end

    # ── dica de entrada (o que aparece ao dar `using Perth`) ───────────
    #
    # O guarda de verdade (interativo? precompilando?) vive no __init__ e não
    # dá para exercitar daqui — o que dá, e é o que importa não regredir, é
    # que a dica nomeia as três portas de entrada e que ela cala junto com o
    # resto da decoração.
    @testset "dica de entrada" begin
        _forced() do
            buf = IOContext(IOBuffer(), :color => true)
            @test Perth._hint(buf; version = "9.9.9") === nothing
            txt = _nofx(String(take!(buf.io)))
            @test occursin("Perth.run()", txt)
            @test occursin("Perth.kanban()", txt)
            @test occursin("Perth.menu()", txt)
            @test occursin("9.9.9", txt)
            # três linhas de porta de entrada, uma de cabeçalho
            @test count(l -> occursin("Perth.", l), split(txt, "\n")) == 3
        end

        withenv("PERTH_SPLASH" => nothing) do
            buf = IOBuffer()
            @test Perth._hint(buf) === nothing
            @test isempty(take!(buf))
        end
    end

    # A promessa que sustenta ter isto no __init__: sem tecla, o navegável
    # desiste sozinho e devolve o controle. Se este teste travar a suíte, é
    # exatamente o que aconteceria com quem rodasse `julia -i script.jl`.
    @testset "o navegável desiste sozinho" begin
        _forced() do
            buf = IOContext(IOBuffer(), :color => true)
            t = @elapsed r = Perth._pick(buf; version = "9.9.9", timeout = 0.4)
            @test r === nothing
            @test t < 8                       # folga enorme: o alvo é 0,4s
            txt = _nofx(String(take!(buf.io)))
            @test occursin("Perth.run()", txt)
            # o que sobra na tela é a forma estática, sem legenda de teclas
            @test !occursin("enter opens", split(txt, "\n")[end - 1])
        end
    end

    # ── de quem é o teclado ──────────────────────────────────────────
    #
    # O seletor lê a entrada padrão. Se alguém já está ALIMENTANDO a sessão —
    # VS Code "executar arquivo no REPL", `julia -i` com pipe, include em
    # lote —, esses bytes são CÓDIGO, não tecla, e ler o primeiro os corrompe.
    # Aconteceu de verdade antes desta guarda: "using Perth" seguido de
    # println(...) chegava junto, o seletor engolia o "p" e o REPL recebia
    # "rintln(...)". Medido num pty: entrada ociosa dá 0 bytes pendentes,
    # entrada alimentada deu 22.
    @testset "de quem é o teclado" begin
        @test Perth._teclado_livre(0)          # ninguém alimentando: é gente
        @test !Perth._teclado_livre(1)         # já tem byte esperando
        @test !Perth._teclado_livre(22)        # o caso medido no pty
    end

    # menu() fora de sessão interativa não pode BLOQUEAR esperando tecla:
    # cai na dica e volta. Sem isto, um Pkg.test que o chamasse travaria.
    @testset "menu sem terminal" begin
        _forced() do
            buf = IOContext(IOBuffer(), :color => true)
            @test Perth.menu(buf) === nothing
            @test occursin("Perth.run()", _nofx(String(take!(buf.io))))
        end
    end

    # O acento do painel assume glifo de largura 1; se algum terminal
    # renderizar "●" como largura dupla, a moldura desalinha — troque por "•".
    @testset "largura dos glifos" begin
        @test textwidth("●") == 1
        @test all(g -> textwidth(g) == 1, ('█', '▀', '▄', '╭', '│', '╰', '·', '✓', '✗'))
        @test all(s -> textwidth(s) == 1, Perth._SPIN)
    end
end