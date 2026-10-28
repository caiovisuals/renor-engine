# obsidian-semantic-memory

Memória semântica para o Obsidian — indexação local, recuperação semântica, busca de texto completo (FTS), entidades, fatos e ferramentas MCP para agentes.

[![CI](https://github.com/sterben-enec/obsidian-semantic-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/sterben-enec/obsidian-semantic-memory/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](./LICENSE)

**[English version → README.md](README.md)**
**[Русская версия → README.ru.md](README.ru.md)**

## O que é

O `obsidian-semantic-memory` transforma um cofre do Obsidian em uma camada de memória local que agentes e ferramentas podem consultar.

Ele indexa notas Markdown no SQLite com busca vetorial e disponibiliza um sistema de recuperação que combina:

- similaridade semântica
- busca textual BM25
- consulta de entidades
- relações de grafo
- fatos estruturados
- classificação que considera a recência

Foi desenvolvido para **sistemas pessoais de conhecimento** com prioridade local — não para painéis na nuvem ou serviços de busca SaaS hospedados.

## Por que usar

- **Privado por padrão** — embeddings locais, banco de dados local e API no localhost
- **Melhor que a busca vetorial simples** — combinação de semântica, FTS, grafo e fatos
- **Compatível com agentes** — ferramentas MCP para OpenClaw, Claude Code e outros clientes MCP
- **Nativo do Obsidian** — trabalha diretamente com notas Markdown e wikilinks
- **Atualizações em tempo real** — um monitor reindexa as alterações em segundos

## Funcionalidades

- **Embeddings locais** por meio de `@xenova/transformers`
- **Recuperação com múltiplos sinais** usando vetores semânticos, FTS BM25 e reforços baseados em grafos e fatos
- **Servidor MCP** com 7 ferramentas
- **API HTTP** para integrações locais
- **Memória estruturada** com entidades, relações e fatos
- **Suporte a `.semanticignore`** para excluir caminhos privados ou irrelevantes

## Início rápido

```bash
git clone https://github.com/sterben-enec/obsidian-semantic-memory
cd obsidian-semantic-memory
cp .env.example .env
npm install
npm run build
```

Defina `VAULT_PATH` no arquivo `.env` e execute:

```bash
# reconstrução completa
node dist/cli.js rebuild

# indexação incremental
node dist/cli.js index

# recuperação semântica
node dist/cli.js search "what do I know about project X"

# monitorar alterações
node dist/cli.js watch

# API HTTP local
node dist/cli.js serve

# servidor MCP
node dist/cli.js mcp

# registrar uma sessão do Claude Code no cofre executado automaticamente pelo hook Stop
node dist/cli.js log-conversation
```

## Arquitetura

```text
Cofre do Obsidian (arquivos .md)
  → análise (frontmatter + corpo + wikilinks)
  → divisão em blocos por títulos e limite de tokens
  → geração de embeddings (local ou OpenAI)
  → SQLite: notas, blocos, entidades, fatos e relações
  → índice de palavras-chave FTS5
  → índice vetorial sqlite-vec
  → classificação com múltiplos sinais
  → CLI / MCP / API HTTP
```

## Requisitos

- Node.js 18 ou superior
- Para embeddings locais: aproximadamente 560 MB de cache de modelo na primeira execução
- Para embeddings da OpenAI: `OPENAI_API_KEY`

## Configuração

Toda a configuração é feita por variáveis de ambiente. Para desenvolvimento local, comece pelo arquivo `.env.example`.

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `VAULT_PATH` | Sim | — | Caminho absoluto para o cofre do Obsidian |
| `EMBEDDING_PROVIDER` | Não | `openai` | `local` ou `openai` |
| `EMBEDDING_MODEL` | Não | `Xenova/multilingual-e5-base` | Nome do modelo para embeddings locais |
| `OPENAI_API_KEY` | Se usar OpenAI | — | Chave de API da OpenAI |
| `DB_PATH` | Não | `$VAULT_PATH/.semantic-memory/index.db` | Caminho do banco de dados SQLite |
| `MEMORY_DIR` | Não | `Memory/Daily` | Caminho relativo ao cofre para memórias diárias |
| `CONVERSATIONS_DIR` | Não | `Claude Code/Conversations` | Caminho relativo ao cofre para notas de conversas |
| `CHUNK_MAX_TOKENS` | Não | `400` | Número máximo de tokens por bloco |
| `CHUNK_OVERLAP_TOKENS` | Não | `50` | Sobreposição de tokens entre blocos |
| `PRIORITY_PATHS` | Não | `""` | Caminhos do cofre separados por vírgulas que receberão maior prioridade |
| `LLM_EXTRACTION` | Não | `false` | Ativa a extração de fatos por LLM |
| `INDEX_CONCURRENCY` | Não | `5` | Número de processos paralelos de indexação |

### Modelos locais recomendados

| Modelo | Dimensões | Tamanho | Observações |
|---|---:|---:|---|
| `Xenova/multilingual-e5-base` | 768 | Aproximadamente 560 MB | Melhor opção padrão, multilíngue |
| `Xenova/multilingual-e5-small` | 384 | Aproximadamente 120 MB | Mais rápido e leve |
| `Xenova/all-MiniLM-L6-v2` | 384 | Aproximadamente 25 MB | Apenas inglês, muito rápido |

Os modelos E5 usam automaticamente os prefixos assimétricos `query:` e `passage:`.

## Ferramentas MCP

O servidor MCP disponibiliza 7 ferramentas por meio de stdio:

- `vault_search` — recuperação semântica
- `vault_fts` — busca por palavras-chave e frases usando BM25
- `vault_entity` — consulta de entidades por nome ou alias
- `vault_facts` — consulta de fatos de uma entidade
- `vault_status` — contagens do índice e resumo de integridade
- `vault_remember` — adiciona texto a uma nota de memória diária
- `vault_store_fact` — armazena um fato estruturado

Exemplo de configuração MCP:

```json
{
  "mcpServers": {
    "obsidian-memory": {
      "command": "node",
      "args": ["/path/to/obsidian-semantic-memory/dist/cli.js", "mcp"],
      "env": {
        "VAULT_PATH": "/path/to/your/vault",
        "EMBEDDING_PROVIDER": "local",
        "EMBEDDING_MODEL": "Xenova/multilingual-e5-base"
      }
    }
  }
}
```

## API HTTP

A API HTTP aceita conexões somente em `127.0.0.1` e não fica aberta indiscriminadamente nesse endereço. Duas verificações são executadas antes de qualquer rota:

- **Token obrigatório:** `RENOR_API_TOKEN` é necessário. O comando `node dist/cli.js serve` não inicia sem ele, pois outros usuários da máquina podem acessar `127.0.0.1`. Escolha um valor aleatório longo e envie-o em todas as requisições no cabeçalho `Authorization: Bearer <token>`. Requisições sem o token recebem `401`.
- **Verificação do Host:** somente os hosts `localhost`, `127.0.0.1` e `[::1]` recebem respostas. Uma página web que redireciona seu próprio domínio para `127.0.0.1` envia o próprio cabeçalho Host e recebe `403`.

```bash
export RENOR_API_TOKEN="$(openssl rand -hex 32)"
node dist/cli.js serve
curl -H "Authorization: Bearer $RENOR_API_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"project"}' http://127.0.0.1:3456/retrieve-context
```

| Método | Caminho | Descrição |
|---|---|---|
| `POST` | `/retrieve-context` | Recuperação semântica: `{ query, topK? }` |
| `GET` | `/entity/:name` | Consulta de entidade por nome ou alias |
| `GET` | `/facts/:entityId` | Consulta de fatos de uma entidade |
| `POST` | `/memory/daily` | Adiciona conteúdo à nota diária: `{ date, text, source? }` |

## `.semanticignore`

Crie um arquivo `.semanticignore` na raiz do cofre para excluir arquivos da indexação:

```text
# Segredos
config/secrets.md
private/env.md

# Diretórios
Templates/
Archive/old/
```

Os padrões são comparados com caminhos relativos à raiz do cofre.

## Integração com Claude Code

O comando `log-conversation` registra cada sessão do Claude Code como uma nota Markdown estruturada no cofre. O monitor existente detecta os novos arquivos e os indexa automaticamente — em segundos, as conversas ficam disponíveis para consulta por meio de `vault_search`.

### Como funciona

1. O Claude Code chama o hook `Stop` quando uma sessão termina.
2. O hook executa `scripts/log-conversation.sh`, que define as variáveis de ambiente e chama `log-conversation`.
3. O comando lê `~/.claude/projects/<project>/<session_id>.jsonl`, extrai as interações do usuário e do assistente, além das alterações de código (chamadas às ferramentas `Edit`, `Write` e `Bash`), e grava uma nota Markdown em `CONVERSATIONS_DIR`.
4. O monitor reindexa a nova nota.

Cada nota tem uma estrutura semelhante a esta:

```markdown
---
kind: conversation
date: 2026-04-03
time_start: 14:32
session_id: 0069c9ea-…
project: /Users/you/my-project
title: "Fix auth bug"
---

**User:** Please fix the authentication bug

**Assistant:** I'll fix it now.

> **Edit** `src/auth.ts`
> ```diff
> - return false;
> + return true;
> ```
```

### Configuração

1. Copie e edite o script auxiliar:

```bash
cp scripts/log-conversation.sh ~/my-log-conversation.sh
# Edit VAULT_PATH, CONVERSATIONS_DIR, and Node.js path inside
chmod +x ~/my-log-conversation.sh
```

2. Adicione o hook `Stop` a `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/my-log-conversation.sh",
            "async": true
          }
        ]
      }
    ]
  }
}
```

3. Certifique-se de que o monitor esteja em execução (consulte o exemplo de `launchd` abaixo) para que novas notas sejam indexadas imediatamente.

## Exemplo de `launchd` no macOS

Crie `~/Library/LaunchAgents/com.yourname.osm-watcher.plist` para executar o monitor ao iniciar a sessão:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.yourname.osm-watcher</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/opt/node@24/bin/node</string>
      <string>/path/to/obsidian-semantic-memory/dist/cli.js</string>
      <string>watch</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>VAULT_PATH</key>
      <string>/path/to/your/vault</string>
      <key>EMBEDDING_PROVIDER</key>
      <string>local</string>
      <key>EMBEDDING_MODEL</key>
      <string>Xenova/multilingual-e5-base</string>
      <key>HOME</key>
      <string>/Users/yourname</string>
      <key>PATH</key>
      <string>/usr/local/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
  </dict>
</plist>
```

## Modelo de segurança

- A API HTTP aceita conexões somente em `127.0.0.1`.
- O transporte MCP utiliza apenas stdio.
- Notas privadas e segredos devem ser excluídos por meio de `.semanticignore`.
- Arquivos `.env` locais nunca devem ser enviados ao repositório.

Consulte [SECURITY.md](../../SECURITY.pt-BR.md.md) para obter instruções sobre como relatar vulnerabilidades.

## Como contribuir

Consulte [CONTRIBUTING.md](CONTRIBUTING.md).

## Sobre o repositório no GitHub

Descrição sugerida para o repositório:

> Memória semântica local para Obsidian: SQLite + busca vetorial + FTS + entidades + fatos + ferramentas MCP.

Tópicos sugeridos:

`obsidian`, `semantic-search`, `mcp`, `knowledge-graph`, `sqlite`, `vector-search`, `local-first`, `typescript`

## Licença

ISC
