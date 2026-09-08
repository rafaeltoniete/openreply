# Deploy do openreply — Docker Swarm + Traefik v2 + ghcr.io

Uma imagem (`ghcr.io/rafaeltoniete/openreply`), **quatro serviços**, um domínio.
Mesmo padrão do resto do ecossistema (Swarm + Traefik `letsencryptresolver` + rede `zapinpro`).

| serviço | o que é | se cair |
|---|---|---|
| `web` | Next.js: painel + OAuth + **webhook do Meta** | nada entra |
| `worker` | tira o job da fila e **manda a DM** | comentário entra e **nada sai** |
| `cron` | `scripts/cron.sh`, substitui os crons do `vercel.json` | o token do Instagram expira **em silêncio** e tudo para sem erro |
| `redis` | fila BullMQ, só na rede interna | a fila para |

> **O painel não é o produto sozinho.** Um `docker service ls` com o `web` verde e o
> `worker` em 0/1 parece funcionando: o webhook chega, a campanha casa, e nenhuma DM sai.
> Confira sempre pelo `/api/health`, não pelo painel.

---

## 0. Pré-requisitos

- **Arquitetura da VPS.** Antes de tudo:
  ```bash
  uname -m
  ```
  `aarch64` → o workflow já está certo. `x86_64` → troque as duas linhas marcadas
  `[ARCH]` em `.github/workflows/build-push-ghcr.yml` (`runs-on: ubuntu-latest` e
  `platforms: linux/amd64`). Não builde arm64 por QEMU: `next build` sob emulação trava.

- **DNS.** Um registro A `openreply.zapin.pro` → IP da VPS, **DNS only** (nuvem cinza no
  Cloudflare). O proxy da Cloudflare atrapalha o webhook do Meta, e o Let's Encrypt só
  emite o certificado depois que o nome resolve. Crie **antes** do deploy.

- **Swarm + rede `zapinpro`** (a mesma do Traefik / postgres15 / FitPage / TikShop):
  ```bash
  docker network ls | grep zapinpro
  ```

- **Login no ghcr** no manager do Swarm (imagem privada):
  ```bash
  echo "$GHCR_PAT" | docker login ghcr.io -u rafaeltoniete --password-stdin
  ```

- **E-mail.** O login do painel é **só por magic link**. Sem SMTP ou Resend configurado,
  ninguém entra — nem você.

---

## 1. Publicar a imagem

```bash
git tag v1
git push origin v1
```

O workflow `build-push-ghcr` builda e publica `ghcr.io/rafaeltoniete/openreply:v1` e `:latest`.
Dá para rodar manualmente em **Actions → build-push-ghcr → Run workflow** informando a versão.

Uma imagem só serve aos três processos — quem define o papel é o `command` de cada serviço
no `docker-stack.yml`.

---

## 2. Criar o banco no `postgres15`

O Prisma é dono do schema `public` do banco que receber, então ele precisa de um banco
**dedicado** — não dá para dividir com outro app. (O dm-zapin usa um *schema* dentro do banco
compartilhado; aqui é diferente.)

```bash
# no manager do Swarm
docker exec -it $(docker ps -q -f name=postgres15) \
  psql -U postgres -c "CREATE DATABASE openreply;"
```

O usuário do `DATABASE_URL` precisa poder criar tabelas nesse banco (ser dono já resolve).
As migrações rodam sozinhas no start do `web` (`prisma migrate deploy`), **não** no build da
imagem: durante o build não existe rede para alcançar o banco — é o erro `P1001` clássico.

---

## 3. `.env.prod` na VPS

Copie `.env.deploy.example` para `.env.prod` **na VPS** (fora do git) e preencha.
Gere os segredos:

```bash
openssl rand -hex 32   # NEXTAUTH_SECRET
openssl rand -hex 32   # CRON_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY  (tem que ter 64 hex)
```

Dois campos que costumam morder:

- **`ENCRYPTION_KEY`** cifra os tokens do Instagram no banco. Trocar depois transforma todo
  token salvo em lixo e obriga a reconectar as contas. Guarde junto com o resto.
- **`ALLOWED_EMAILS`** — sem isto, **qualquer pessoa** que abrir `openreply.zapin.pro` pede um
  magic link, entra e ganha um workspace próprio. Preencha com o seu e-mail.

---

## 4. Subir

```bash
set -a; . ./.env.prod; set +a          # stack deploy NÃO lê env_file
docker stack deploy --with-registry-auth -c docker-stack.yml openreply
docker service ls | grep openreply     # os 4 devem ficar 1/1
```

Acompanhar a primeira subida (a migração roda aqui):

