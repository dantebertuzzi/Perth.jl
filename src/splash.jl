# splash.jl — Perth startup TUI (v2)
#
# Usage: `include("splash.jl")` inside the Perth module (or paste into src/).
# No external dependencies: just ANSI + Base + REPL.
#
# What's new in v2:
#   • anti-aliased raster (3×3 supersampling) — smooth capsule edges
#   • intro: the bars grow in a staircase with easing (ease-out quintic),
#     each starting as a dot that extends — the gesture of drawing a Gantt
#   • a specular sheen sweeps the mark at the end, instead of a hard crest
#   • steps show an animated braille spinner while work runs, then a final
#     line with a dotted leader aligning the elapsed time to the right
#   • `ready` panel with brand-colored accents and a clickable URL (OSC 8)
#   • "perth" wordmark tinted along the Julia color wheel
#
# Disable: ENV["PERTH_SPLASH"] = "0"   |  force: ENV["PERTH_SPLASH"] = "always"
# Light terminals: ENV["PERTH_SPLASH_LIGHT"] = "1" (anti-aliasing fades edges
# toward the background; the default assumes a dark background).

using Printf
using Logging
using REPL          # raw terminal mode, so `logo()` can stop on any keypress

# ────────────────────────────────────────────────────────── environment ──

_isatty(io) = try isa(io, Base.TTY) catch; false end

function _fancy(io::IO = stdout)
    v = get(ENV, "PERTH_SPLASH", "")
    v == "0"      && return false
    v == "always" && return true
    get(ENV, "CI", "false") == "true" && return false
    _isatty(io) && get(io, :color, false)
end

_truecolor() = get(ENV, "COLORTERM", "") in ("truecolor", "24bit")
_cols(io::IO = stdout) = try displaysize(io)[2] catch; 80 end

_q256(x) = round(Int, Int(x) / 255 * 5)
_cube(r, g, b) = 16 + 36_q256(r) + 6_q256(g) + _q256(b)

_fg(r, g, b) = _truecolor() ? "\e[38;2;$(Int(r));$(Int(g));$(Int(b))m" :
                              "\e[38;5;$(_cube(r, g, b))m"
_bg(r, g, b) = _truecolor() ? "\e[48;2;$(Int(r));$(Int(g));$(Int(b))m" :
                              "\e[48;5;$(_cube(r, g, b))m"

const _RESET = "\e[0m"
const _DIM   = "\e[2m"
const _BOLD  = "\e[1m"
const _GREY  = "\e[90m"

# Background assumed by the anti-aliasing: partial edges are blended toward
# this color. Dark backgrounds are the de facto default in dev terminals.
_bgbase() = get(ENV, "PERTH_SPLASH_LIGHT", "0") == "1" ? (255, 255, 255) : (0, 0, 0)

_mix(a, b, t) = ntuple(i -> round(Int, a[i] + (b[i] - a[i]) * t), 3)
_fade(c, a)   = _mix(_bgbase(), c, a)          # partial coverage → dim it

# ───────────────────────────────────────────────────────── color wheel ──
# The four Julia logo colors in HSV, ordered by hue. In this order they close
# the wheel without a reversal, so interpolating H monotonically never passes
# through the muddy tones that RGB interpolation would produce.
const _HSV_STOPS = ((  3.5, 0.749, 0.796),   # red    #CB3C33
                    (110.5, 0.750, 0.596),   # green  #389826
                    (226.2, 0.704, 0.847),   # blue   #4063D8
                    (280.7, 0.506, 0.698))   # purple #9558B2

function _hsv2rgb(h, s, v)
    h = mod(float(h), 360.0)
    c = v * s
    x = c * (1 - abs(mod(h / 60, 2) - 1))
    m = v - c
    r, g, b = h <  60 ? (c, x, 0.0) :
              h < 120 ? (x, c, 0.0) :
              h < 180 ? (0.0, c, x) :
              h < 240 ? (0.0, x, c) :
              h < 300 ? (x, 0.0, c) : (c, 0.0, x)
    (round(Int, (r + m) * 255), round(Int, (g + m) * 255), round(Int, (b + m) * 255))
end

