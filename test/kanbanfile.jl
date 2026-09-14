@testset "Kanban Julia interchange" begin
    item = KanbanChecklistItem(id = "i1", text = "review ✓", done = true)
    card = KanbanCard(id = "k1", text = "Unicode α", body = "line one\nline two",
        done = true, done_at = "2026-09-05 10:00", by = "Ana", at = "2026-09-01 09:00",
        assignee = "Bjørn", due = "2026-09-08", checklist = [item], project = "p1", task = "t1")
    archived = KanbanCard(id = "k2", text = "old", done = true,
        done_at = "2026-08-01 10:00", col = "Done", archived_at = "2026-08-02 10:00")
    board = KanbanBoard(name = "thesis", columns = [
        KanbanColumn(id = "c1", name = "Todo", cards = [card], wip = 3),
        KanbanColumn(id = "c2", name = "Done")], archive = [archived], auto_archive_days = 14)
    dir = mktempdir()
    path = Perth.kanban_save(joinpath(dir, "thesis"); board = board)
    src = read(path, String)
    parsed = parse_kanban(src)
    @test parsed == board
    Perth.save(parsed, path)
    @test read(path, String) == src
    @test !occursin("aliases", src) && !occursin("permissions", src)
    @test_throws ArgumentError parse_kanban("run(`echo bad`)")
    @test_throws ArgumentError parse_kanban(src * "\nKanbanBoard(name=\"x\")")
    @test_throws ArgumentError parse_kanban(replace(src, "format_version = 1" => "format_version = 2"))
    @test_throws ArgumentError parse_kanban(replace(src, "id = \"k2\"" => "id = \"k1\""))

    imported = kanban_load(path; name = "imported", switch = false)
    @test imported.name == "imported" && "imported" in kanban_boards()
    mirror = set_kanban_file_path!(dir; board = "imported")
    @test endswith(mirror, "imported.kanban.perth.jl") && isfile(mirror)
    @test haskey(Perth._kanban_links(Perth._kanban_state().data_dir), "imported")
    @test set_kanban_file_path!(nothing; board = "imported") == ""

    # Portable image bundle: content address, media type and hash survive.
    st = Perth._kanban_state()
    png = vcat(UInt8[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], Vector{UInt8}("asset-ok"))
    asset = bytes2hex(Perth.SHA.sha256(png)) * ".png"
    mkpath(Perth._asset_dir(st.data_dir))
    write(joinpath(Perth._asset_dir(st.data_dir), asset), png)
    withimage = KanbanBoard(name = "image", columns = [
        KanbanColumn(id = "c", name = "Todo", cards = [
            KanbanCard(id = "pic", text = "image", images = [asset]),
        ]),
    ])
    imagepath = kanban_save(joinpath(dir, "image"); board = withimage)
    @test read(joinpath(dir, "image.kanban.assets", asset)) == png
    @test kanban_load(imagepath; switch = false).columns[1].cards[1].images == [asset]
    write(joinpath(dir, "image.kanban.assets", asset), vcat(png, 0x00))
    @test_throws ArgumentError kanban_load(imagepath; name = "bad-image", switch = false)

    # External reload is transactional and retains machine-only policy.
    kanban_board!("imported")
    st = Perth._kanban_state()
    st.board["aliases"] = Dict{String, Any}("127.0.0.2" => "local")
    mirror = set_kanban_file_path!(dir)
    edited = replace(read(mirror, String), "Unicode α" => "edited outside")
    write(mirror, edited)
    @test Perth._kanban_reload_link!("imported", mirror, st.data_dir) == :reloaded
    @test kanban_cards()[1].text == "edited outside" && st.board["aliases"]["127.0.0.2"] == "local"
    valid = read(mirror, String)
    write(mirror, "run(`false`)")
    @test Perth._kanban_reload_link!("imported", mirror, st.data_dir) == :invalid
    @test kanban_cards()[1].text == "edited outside"
    write(mirror, valid)
    set_kanban_file_path!(nothing)
end

