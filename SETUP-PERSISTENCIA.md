# VIGOR — Correção da persistência do banco de dados

## O que foi mudado

O `server.js` usava `node:sqlite` (`DatabaseSync`) escrevendo em um arquivo local
(`./data/vigor.db`). No Render (plano free) e em qualquer host com disco
efêmero, esse arquivo é **apagado a cada deploy, restart ou spin-down** — por
isso você perdia os dados.

A correção troca o driver por **[Turso](https://turso.tech)** (banco libSQL —
100% compatível com SQLite, mesma sintaxe do seu `schema.sql`), que roda
remoto e **persiste de verdade**, com um plano gratuito sem expiração
(diferente do Postgres free do Render, que expira em 30 dias).

Principais mudanças:
- `node:sqlite` → `@libsql/client`
- Todas as ~120 chamadas ao banco viraram `async/await` (a lib do Turso é
  assíncrona por natureza — não existe SQLite remoto síncrono)
- O banco agora é configurado por variáveis de ambiente: `TURSO_DATABASE_URL`
  e `TURSO_AUTH_TOKEN`. **Sem essas variáveis, o servidor volta a usar o
  arquivo local** — ótimo para rodar `npm start` na sua máquina, mas continua
  efêmero no Render. É por isso que você precisa configurá-las lá.
- `schema.sql` **não precisou mudar nada** — libSQL fala a mesma linguagem do
  SQLite.

## Passo 1 — Criar o banco no Turso (grátis, ~3 minutos)

1. Crie uma conta em https://turso.tech (dá pra usar login do GitHub).
2. Instale a CLI ou use o painel web. Pelo painel web é mais simples:
   - Clique em **Create Database**.
   - Escolha um nome (ex: `vigor-db`) e a região mais próxima dos seus
     usuários.
3. Depois de criado, abra o banco e copie:
   - **Database URL** (algo como `libsql://vigor-db-seuuser.turso.io`)
   - Gere um **Auth Token** (botão "Create Token") e copie o valor.

## Passo 2 — Rodar o schema uma vez no banco novo

O próprio `server.js` já roda o `schema.sql` automaticamente no primeiro boot
(via `initDb()`), então **não precisa fazer nada manual aqui** — é só subir o
servidor com as variáveis configuradas (passo 3) que as tabelas são criadas
sozinhas.

## Passo 3 — Configurar as variáveis de ambiente no Render

No painel do seu serviço no Render:
1. Vá em **Environment**.
2. Adicione:
   - `TURSO_DATABASE_URL` = a URL copiada no passo 1
   - `TURSO_AUTH_TOKEN` = o token copiado no passo 1
3. Salve — o Render vai reimplantar automaticamente.

A partir daí, todo `npm start` no Render vai conectar no Turso, e os dados
**sobrevivem** a deploys, restarts e spin-downs.

## Passo 4 — Testar localmente (opcional)

Sem configurar nada, `npm install && npm start` continua funcionando local,
usando o arquivo `./data/vigor.db` (bom para desenvolvimento).

Para testar contra o Turso real localmente, crie um arquivo `.env` (ou exporte
no terminal) com as mesmas duas variáveis antes de rodar `npm start`:

```bash
export TURSO_DATABASE_URL="libsql://vigor-db-seuuser.turso.io"
export TURSO_AUTH_TOKEN="seu-token-aqui"
npm start
```

Acesse `GET /api/health` — o campo `db` vai indicar se está usando
`turso(libsql-remoto,persistente)` ou o arquivo local.

## Resumo do que você precisa enviar/fazer

- [x] `server.js` corrigido (já entregue)
- [x] `package.json` com a dependência `@libsql/client` (já entregue)
- [ ] Criar conta + banco no Turso e copiar URL + token
- [ ] Colocar essas duas variáveis nas **Environment Variables** do seu
      serviço no Render
- [ ] Fazer novo deploy (git push) e confirmar em `/api/health`