"""Cyclic gradient: `_hue(t)` and `_hue(t + 1)` yield exactly the same color."""
function _hue(t::Real)
    n = length(_HSV_STOPS)
    x = mod(float(t), 1.0) * n
    i = floor(Int, x)
    f = x - i
    a = _HSV_STOPS[mod(i, n) + 1]
    b = _HSV_STOPS[mod(i + 1, n) + 1]
    hb = b[1] < a[1] ? b[1] + 360 : b[1]
    _hsv2rgb(a[1] + f * (hb - a[1]), a[2] + f * (b[2] - a[2]), a[3] + f * (b[3] - a[3]))
end

# ──────────────────────────────────────────────────────────────── mark ──
# Three staircased capsules — the Gantt motif of the Perth logo.
# Normalized coordinates: (x_start, x_end, y_center, color).
const _BARS = ((0.010, 0.617, 0.175, (0x38, 0x98, 0x26)),
               (0.187, 1.000, 0.500, (0xCB, 0x3C, 0x33)),
               (0.428, 0.995, 0.815, (0x40, 0x63, 0xD8)))
const _BAR_HALF   = 0.145        # bar half-height, as a fraction of the canvas
const _MARK_RATIO = 0.845        # height / width of the original artwork

_mark_height(w::Int) = (h = round(Int, _MARK_RATIO * w); h + isodd(h))
_mark_width(io::IO = stdout) = clamp(_cols(io) - 6, 16, 34)

"""
    _raster(w; lens, alphas) -> (idx, cov)

Rasterizes the mark onto a grid of `w` columns, anti-aliased by 3×3
supersampling. Each pixel is half a text cell tall, which keeps it nearly
square. Returns two matrices: `idx` with the dominant bar index (1–3,
0 = empty) and `cov` with the pixel's coverage in [0, 1].

`lens[i] ∈ [0, 1]` shortens capsule `i` (growth animation): at length ~0 the
capsule degenerates into a circle at its starting point, which then extends —
rounded caps for free, with no special glyphs. `alphas[i]` scales coverage
(fade-in).
"""
function _raster(w::Int; lens = (1.0, 1.0, 1.0), alphas = (1.0, 1.0, 1.0))
    h   = _mark_height(w)
    idx = zeros(Int8, h, w)
    cov = zeros(Float32, h, w)
    r   = _BAR_HALF * h
    SS  = 3
    for (bi, (x0, x1, cy, _)) in enumerate(_BARS)
        a = clamp(alphas[bi], 0, 1)
        L = clamp(lens[bi], 0, 1)
        (a <= 0 || L <= 0) && continue
        x1a = x0 + (x1 - x0) * L
        px0 = x0  * (w - 1) + 1
        px1 = x1a * (w - 1) + 1
        pcy = cy  * (h - 1) + 1
        lo, hi = px0 + r, px1 - r
        ylo = max(1, floor(Int, pcy - r)); yhi = min(h, ceil(Int, pcy + r))
        xlo = max(1, floor(Int, px0 - r)); xhi = min(w, ceil(Int, px1 + r))
        for yy in ylo:yhi, xx in xlo:xhi
            hits = 0
            for sy in 0:SS-1, sx in 0:SS-1
                X = xx - 0.5 + (sx + 0.5) / SS
                Y = yy - 0.5 + (sy + 0.5) / SS
                cx = hi >= lo ? clamp(X, lo, hi) : (lo + hi) / 2
                hypot(X - cx, Y - pcy) <= r && (hits += 1)
            end
            hits == 0 && continue
            av = Float32(hits / (SS * SS) * a)
            if av > cov[yy, xx]
                cov[yy, xx] = av
                idx[yy, xx] = Int8(bi)
            end
        end
    end
    idx, cov
end

# ────────────────────────────────────────────────────────────── painting ──
# `color(bar, xn, yn)` returns the RGB for a pixel; xn, yn ∈ [0, 1].

_brandc(bi, xn, yn) = _BARS[bi][4]

"""Running gradient: keys off horizontal position, ignoring the bar."""
_flowc(phase::Real, span::Real) = (bi, xn, yn) -> _hue(span * xn + phase)

