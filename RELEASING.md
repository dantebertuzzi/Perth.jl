# Como se solta uma versão do Perth.jl

O processo que este repositório já segue desde a 0.10.0, escrito para não
ser redescoberto a cada vez. Vale para quem mantém e para qualquer agente
que trabalhe aqui: **siga isto, não improvise um caminho novo.**

A ordem importa. Registrar é público e definitivo — uma versão que entrou
no General não sai. Tudo o que dá para conferir se confere *antes* do
comentário do Registrator.

## 0. Antes de tudo: as duas suítes verdes

```bash
julia --project=. -e 'using Pkg; Pkg.test()'   # a suíte de Julia
cd test/frontend && node run.js                 # jsdom; sai != 0 em falha
```

Nada segue com teste vermelho. Se a mudança é de tela, escreva a checagem
no `test/frontend/run.js` — é ela que o CI roda no workflow `Frontend.yml`.

## 1. Um branch `release/X.Y.Z`

```bash
git switch -c release/0.15.0
```

O trabalho da versão e o "Set version" vivem no MESMO branch, e entram no
`main` por um único PR (com merge commit, nunca squash — o histórico de
`git log --graph` mostra os dois lados de cada release e é assim que se lê
o que entrou em cada uma).

## 2. Que número: SemVer abaixo de 1.0

* **Patch** (`0.14.0` → `0.14.1`): correção que não muda o que a API
  promete.
* **Minor** (`0.14.0` → `0.15.0`): funcionalidade nova, função nova
  exportada, comportamento novo — mesmo sem quebrar nada. Abaixo de 1.0
  este é o degrau normal, e é ele que o `Pkg` trata como *breaking*: quem
  depende de `Perth = "0.14"` precisa abrir para `"0.15"`.
* **Major** só depois do 1.0.

Na dúvida entre patch e minor com função nova exportada: é minor.

## 3. Os commits do branch

Mensagem de commit em **português**, no estilo da casa (ver
`git log`): assunto curto em minúsculas com prefixo `feat:` / `fix:` /
`docs:`, e corpo que explica **por que**, não o que o diff já diz. Os
parágrafos que carregam a decisão levam uma frase-título em CAIXA ALTA.
Todo commit termina com:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

O `CHANGELOG.md` recebe a entrada sob `## [Unreleased]`, em **inglês** —
ele é para quem lê o pacote, e a divisão de idiomas do repositório é por
audiência (português no que é interno, inglês no que o usuário lê:
README, CHANGELOG, docstrings, textos de tela).

Item que sai do `ROADMAP.md` sai dele neste commit — o cabeçalho de lá
manda, e um roadmap que também lista o que já foi feito vira um segundo
changelog.

## 4. O commit do bump, sempre o último

Um commit só, chamado exatamente `Set version to X.Y.Z`, que muda **duas**
coisas e nada mais:

1. `Project.toml`: `version = "X.Y.Z"`.
2. `CHANGELOG.md`: `## [Unreleased]` vira `## [X.Y.Z] - AAAA-MM-DD` (a
   data de hoje, ISO).

Ele é o último porque é o commit que o PR e o Registrator vão apontar.

## 5. O PR

```bash
git push -u origin release/0.15.0
gh pr create --title "0.15.0 — <a manchete da versão>" --body "..."
```

Título: `X.Y.Z — <manchete>`, a manchete sendo a mesma ideia do assunto do
commit principal. Corpo em **português**, contando a versão como se conta
para quem vai usar: o problema, a decisão, o que ficou de fora e por quê,
e uma linha dizendo quantos testes rodaram. Termina com:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Merge com **merge commit**:

```bash
gh pr merge <n> --merge
```

## 6. Registrar — só depois do merge, e no commit de merge

O comentário vai no **commit de merge** dentro do `main` (não no PR, não
no branch, que deixa de existir):

```bash
git switch main && git pull
gh api repos/dantebertuzzi/Perth.jl/commits/$(git rev-parse HEAD)/comments \
  -f body="$(cat notas.md)"
```

O corpo do comentário começa com a linha do bot e traz as notas em
**inglês** (elas viram o corpo do release no GitHub, que é leitura de
usuário):

```
@JuliaRegistrator register

Release notes:

## Breaking changes

<o que quebrou — ou, quando nada quebrou: dizer que é breaking só no
sentido 0.x, em que um minor abaixo de 1.0 fecha o compat, e que quem
depende de "0.14" precisa abrir para "0.15">

## <manchete da versão>

<as mesmas ideias do CHANGELOG, em prosa>
```

A seção `## Breaking changes` vem primeiro **sempre**, inclusive quando a
resposta é "nada em substância" — é a primeira pergunta de quem depende do
pacote, e o silêncio não responde.

O Registrator responde no mesmo lugar com o link do PR em
`JuliaRegistries/General`. Se ele reclamar, o conserto é um commit novo no
`main` e um comentário novo — nunca editar o antigo.

## 7. O TagBot faz o resto — não faça por ele

Depois que o PR do General for mergeado, o `TagBot.yml` (já instalado)
cria a tag `vX.Y.Z` e o release no GitHub, com as notas do comentário.

**Não crie a tag na mão.** Uma tag manual antes da hora deixa o TagBot sem
o que fazer e o release sem as notas. Se o PR do General demorar, espere:
o TagBot roda em cima do evento, e o `workflow_dispatch` com `lookback`
existe justamente para recuperar o que passou batido.

## Resumo em uma tela

```
1. testes verdes (Julia + jsdom)
2. git switch -c release/X.Y.Z
3. commits do trabalho (pt-BR) + CHANGELOG sob [Unreleased] (en)
4. "Set version to X.Y.Z": Project.toml + [Unreleased] -> [X.Y.Z] - data
5. push, gh pr create "X.Y.Z — manchete", gh pr merge --merge
6. comentário "@JuliaRegistrator register" + notas no commit de MERGE
7. esperar o TagBot
```