@testset "Kanban interchange regressions" begin
    previous = Perth.KANBAN[]
    data_dir, exports = mktempdir(), mktempdir()
    Perth._init_kanban!(data_dir)
    sample(text="original") = KanbanBoard(name="sample", columns=[
        KanbanColumn(id="todo", name="Todo", cards=[KanbanCard(id="card", text=text)])])
    try
        @testset "Validation and lossless conversion" begin
            for source in ("@eval 1", "Unknown()", "KanbanBoard(unknown=1)",
                           "KanbanBoard(columns=1)", "KanbanBoard(name=1)",
                           "["^33 * "]"^33, " "^(Perth._MAX_SOURCE_BYTES + 1))
                @test_throws ArgumentError parse_kanban(source)
            end
            for board in (
                KanbanBoard(columns=[KanbanColumn(id="c", name="Todo", wip=-1)]),
                KanbanBoard(columns=[KanbanColumn(id="c", name="Todo", cards=[
                    KanbanCard(id="x", text="x", images=["../image.png"])])]),
                KanbanBoard(columns=[KanbanColumn(id="c", name="Todo", cards=[
                    KanbanCard(id="x", text="x", assignee="x"^(Perth._TEXT_CAP + 1))])]),
                KanbanBoard(columns=[KanbanColumn(id="c", name="Todo", cards=[
                    KanbanCard(id="x", text="x", checklist=[
                        KanbanChecklistItem(id="i", text="a"), KanbanChecklistItem(id="i", text="b")])])]),
            )
                @test_throws ArgumentError Perth._kanban_dict(board)
            end
            item = KanbanChecklistItem(id="i", text="shared by copied cards")
            copied = KanbanBoard(columns=[KanbanColumn(id="c", name="Todo", cards=[
                KanbanCard(id="a", text="first", checklist=[item]),
                KanbanCard(id="b", text="copy", checklist=[item]),
            ])])
            @test Perth._kanban_snapshot(Perth._kanban_dict(copied), copied.name) == copied
            special = sample("quotes \" \\ \$name\nUnicode ✓")
            @test parse_kanban(Perth._to_julia_source(special)) == special
        end

        @testset "Active imports and local state" begin
            path = kanban_save(joinpath(exports, "import"); board=sample())
            kanban_load(path; name="board", switch=false)
            @test only(kanban_cards()).text == "original"
            st = Perth._kanban_state()
            st.board["aliases"] = Dict{String,Any}("local" => "host")
            st.board["permissions"] = Dict{String,Any}("remote" => Dict("edit" => false))
            oldlog, oldchat, revision = st.log, st.chat, st.rev
            Perth.save(sample("replacement"), path)
            kanban_load(path; name="board", switch=false)
            @test only(kanban_cards()).text == "replacement"
            @test st.rev == revision + 1
            @test st.board["aliases"]["local"] == "host"
            @test !st.board["permissions"]["remote"]["edit"]
            @test st.log === oldlog && st.chat === oldchat
            @test Perth._plain(JSON3.read(read(st.file, String))) == st.board

            mirror = set_kanban_file_path!(joinpath(exports, "live"))
            @test !("links" in kanban_boards())
            kanban_load(path; name="other", switch=false)
            @test_throws ArgumentError set_kanban_file_path!(mirror; board="other")
            # A pending event must not import after unlinking.
            set_kanban_file_path!(nothing)
            Perth.save(sample("stale event"), mirror)
            @test Perth._kanban_reload_link!("board", mirror, data_dir) == :unlinked
            @test only(kanban_cards()).text == "replacement"

            # "links" remains available as a real board name.
            kanban_load(path; name="links", switch=false)
            @test "links" in kanban_boards()
            @test read(joinpath(data_dir, "kanban-links.json"), String) !=
                  read(joinpath(data_dir, ".kanban-links.json"), String)
        end

        @testset "Watcher lifecycle" begin
            mirror = set_kanban_file_path!(joinpath(exports, "watched"); board="other")
            Perth.save(sample("external"), mirror)
            @test timedwait(() -> begin
                raw = Perth._plain(JSON3.read(read(joinpath(data_dir, "kanban-other.json"), String)))
                raw["columns"][1]["cards"][1]["text"] == "external"
            end, 8; pollint=0.05) == :ok
            @test Perth._kanban_state().name == "board"
            @test Perth._kanban_reload_link!("other", mirror, data_dir) == :same

            kanban_board!("other")
            @test only(kanban_cards()).text == "external"
            kanban_board!("board")
            @test kanban_delete_board!("other")
            @test isfile(mirror)
            @test Perth._kanban_reload_link!("other", mirror, data_dir) == :unlinked
            @test !isfile(joinpath(data_dir, "kanban-other.json"))

            mirror = set_kanban_file_path!(joinpath(exports, "restart"))
            # Simulate stopped watchers, edit offline, then restart.
            lock(Perth._KANBAN_LINK_LOCK) do
                empty!(Perth._KANBAN_LINK_WATCHERS)
            end
            Perth.save(sample("offline edit"), mirror)
            Perth._init_kanban!(data_dir)
            @test timedwait(() -> only(kanban_cards()).text == "offline edit", 8; pollint=0.05) == :ok

            # A same-named board in another directory is never a reload target.
            second = mktempdir()
            Perth._init_kanban!(second)
            @test Perth._kanban_reload_link!("board", mirror, data_dir) == :unlinked
            @test isempty(kanban_cards())
            Perth._init_kanban!(data_dir)
            set_kanban_file_path!(nothing)
        end

        @testset "Registry migration and corruption" begin
            legacy_dir = mktempdir()
            legacy = joinpath(legacy_dir, "kanban-links.json")
            source = joinpath(exports, "legacy.kanban.perth.jl")
            write(legacy, JSON3.write(Dict("board" => source)))
            @test Perth._kanban_links(legacy_dir) == Dict("board" => source)
            @test !isfile(legacy)
            @test isfile(joinpath(legacy_dir, ".kanban-links.json"))
            registry = joinpath(data_dir, ".kanban-links.json")
            valid = read(registry, String)
            write(registry, "{broken")
            @test_throws Exception set_kanban_file_path!(nothing)
            @test read(registry, String) == "{broken"
            write(registry, valid)
        end

        @testset "Inactive Gantt synchronization" begin
            project = create_project("Kanban mirror regression")
            task = add_task!(project, "Before")
            board = KanbanBoard(columns=[KanbanColumn(id="c", name="Todo", cards=[
                KanbanCard(id="linked", text="Before", project=project.id, task=task.id)])])
            source = kanban_save(joinpath(exports, "gantt"); board)
            kanban_load(source; name="gantt", switch=false)
            mirror = set_kanban_file_path!(source; board="gantt")
            update_task!(project, task.id; name="After")
            @test only(only(parse_kanban(read(mirror, String)).columns).cards).text == "After"
            @test Perth._kanban_state().name == "board"
            set_kanban_file_path!(nothing; board="gantt")
            delete_project(project.id)
        end

        @testset "Asset validation precedes board replacement" begin
            png = vcat(UInt8[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], UInt8[1, 2, 3, 4, 5, 6, 7, 8])
            name = bytes2hex(Perth.SHA.sha256(png)) * ".png"
            local_asset = joinpath(Perth._asset_dir(data_dir), name)
            mkpath(dirname(local_asset))
            write(local_asset, png)
            board = KanbanBoard(columns=[KanbanColumn(id="c", name="Todo")], archive=[
                KanbanCard(id="a", text="archived image", col="Todo", archived_at="2026-09-05", images=[name])])
            path = kanban_save(joinpath(exports, "assets"); board)
            bundle = Perth._kanban_bundle(path)
            write(joinpath(bundle, "unreferenced.txt"), "keep")
            write(local_asset, "damaged local cache")
            kanban_load(path; name="images", switch=false)
            @test read(local_asset) == png
            kanban_save(path; board)
            @test read(joinpath(bundle, "unreferenced.txt"), String) == "keep"
            before = read(joinpath(data_dir, "kanban-images.json"), String)
            for bytes in (UInt8[], vcat(png, 0x00), zeros(UInt8, Perth._ASSET_MAX_BYTES + 1))
                write(joinpath(bundle, name), bytes)
                @test_throws ArgumentError kanban_load(path; name="images", switch=false)
                @test read(joinpath(data_dir, "kanban-images.json"), String) == before
            end
            rm(joinpath(bundle, name))
            @test_throws ArgumentError kanban_load(path; name="images", switch=false)
            # Low-level save with a different filename still gets a sibling bundle.
            @test Perth._kanban_bundle(joinpath(exports, "custom.jl")) == joinpath(exports, "custom.jl.kanban.assets")
        end
    finally
        lock(Perth._KANBAN_LINK_LOCK) do
            empty!(Perth._KANBAN_LINK_WATCHERS)
        end
        Perth.KANBAN[] = previous
        previous === nothing || Perth._kanban_links_sync!(previous.data_dir)
    end