"""Specular sheen: a white gaussian diagonal band centered at `p`."""
_sheenc(base::Function, p::Real; σ = 0.16, tilt = 0.45) =
    (bi, xn, yn) -> begin
        g = exp(-(((xn + tilt * yn) - p) / σ)^2)
        _mix(base(bi, xn, yn), (255, 255, 255), 0.9 * g)
    end

"""
    _paint(io, idx, cov, color)

Draws the raster with half-blocks (▀ ▄ █), fading partial edges toward the
background (anti-aliasing). Leaves the cursor at the end of the block's last
line, with no trailing newline.
"""
function _paint(io::IO, idx::Matrix{Int8}, cov::Matrix{Float32}, color::Function)
    H, W  = size(idx)
    nrows = H ÷ 2
    ε     = 0.02f0
    for (ri, y) in enumerate(1:2:H)
        buf  = IOBuffer()
        last = ""
        for x in 1:W
            aT = cov[y, x]
            aB = y + 1 <= H ? cov[y + 1, x] : 0.0f0
            if aT < ε && aB < ε
                last != "" && (print(buf, _RESET); last = "")
                print(buf, ' ')
                continue
            end
            xn = (x - 1) / max(W - 1, 1)
            cT = aT >= ε ? _fade(color(Int(idx[y, x]),     xn, (y - 1) / (H - 1)), aT) : nothing
            cB = aB >= ε ? _fade(color(Int(idx[y + 1, x]), xn,  y      / (H - 1)), aB) : nothing
            code, ch = if cT !== nothing && cB !== nothing
                cT == cB ? (_fg(cT...), '█') : (_fg(cT...) * _bg(cB...), '▀')
            elseif cT !== nothing
                (_fg(cT...), '▀')
            else
                (_fg(cB...), '▄')
            end
            code != last && (print(buf, _RESET, code); last = code)
            print(buf, ch)
        end
        print(io, "  ", String(take!(buf)), _RESET, "\e[K")
        ri < nrows && println(io)
    end
    flush(io)
end

# ──────────────────────────────────────────────────────────── animations ──

_easeq(t) = (u = clamp(t, 0, 1); 1 - (1 - u)^5)     # ease-out quintic

"""
    _animate_mark(io, w; fps = 36)

Intro timeline, phased off the wall clock (a dropped frame doesn't change the
pacing):
1. the three capsules grow in a staircase (ease-out quintic + short fade-in);
2. a specular sheen sweeps the mark once;
3. a static final frame in the brand colors.
"""
function _animate_mark(io::IO, w::Int; fps = 36)
    idxF, covF = _raster(w)
    nrows      = size(idxF, 1) ÷ 2
    stag, dur, fade = 0.13, 0.50, 0.22
    total = stag * (length(_BARS) - 1) + dur
    first = true
    frame(colorfn, idx, cov) = begin
        first || print(io, "\e[$(nrows - 1)F")
        first = false
        _paint(io, idx, cov, colorfn)
    end
    print(io, "\e[?25l")
    try
        t0 = time()
        while (t = time() - t0) < total
            lens = ntuple(bi -> _easeq((t - stag * (bi - 1)) / dur), 3)
            al   = ntuple(bi -> clamp((t - stag * (bi - 1)) / fade, 0, 1), 3)
            frame(_brandc, _raster(w; lens = lens, alphas = al)...)
            sleep(1 / fps)
        end
        sdur = 0.55
        ts   = time()
        while (t = time() - ts) < sdur
            p = -0.25 + 1.6 * (t / sdur)
            frame(_sheenc(_brandc, p), idxF, covF)
            sleep(1 / fps)
        end
        frame(_brandc, idxF, covF)
        println(io)
    finally
        print(io, "\e[?25h", _RESET)
    end
end

"""
    _flow(io = stdout; duration=1.2, fps=30, span=0.7, cycles=1, width=nothing)

Draws the mark and runs the gradient across it for a fixed duration.
"""
function _flow(io::IO = stdout; duration = 1.2, fps = 30, span = 0.7,
              cycles = 1, width = nothing)
    _fancy(io) || return nothing
    idx, cov = _raster(something(width, _mark_width(io)))
    nrows    = size(idx, 1) ÷ 2
    nframes  = max(round(Int, duration * fps), 1)
    first    = true
    print(io, "\e[?25l")
    try
        for f in 0:nframes
            first || print(io, "\e[$(nrows - 1)F")
            first = false
            _paint(io, idx, cov, _flowc(cycles * f / nframes, span))
            sleep(1 / fps)
        end
        println(io)
    finally
        print(io, "\e[?25h", _RESET)
    end
    nothing