```bash
docker service logs -f openreply_web
docker service logs -f openreply_worker
docker service logs -f openreply_cron    # "scheduler started, target http://web:3000"
```

---

## 5. Apontar o Meta para cá

Use o **mesmo app do Meta** do dm-zapin (fluxo *Instagram API with Instagram Login*) — não
precisa de App Review novo: é o mesmo fluxo e as mesmas permissões.

1. **Instagram → Business login settings → OAuth redirect URIs**: acrescente, sem barra final:
   ```
   https://openreply.zapin.pro/api/instagram/callback
   ```
   Pode ter mais de um; **mantenha o do dm-zapin na lista**.

2. **Instagram → Configure webhooks**:
   - Callback URL: `https://openreply.zapin.pro/api/webhook`
   - Verify token: o mesmo `WEBHOOK_VERIFY_TOKEN` do `.env.prod`
   - Assine **`comments` E `messages`**. Só `comments` faz o gatilho por DM/Story parecer
     ligado no painel e nunca disparar, porque o evento não chega.

> ⚠️ **Webhook é um só por app.** O Meta aceita vários redirect URIs, mas **uma única**
> callback URL de webhook. No momento em que você apontar para cá, o dm-zapin **para de
> receber comentários** — continua no ar, só fica mudo. É reversível em 30 segundos (cola a
> URL antiga de volta). Para os dois receberem ao mesmo tempo seria preciso um segundo app
> do Meta, com a sua conta como testadora.

3. O app precisa estar em **Live**. Em Development mode só o botão *Test* do console entrega
   evento — é a causa nº 1 de "configurei tudo e não acontece nada".

---

## 6. Primeiro acesso

1. Abra `https://openreply.zapin.pro`, peça o magic link com um e-mail que esteja em
   `ALLOWED_EMAILS`, entre.
2. **Settings → Connect Instagram** → autorize a conta profissional.
3. Crie uma campanha, comente a palavra-chave num Reel seu **de outra conta** e veja a DM
   chegar. O Meta rejeita DM para você mesmo, então o teste da própria conta nunca funciona.

---

## 7. Conferir que está de pé

```bash
curl -s https://openreply.zapin.pro/api/health | python -m json.tool
```

Tem que dar `ok` em banco, redis, fila **e** `worker.healthy: true`. `worker.healthy: false`
significa worker fora do ar ou sem alcançar o Redis — e aí nenhuma DM sai, mesmo com o
webhook chegando normalmente.

Onde um comentário parou, direto no Postgres: `WebhookEvent` (chegou), `DmLog` (envio e erro),
`OperationalEvent` (crash do worker e varreduras do reconciliador).

---

## 8. Atualizar e voltar atrás

```bash
git tag v2 && git push origin v2       # CI builda ghcr.io/rafaeltoniete/openreply:v2
# na VPS:
sed -i 's/^OPENREPLY_VERSION=.*/OPENREPLY_VERSION=v2/' .env.prod
set -a; . ./.env.prod; set +a
docker stack deploy --with-registry-auth -c docker-stack.yml openreply
```

Rollback é a mesma coisa com a tag anterior. **Migração de banco não volta sozinha**: se a
versão nova trouxe migração do Prisma, o rollback da imagem deixa o banco à frente do código.

---

## 9. Armadilhas conhecidas

- **Worker parado = silêncio total.** É o modo de falha mais caro deste app: tudo parece certo
  e nenhuma DM sai. `/api/health` é o único lugar que denuncia.
- **Sem o serviço `cron`, o token do Instagram expira e tudo para sem erro.** Os agendamentos
  vivem no `vercel.json`, que ninguém lê fora da Vercel. É por isso que o `cron` está no stack.
- **`DATABASE_URL`, `REDIS_URL` e `ENCRYPTION_KEY` idênticos** entre `web` e `worker`.
  Diferentes, o worker não decifra o token e todo envio falha.
- **Cloudflare em `DNS only`.** Com o proxy laranja ligado, o webhook do Meta fica intermitente.
- **Domínio primário.** Se mudar o domínio, atualize a callback URL no Meta. Um domínio
  não-primário devolve 307 no POST, e o Meta não segue redirect — o webhook para em silêncio.
- **`replicas: 1` no `web` é de propósito**: duas réplicas rodariam `prisma migrate deploy` ao
  mesmo tempo no start.

---

## 10. Aposentar o dm-zapin

Só depois de validar aqui:

```bash
docker stack rm dmzapin
```

O banco do dm-zapin vive num schema `dmzapin` dentro do Postgres compartilhado e **não** é
apagado por isso — derrube o schema à mão quando tiver certeza. Os registros DNS
`dmzapin.zapin.pro` e `dmapp.zapin.pro` também ficam órfãos.