end


# Consertos aplicados ao PR #19 depois do merge. Ver o CHANGELOG de Unreleased.
@testset "kanban em arquivo: consertos pós-merge" begin
    @testset "ler não passa mais pelo parser do Julia" begin
        # Meta.parseall é recursivo e derruba o processo em vez de lançar: o
        # leitor de kanban repetia o furo que o de projeto já tinha fechado.
        fundo = "KanbanBoard(name=\"x\", columns=" * repeat("[", 5_000) *
                repeat("]", 5_000) * ")"
        @test_throws ArgumentError Perth.parse_kanban(fundo)
        # E o caso honesto continua fechando o ciclo.
        b = Perth.KanbanBoard(name="ida e volta", columns=[Perth.KanbanColumn(
            id="c1", name="A começar", cards=[
                Perth.KanbanCard(id="k1", text="acentuação — e (parênteses)"),
                Perth.KanbanCard(id="k2", text="#= não é comentário =#")])])
        @test Perth.parse_kanban(Perth._to_julia_source(b)) == b
    end

    @testset "exportar aceita o que o runtime produz" begin
        # O handler do WebSocket trunca texto e nunca o recusa vazio, e delCol
        # apaga a última coluna: exigir mais que isso congelava o espelho de um
        # board legítimo, em silêncio, com o watcher tentando de novo.
        col(cards...) = Dict{String,Any}("id" => "c1", "name" => "A",
                                         "cards" => Any[cards...])
        card(id, texto) = Dict{String,Any}("id" => id, "text" => texto,
                                           "done" => false)
        vazios = Dict(
            "card sem texto"      => Dict{String,Any}(
                "columns" => Any[col(card("k1", ""))], "archive" => Any[]),
            "board sem coluna"    => Dict{String,Any}(
                "columns" => Any[], "archive" => Any[]),
            "coluna sem nome"     => Dict{String,Any}(
                "columns" => Any[Dict{String,Any}("id" => "c1", "name" => "",
                                                  "cards" => Any[])],
                "archive" => Any[]),
        )
        for (nome, bruto) in vazios
            board = Perth._kanban_snapshot(bruto, "b")
            fonte = @test_nowarn Perth._to_julia_source(board)
            @test Perth.parse_kanban(fonte) == board   # $nome sobrevive à volta
        end
    end

    @testset "o que continua recusado" begin
        # Relaxar o vazio não é relaxar o que quebra a identificação do card.
        semid = Dict{String,Any}("columns" => Any[Dict{String,Any}(
            "id" => "c1", "name" => "A", "cards" => Any[Dict{String,Any}(
                "id" => "", "text" => "x", "done" => false)])],
            "archive" => Any[])
        @test_throws ArgumentError Perth._to_julia_source(
            Perth._kanban_snapshot(semid, "b"))
        repetido = Dict{String,Any}("columns" => Any[Dict{String,Any}(
            "id" => "c1", "name" => "A", "cards" => Any[
                Dict{String,Any}("id" => "k", "text" => "x", "done" => false),
                Dict{String,Any}("id" => "k", "text" => "y", "done" => false)])],
            "archive" => Any[])
        @test_throws ArgumentError Perth._to_julia_source(
            Perth._kanban_snapshot(repetido, "b"))
        # "\xff" é Julia válido e não é UTF-8: um card assim derrubava toda
        # conexão com o quadro, e um board recebido de outra pessoa não pode
        # fazer isso. É o leitor que recusa (ver _tokenize).
        @test_throws ArgumentError Perth.parse_kanban(
            "KanbanBoard(name=\"b\", columns=[KanbanColumn(id=\"c1\", name=\"A\", " *
            "cards=[KanbanCard(id=\"k1\", text=\"a\\xffb\")])])")
    end
end