end

"""
    logo(io = stdout; fps=30, span=0.7, speed=0.25, width=nothing)

Runs the gradient indefinitely until any key is pressed (including Ctrl-C,
which in raw mode arrives as a byte rather than a signal).

`speed` is in turns per second: 0.25 completes the color wheel every 4 s. The
phase comes from the clock, not the frame count, so a dropped frame delays the
image but not the speed.
"""
function logo(io::IO = stdout; fps = 30, span = 0.7, speed = 0.25, width = nothing)
    _fancy(io) || return nothing
    idx, cov = _raster(something(width, _mark_width(io)))
    nrows    = size(idx, 1) ÷ 2
    term = REPL.Terminals.TTYTerminal(get(ENV, "TERM", "xterm"), stdin, io, stderr)
    raw  = false
    first = true
    print(io, "\e[?25l")
    try
        raw = REPL.Terminals.raw!(term, true)
        Base.start_reading(stdin)
        t0 = time()
        while bytesavailable(stdin) == 0
            first || print(io, "\e[$(nrows - 1)F")
            first = false
            _paint(io, idx, cov, _flowc(speed * (time() - t0), span))
            sleep(1 / fps)
        end
        read(stdin, 1)
        println(io)
    finally
        Base.stop_reading(stdin)
        raw && REPL.Terminals.raw!(term, false)
        print(io, "\e[?25h", _RESET)
    end
    nothing
end

# ───────────────────────────────────────────────────────────────── steps ──

const _SPIN = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
const _LEAD = 40                 # target column for the dotted leader

"""
    _step(io, label, work)

Shows `label` with an animated braille spinner while `work()` runs (the
spinner lives in its own task; the work stays on the current one). On success
the line is rewritten with a green ✓, a dotted leader and the elapsed time —
on failure with a red ✗, then the exception propagates. Returns whatever
`work()` returned.
"""
function _step(io::IO, label::AbstractString, work::Function)
    _fancy(io) || return work()

    done = Ref(false)
    spinner = @async try
        i = 0
        while !done[]
            c = _hue(0.22 * time())          # slow drift along the color wheel
            print(io, "\r  ", _fg(c...), _SPIN[i % length(_SPIN) + 1], _RESET,
                      "  ", _DIM, label, _RESET, "\e[K")
            flush(io)
            sleep(0.08)
            i += 1
        end
    catch
    end

    t0 = time_ns()
    local res
    try
        res = work()
    catch
        done[] = true; wait(spinner)
        print(io, "\r  ", _fg(0xCB, 0x3C, 0x33), _BOLD, "✗", _RESET,
                  "  ", label, "\e[K\n")
        flush(io)
        rethrow()
    end
    done[] = true; wait(spinner)

    dt   = (time_ns() - t0) / 1e6
    lead = "·"^max(2, _LEAD - textwidth(label))
    tstr = dt >= 1000 ? @sprintf("%.2f s", dt / 1000) : @sprintf("%.0f ms", dt)
    print(io, "\r  ", _fg(0x38, 0x98, 0x26), "✓", _RESET, "  ", label, " ",
              _DIM, lead, _RESET, " ", _GREY, tstr, _RESET, "\e[K\n")
    flush(io)
    res
end

"""Enables the `_step(io, label) do ... end` form (`do` passes the function first)."""
_step(work::Function, io::IO, label::AbstractString) = _step(io, label, work)

# ───────────────────────────────────────────────────────────────── panel ──

"""Clickable hyperlink (OSC 8) where supported; plain text everywhere else."""
_link(url::AbstractString) = "\e]8;;$url\e\\" * url * "\e]8;;\e\\"

