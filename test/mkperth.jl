# A ponte com o MK Perth: só roda onde o mkperth-cli está instalado (no PATH
# ou em ENV["MKPERTH_CLI"]); sem ele, o testset diz que pulou.
@testset "ponte com o MK Perth" begin
    withenv("MKPERTH_CLI" => "/nao/existe/mkperth-cli") do
        @test mkperth_cli() === nothing
        @test_throws ErrorException schedule_p6(create_project("Sem MK Perth"))
    end
    if mkperth_cli() === nothing
        @info "mkperth-cli não está instalado: a ponte com o MK Perth não é testada"
        @test_skip mkperth_cli() !== nothing
    else
        p = create_project("Ponte P6")
        a = add_task!(p, "Fundação"; start = Date(2026, 10, 12), duration = 12)
        b = add_task!(p, "Estrutura"; start = Date(2026, 10, 12), duration = 8, dependencies = [a.id])
        c = add_task!(p, "Cobertura"; start = Date(2026, 10, 30), duration = 3, dependencies = [a.id])
        d = add_task!(p, "Entrega"; start = Date(2026, 10, 12), duration = 1, milestone = true,
                      dependencies = [b.id, c.id])
        schedule!(p)

        # O MK Perth agenda igual ao Perth: as mesmas datas cedo, a mesma folga.
        # A Cobertura só pode começar em 30/10 e termina em 01/11, depois da
        # Estrutura (31/10): ela é que segura a Entrega; Fundação e Estrutura
        # têm um dia de folga.
        rows = schedule_p6(p)
        @test rows isa Vector{<:NamedTuple}
        folgas = slack(p)
        for t in p.tasks
            r = only(filter(r -> r.id == t.id, rows))
            f = only(filter(f -> f.id == t.id, folgas))
            @test r.early_start == t.start
            @test r.early_finish == end_date(p, t)
            @test r.total_float == f.slack_days
            @test r.critical == f.critical
        end
        @test only(filter(r -> r.id == c.id, rows)).longest_path
        # As opções do P6: um limiar de folga; pelo caminho mais longo.
        @test only(filter(r -> r.id == b.id, schedule_p6(p; threshold = 1))).critical
        @test !only(filter(r -> r.id == b.id, schedule_p6(p; critical = :longest_path))).critical
        @test_throws ArgumentError schedule_p6(p; float = :meio)
        @test_throws ArgumentError schedule_p6(p; critical = :nada)

        # Ida e volta pelo XML do P6.
        xml = joinpath(mktempdir(), "ponte.xml")
        @test export_p6xml(p, xml) == xml
        @test occursin("APIBusinessObjects", read(xml, String))
        q = import_p6xml(xml; name = "Ponte de volta")
        @test project("Ponte de volta").id == q.id
        @test q.calendar == ""
        @test [t.name for t in q.tasks] == [t.name for t in p.tasks]
        @test [t.duration for t in q.tasks if !t.milestone] == [t.duration for t in p.tasks if !t.milestone]
        @test [sort(t.dependencies) for t in q.tasks] == [sort(t.dependencies) for t in p.tasks]
        @test only(filter(t -> t.milestone, q.tasks)).name == "Entrega"
        schedule!(q)
        @test [t.start for t in q.tasks] == [t.start for t in p.tasks]
        @test_throws ArgumentError import_p6xml(joinpath(mktempdir(), "nada.xml"))
        # Um arquivo que não é P6: o erro do MK Perth chega como erro do Perth.
        lixo = joinpath(mktempdir(), "lixo.xml")
        write(lixo, "<isto não é P6")
        @test_throws ErrorException import_p6xml(lixo)
    end
end