# rows: vector of (accent_rgb, key, rendered_value, visible_width_of_value)
function _box(io::IO, title::AbstractString, rows::Vector)
    lw    = maximum(textwidth(r[2]) for r in rows)
    cw(r) = 2 + lw + 2 + r[4]                    # "● " ∘ key ∘ "  " ∘ value
    w     = max(maximum(cw, rows), textwidth(title) + 6)
    inner = w + 4
    fill_ = inner - textwidth(title) - 3

    println(io, "  ", _DIM, "╭─ ", _RESET,
                _fg(0x95, 0x58, 0xB2), _BOLD, title, _RESET,
                _DIM, " ", "─"^max(fill_, 0), "╮", _RESET)
    for r in rows
        (accent, k, v, _) = r
        pad = w - cw(r)
        println(io, "  ", _DIM, "│", _RESET, "  ",
                    _fg(accent...), "●", _RESET, " ",
                    _DIM, rpad(k, lw), _RESET, "  ",
                    v, " "^pad, "  ",
                    _DIM, "│", _RESET)
    end
    println(io, "  ", _DIM, "╰", "─"^inner, "╯", _RESET)
end

# ───────────────────────────────────────────────────────── quiet logger ──

struct _MinLevel{L<:AbstractLogger} <: AbstractLogger
    parent::L
    min::Logging.LogLevel
end
Logging.min_enabled_level(l::_MinLevel) = max(Logging.min_enabled_level(l.parent), l.min)
Logging.shouldlog(l::_MinLevel, lvl, _module, group, id) =
    lvl >= l.min && Logging.shouldlog(l.parent, lvl, _module, group, id)
Logging.handle_message(l::_MinLevel, args...; kwargs...) =
    Logging.handle_message(l.parent, args...; kwargs...)
Logging.catch_exceptions(l::_MinLevel) = Logging.catch_exceptions(l.parent)

"""Runs `f` swallowing `@info`/`@debug` (from HTTP/Genie) while keeping warnings."""
_quiet(f::Function) = Logging.with_logger(f, _MinLevel(Logging.current_logger(), Logging.Warn))

# ───────────────────────────────────────────────────────────────── facade ──

function _wordmark(io::IO; version, subtitle)
    word = "perth"
    n    = length(word)
    buf  = IOBuffer()
    for (i, c) in enumerate(word)
        col = _hue(0.02 + 0.75 * (i - 1) / (n - 1))
        print(buf, _fg(col...), _BOLD, c, _RESET, i < n ? " " : "")
    end
    println(io, "  ", String(take!(buf)), "   ",
                _GREY, subtitle, _RESET, "  ", _DIM, "v", version, _RESET, "\n")
end

"""
    splash(io = stdout; version, subtitle, animate=1.2, width=nothing)

Intro animation: the capsules grow in a staircase, a sheen sweeps the mark,
and the gradient wordmark closes the block. `animate <= 0` skips the animation
and draws the final frame directly. No-op outside a TTY.
"""
function splash(io::IO = stdout; version = "0.2.1",
                subtitle = "Julia-native Gantt · Kanban · CPM",
                animate = 1.2, width = nothing)
    _fancy(io) || return nothing
    w = something(width, _mark_width(io))
    if animate > 0
        _animate_mark(io, w)
    else
        print(io, "\e[?25l")
        try
            _paint(io, _raster(w)..., _brandc)
            println(io)
        finally
            print(io, "\e[?25h", _RESET)
        end
    end
    _wordmark(io; version = version, subtitle = subtitle)
    nothing
end

"""
    _ready(io = stdout; url, projects, dir, threads, network, notes, tail)

Final panel, printed once the server is up. The URL is clickable in terminals
that support OSC 8.

`network` adds extra URL rows to the box (LAN share links), `notes` prints dim
lines under it (tips, security warnings), and `tail(io)` is a callback for
arbitrary output — a QR code, say — placed just before the footer. Outside a
TTY everything degrades to `@info`, warnings included.
"""
function _ready(io::IO = stdout; url::AbstractString, projects::Integer,
               dir::AbstractString, threads::Integer = Threads.nthreads(),
               network::AbstractVector{<:AbstractString} = String[],
               notes::AbstractVector{<:AbstractString} = String[],
               tail::Union{Nothing,Function} = nothing)
    if !_fancy(io)
        @info "Perth running at $url — Perth.stop() to shut down." projects dir
        for u in network
            @info "Perth on your network: $u"
        end
        for n in notes
            @info n
        end
        return nothing
    end
    pstr = string(projects, " in ", replace(dir, homedir() => "~"))
    tstr = string(threads)
    rows = Any[((0x38, 0x98, 0x26), "ui",       _BOLD * _link(url) * _RESET, textwidth(url)),
               ((0xCB, 0x3C, 0x33), "projects", _BOLD * pstr       * _RESET, textwidth(pstr)),
               ((0x40, 0x63, 0xD8), "threads",  _BOLD * tstr       * _RESET, textwidth(tstr))]
    for u in network
        push!(rows, ((0x95, 0x58, 0xB2), "network", _link(u), textwidth(u)))
    end
    println(io)
    _box(io, "perth", rows)
    for n in notes
        println(io, "     ", _DIM, n, _RESET)
    end
    tail === nothing || tail(io)
    println(io, "     ", _GREY, "Perth.stop()", _RESET, _DIM, " to shut down", _RESET, "\n")
    nothing
end

# ──────────────────────────────────────────────── dica de entrada (using) ──
#
# `using Perth` não dizia o que fazer em seguida: o pacote exporta a API de
# dados, mas quem abre a interface é Perth.run() / Perth.kanban(), que não são
# exportados (run colidiria com Base.run). A dica cobre esse vão.
#
# É só texto, nunca pergunta nada. Menu interativo no __init__ seria uma
# armadilha: `using Perth` também roda em script, em teste, dentro de outro
# pacote e na precompilação — em qualquer um deles um prompt trava o processo
# sem saída. Quem quiser escolher pelo teclado chama Perth.menu().

"""
    Perth._hint(io = stdout; version)

Static form of the entry-point pointer: the three doors, one per line, no
selection. This is what stays on screen after the picker is dismissed, and
what non-interactive callers get. Obeys `PERTH_SPLASH` like the rest of the
decoration: `0` silences it.
"""
function _hint(io::IO = stdout; version = _version())
    _fancy(io) || return nothing
    print(io, join(_bloco(version, 0), "\n"), "\n")
    nothing
end

_version() = try string(pkgversion(@__MODULE__)) catch; "" end

# As duas portas de entrada. Ordem = ordem na tela.
const _PORTAS = (("Perth.run()",    "open the Gantt in your browser"),
                 ("Perth.kanban()", "open the Kanban board"))
# A terceira linha difere entre as formas: no navegável é a saída; no estático
# é como trazer o navegável de volta, porque quem dispensou precisa saber.
const _SAIDA  = ("nothing, thanks", "")
const _VOLTAR = ("Perth.menu()",    "pick one from a list")

# `sel` = 0 devolve a forma estática (marcadores, sem legenda); 1..3 devolve a
# forma navegável, com a seta na linha escolhida. As duas têm que caber no
# mesmo repintar, por isso são o mesmo construtor.
function _bloco(version::AbstractString, sel::Int)
    w = maximum(textwidth(p[1]) for p in (_PORTAS..., _SAIDA, _VOLTAR))
    cab = string("  ", _fg(0x95, 0x58, 0xB2), _BOLD, "perth", _RESET,
                 "  ", _GREY, "Julia-native Gantt · Kanban · CPM", _RESET,
                 "  ", _DIM, "v", version, _RESET)
    if sel == 0
        linhas = [cab]
        for (chamada, texto) in (_PORTAS..., _VOLTAR)
            push!(linhas, string("   ", _DIM, "·", _RESET, " ",
                                 _BOLD, rpad(chamada, w), _RESET, "  ",
                                 _GREY, texto, _RESET))
        end
        return linhas
    end
    linhas = [cab, ""]
    for (i, (chamada, texto)) in enumerate((_PORTAS..., _SAIDA))
        marca = i == sel ? string(_fg(0x38, 0x98, 0x26), "→", _RESET) : " "
        corpo = i == sel ? string(_BOLD, rpad(chamada, w), _RESET) :
                           string(_DIM, rpad(chamada, w), _RESET)
        push!(linhas, string(" ", marca, " ", corpo, "  ", _GREY, texto, _RESET))
    end
    push!(linhas, "")
    push!(linhas, string("   ", _DIM,
                         "↑↓ move · enter opens · any other key dismisses",
                         _RESET))
    return linhas
end

"""
    Perth._pick(io = stdout; version, timeout = 6)

The pointer, navigable: arrows (or `j`/`k`) move, Enter opens the selected
door, any other key dismisses. **Gives up on its own** after `timeout` seconds
without a keypress, leaving [`Perth._hint`](@ref) on screen.

That timeout is the whole point. This runs from `__init__`, and `using Perth`
also happens inside `julia -i script.jl`, inside `include("script.jl")` and
inside any package that depends on this one — a prompt that waits forever
would hang all of those with no way out. Waiting a few seconds and stepping
aside costs nothing to whoever was not looking.
"""
function _pick(io::IO = stdout; version = _version(), timeout::Real = 6)
    _fancy(io) || return nothing
    # sem terminal de onde ler tecla, o navegável não faz sentido
    _isatty(stdin) || return _hint(io; version)

    term  = REPL.Terminals.TTYTerminal(get(ENV, "TERM", "xterm"), stdin, io, stderr)
    sel, escolha, raw = 1, 0, false
    linhas = length(_bloco(version, sel))
    print(io, "\e[?25l")
    try
        raw = REPL.Terminals.raw!(term, true)
        if !raw
            print(io, "\e[?25h")
            return _hint(io; version)         # sem modo raw não há seta
        end
        Base.start_reading(stdin)
        print(io, join(_bloco(version, sel), "\n"), "\n")
        t0 = time()
        while true
            if bytesavailable(stdin) > 0
                b = read(stdin, UInt8)
                mexeu = true
                if b == 0x1b && bytesavailable(stdin) >= 2
                    read(stdin, UInt8)                       # '['
                    c = read(stdin, UInt8)
                    c == UInt8('A') && (sel = max(1, sel - 1))
                    c == UInt8('B') && (sel = min(length(_PORTAS) + 1, sel + 1))
                elseif b == 0x0d || b == 0x0a
                    escolha = sel
                    break
                elseif b == UInt8('k')
                    sel = max(1, sel - 1)
                elseif b == UInt8('j')
                    sel = min(length(_PORTAS) + 1, sel + 1)
                else
                    break                                    # dispensa
                end
                mexeu && print(io, "\e[$(linhas)F\e[J")
                print(io, join(_bloco(version, sel), "\n"), "\n")
                t0 = time()                                  # tecla reinicia a contagem
            end
            time() - t0 >= timeout && break
            sleep(0.03)
        end
    catch
        escolha = 0                            # terminal estranho: só o texto
    finally
        Base.stop_reading(stdin)
        raw && REPL.Terminals.raw!(term, false)
        print(io, "\e[?25h", _RESET)
    end
    # o que fica na tela é a dica estática, sem seta nem legenda
    print(io, "\e[$(linhas)F\e[J")
    print(io, join(_bloco(version, 0), "\n"), "\n")
    escolha == 1 && return run()
    escolha == 2 && return kanban()
    nothing
end

"""
    Perth.menu()

Interactive picker for the entry points: arrow keys to move, Enter to run,
`q` to leave. Needs an interactive terminal — elsewhere it prints the same
list as [`Perth._hint`](@ref) and returns, rather than blocking on input.
"""
function menu(io::IO = stdout)
    if !(isinteractive() && _isatty(io))
        _hint(io)
        return nothing
    end
    opcoes = ["Gantt — projects, dependencies, critical path",
              "Kanban — cards on a shared board",
              "List the projects already saved",
              "Nothing, thanks"]
    escolha = REPL.TerminalMenus.request(
        "Perth — what do you want to open?",
        REPL.TerminalMenus.RadioMenu(opcoes; charset = :unicode))
    escolha == 1 && return run()
    escolha == 2 && return kanban()
    if escolha == 3
        ps = projects()
        isempty(ps) && return println(io, "  ", _DIM,
            "no projects yet — create_project(\"name\") starts one", _RESET)
        return ps
    end
    nothing                      # 4 ou cancelado (request devolve -1)
end
