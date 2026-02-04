<a id="readme-top"></a>

<br />

<div align="center">
  <a href="https://rochasystem.com.br/">
    <img src="https://rochasystem.com.br/wp-content/uploads/2024/09/logo5.3.png" alt="RochaSystem" width="140">
  </a>
  <h3 align="center">RochaSystem - Central de Apps</h3>

  <p align="center">
    Gerenciador centralizado de scripts e integrações
    <br />
    Execute, monitore e controle seus scripts .bat e .php remotamente
    <br />
    <br />

[![Electron](https://img.shields.io/badge/Electron-191970?logo=Electron&logoColor=white)](https://www.electronjs.org/) [![Node.js](https://img.shields.io/badge/node.js-6DA55F?logo=node.js&logoColor=white)](https://nodejs.org/) [![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/) [![Xterm.js](https://img.shields.io/badge/Xterm.js-000000?logo=windows-terminal&logoColor=white)](https://xtermjs.org/)
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Índice</summary>
  <ol>
    <li><a href="#sobre-o-projeto">Sobre o Projeto</a></li>
    <li><a href="#começando">Começando</a></li>
    <li><a href="#configuração">Configuração</a></li>
    <li><a href="#controle-remoto">🎮 Controle Remoto</a></li>
    <li><a href="#agendamento-automático-auto-execução">⏱️ Agendamento Automático</a></li>
    <li><a href="#estrutura-de-pastas">Estrutura de Pastas</a></li>
    <li><a href="#contato">Contato</a></li>
  </ol>
</details>

## Sobre o Projeto

**RochaSystem Central de Apps** é uma aplicação desktop desenvolvida em Electron para gerenciar e executar múltiplos scripts de forma centralizada. Execute scripts `.bat` e `.php` simultaneamente, monitore em tempo real e *controle remotamente* via banco de dados MySQL.

### ⚡ Principais Funcionalidades

- ✅ **Execução Centralizada**: Execute múltiplos scripts `.bat` e `.php` simultaneamente
- ✅ **Terminal Integrado**: Monitore a saída de cada script em tempo real com xterm.js
- ✅ **Controle Remoto**: Inicie/pare scripts remotamente via comandos SQL no banco de dados
- ✅ **⏱️ Agendamento Automático**: Configure scripts para executar automaticamente em intervalos (ex: a cada 30s)
- ✅ **Persistência de Estado**: Status de execução salvo no MySQL para acesso remoto
- ✅ **Filtros Inteligentes**: Visualize scripts por status (todos/rodando/parados/erro)
- ✅ **Logs Automáticos**: Cada execução gera um arquivo de log com timestamp
- ✅ **Interface Moderna**: UI responsiva com indicadores visuais de status

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>

## Começando

### Pré-requisitos

* **Node.js** 14+ e **npm**
  ```sh
  node --version
  npm --version
  ```

* **MySQL Server** 5.7+ (OBRIGATÓRIO)
  - [MySQL Community Server](https://dev.mysql.com/downloads/mysql/) ou [XAMPP](https://www.apachefriends.org/)

* **PHP** (opcional, apenas para scripts .php)

### Instalação

1. Clone o repositório:

   ```sh
   git clone https://github.com/rochasystem/central-de-apps.git
   cd central-de-apps
   ```

2. Instale as dependências usando comando `npm install`.

3. Crie o banco de dados e suas respectivas tabelas
   1. O projeto possui uma pasta *.docker* contendo scripts *sql* para execução para teste, mas eles podem ser utilizados para criação do banco e das tabelas.


4. Execute a aplicação
   ```sh
   npm start
   ```

5. Configure na primeira execução (via interface):
   - **Arquivo > Configurar MySQL**: Dados de conexão do banco
   - **Arquivo > Configurar Pasta RAIZ**: Pasta que contém seus projetos
   - **Arquivo > Configurar PHP**: Executável do PHP (se necessário)

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>

## Configuração

### 📁 Localização dos Arquivos de Configuração

Os arquivos de configuração ficam em:
```
Windows: C:\Users\<Usuario>\AppData\Roaming\rochasystem-central-de-apps\
Linux:   ~/.config/rochasystem-central-de-apps/
macOS:   ~/Library/Application Support/rochasystem-central-de-apps/
```

### 📄 Arquivos de Configuração

#### 1. `config.json` - Configurações Gerais
```json
{
  "phpPath": "C:\\php\\php.exe",
  "scriptsRoot": "C:\\Repositorios\\Trabalho"
}
```

**Ajustar manualmente:**
- `phpPath`: Caminho completo para o executável do PHP
- `scriptsRoot`: Pasta raiz onde seus projetos estão localizados

#### 2. `mysql-config.json` - Configuração do Banco de Dados
```json
{
  "host": "localhost",
  "port": 3306,
  "user": "root",
  "password": "sua_senha",
  "database": "rochasystem_central"
}
```

**Ajustar manualmente:**
- `host`: IP do servidor MySQL (use `localhost` ou `192.168.x.x`)
- `port`: Porta do MySQL (padrão: 3306)
- `user`: Usuário do MySQL
- `password`: Senha do MySQL
- `database`: Nome do banco (padrão: `rochasystem_central`)

> 💡 **Dica**: Você pode ajustar estes arquivos diretamente ou pela interface da aplicação (menu **Arquivo**).

### 🗂️ Estrutura de Projetos Esperada

```
PASTA_RAIZ/
├── Projeto1/
│   ├── public/          # Scripts PHP aqui
│   │   └── script.php
│   └── bats/           # Scripts .bat aqui
│       └── script.bat
├── Projeto2/
│   ├── public/
│   └── bats/
└── Projeto3/
    └── bats/
```

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>

## 🎮 Controle Remoto

Execute comandos remotamente através do banco de dados MySQL de **qualquer computador** conectado ao servidor.

### ⚡ Como Funciona

1. **Você insere um comando SQL** na tabela `remote_commands`
2. **A aplicação processa automaticamente** (verifica a cada 30 segundos)
3. **Script é iniciado ou parado** conforme o comando
4. **Comando é marcado** como `executed` ou `failed`

### 🚀 Iniciar Script Remotamente

```sql
USE rochasystem_central;

INSERT INTO remote_commands (script_path, command, requested_by)
SELECT script_path, 'start', 'luana'
FROM project_status 
WHERE script_name = 'index' AND project_name = 'API-CheckList'
LIMIT 1;
```

### 🛑 Parar Script Remotamente

```sql
USE rochasystem_central;

INSERT INTO remote_commands (script_path, command, requested_by)
SELECT script_path, 'stop', 'luana'
FROM project_status 
WHERE script_name = 'index' AND project_name = 'API-CheckList'
LIMIT 1;
```

**💡 Comportamento do Auto-Restart:**
- ✅ **Parar** um script: Cancela o timer mas **mantém a configuração**
- ✅ **Iniciar** novamente: Auto-restart é aplicado automaticamente (se estava habilitado)
- ✅ **Desabilitar**: Use o botão ⏱️ na interface ou SQL para mudar a configuração

O auto-restart é uma **configuração persistente** que sobrevive a paradas/reinícios do script!

### 📋 Verificar Status

```sql
-- Ver comandos pendentes
SELECT * FROM remote_commands WHERE status = 'pending';

-- Ver histórico de comandos
SELECT * FROM remote_commands ORDER BY requested_at DESC LIMIT 20;

-- Ver scripts rodando agora
SELECT script_name, project_name, status, started_at 
FROM project_status 
WHERE status = 'running';

-- Listar todos os scripts disponíveis
SELECT script_path, project_name, script_name 
FROM project_status 
ORDER BY project_name, script_name;
```

### ⚠️ Importante: Caminhos no Windows

Ao digitar caminhos manualmente no SQL, use `\\` (barra dupla):

```sql
-- ❌ ERRADO (barras somem)
'C:\Repositorios\Projeto\script.bat'

--  CORRETO
'C:\\Repositorios\\Projeto\\script.bat'
```

**💡 Recomendação**: Use o método com `SELECT` da tabela `project_status` (como nos exemplos acima) para evitar erros.

### 🔐 Acesso Remoto (Outro Computador)

1. **No servidor MySQL**, liberar acesso remoto:
```sql
CREATE USER 'rochasystem'@'%' IDENTIFIED BY 'SenhaForte123!';
GRANT ALL PRIVILEGES ON rochasystem_central.* TO 'rochasystem'@'%';
FLUSH PRIVILEGES;
```

2. **No firewall do servidor**, liberar porta 3306

3. **Do computador remoto**, conectar:
```sh
mysql -h 192.168.1.100 -u rochasystem -p rochasystem_central
```

### 📊 Tabelas do Banco de Dados

#### `project_status` - Status dos Scripts
Armazena o status atual de cada script (running, finished, error, stopped).

#### `remote_commands` - Fila de Comandos
Armazena comandos para iniciar/parar scripts remotamente.

| Campo | Descrição |
|-------|-----------|
| `script_path` | Caminho completo do script |
| `command` | `start` ou `stop` |
| `status` | `pending`, `executed` ou `failed` |
| `requested_by` | Quem solicitou o comando |
| `requested_at` | Quando foi solicitado |
| `executed_at` | Quando foi executado |

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>

## 🔄 Gerenciamento de Processos

### **Fechamento Automático**

Quando você fecha a aplicação, **todos os scripts em execução são parados automaticamente**:

- ✅ Scripts são finalizados graciosamente
- ✅ Status atualizado no banco (`stopped`)
- ✅ Logs salvos com mensagem de shutdown
- ✅ Auto-restart cancelado
- ✅ **Nenhum processo órfão!**

Você não precisa parar scripts manualmente antes de fechar a aplicação!

---

## ⏱️ Agendamento Automático (Auto-Execução)

Configure scripts para executar **automaticamente** em intervalos regulares. Perfeito para scripts que precisam rodar continuamente, como APIs, workers, ou tarefas de sincronização.

### 🎯 Como Configurar (Interface Gráfica)

1. **Clique no botão ⏱️** ao lado do nome do script na lista
2. **Marque "Ativar execução automática"**
3. **Defina o intervalo** em segundos (padrão: 30s)
4. **Clique em "Salvar"**

O script será iniciado imediatamente e re-executado automaticamente após cada conclusão!

### 🔄 Como Funciona

```
┌─────────────────────────────────────────┐
│ 1. Script executa                       │
│ 2. Script termina (sucesso ou erro)     │
│ 3. Aguarda X segundos (intervalo)       │
│ 4. Reinicia automaticamente             │
│ 5. Repete infinitamente                 │
└─────────────────────────────────────────┘
```

### 📊 Status no Banco de Dados

Scripts com auto-restart **sempre** mantêm status `running`:

```sql
SELECT script_name, status, exit_code, updated_at 
FROM project_status 
WHERE script_name = 'index';

-- Durante execução e durante intervalo:
-- | script_name | status  | exit_code | updated_at           |
-- |-------------|---------|-----------|----------------------|
-- | index       | running | 0         | 2026-02-02 20:30:15  |

-- exit_code mostra se a última execução teve sucesso (0) ou erro (1+)
-- Mas status permanece 'running' o tempo todo!
```

### 💻 Configuração via SQL (Alternativa)

#### Habilitar agendamento de 30 em 30 segundos:

```sql
USE rochasystem_central;

UPDATE project_status 
SET auto_restart_enabled = TRUE, auto_restart_interval = 30
WHERE script_name = 'index' AND project_name = 'API-CheckList';
```

#### Alterar intervalo para 60 segundos:

```sql
UPDATE project_status 
SET auto_restart_interval = 60 
WHERE script_name = 'index' AND project_name = 'API-CheckList';
```

#### Desabilitar agendamento:

```sql
UPDATE project_status 
SET auto_restart_enabled = FALSE 
WHERE script_name = 'index' AND project_name = 'API-CheckList';
```

#### Listar todos os scripts agendados:

```sql
SELECT 
  script_name,
  project_name,
  auto_restart_enabled,
  auto_restart_interval,
  status,
  exit_code,
  updated_at
FROM project_status
WHERE auto_restart_enabled = TRUE
ORDER BY project_name, script_name;
```

### 🎯 Casos de Uso

- ✅ **APIs/Servidores**: Scripts que precisam estar sempre ativos
- ✅ **Workers/Processadores**: Processar filas a cada X segundos
- ✅ **Sincronizadores**: Sincronizar dados periodicamente
- ✅ **Monitores**: Verificar status de sistemas regularmente
- ✅ **Scrapers**: Coletar dados em intervalos

### ⚙️ Colunas de Auto-Restart em `project_status`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `auto_restart_enabled` | BOOLEAN | Se o agendamento automático está ativo |
| `auto_restart_interval` | INT | Intervalo em segundos entre execuções (padrão: 30) |

### 🚀 Dica Pro

Para scripts críticos que precisam estar **sempre rodando**, configure:

1. **Intervalo curto** (15-30s)
2. **Habilitar agendamento** via interface
3. **Monitorar via SQL** regularmente

Exemplo de monitoramento:

```sql
-- Ver scripts agendados e seus status
SELECT 
  script_name,
  project_name,
  status,
  exit_code,
  auto_restart_interval,
  updated_at,
  CASE 
    WHEN exit_code = 0 THEN '✅ OK'
    WHEN exit_code IS NULL THEN '⚡ Iniciando'
    ELSE '⚠️ Último erro'
  END AS ultima_execucao
FROM project_status
WHERE auto_restart_enabled = TRUE
ORDER BY updated_at DESC;

-- Status será sempre 'running' para scripts agendados
-- Use exit_code para ver se houve erro na última execução
```

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>

## Estrutura de Pastas

```
RochaSystem-Central-de-Apps/
├── main.js                    # Processo principal Electron
├── renderer.js                # Interface (UI)
├── database.js                # Conexão MySQL
├── db-config.js               # Configuração MySQL
├── index.html                 # Interface HTML
├── style.css                  # Estilos
├── package.json               # Dependências
├── setup-database.sql         # Script criação do banco
└── dist/                      # Build da aplicação
    └── win-unpacked/
        └── RochaSystem - Central de Apps.exe
```

### Geração de Build

```sh
# Gerar executável Windows
npm run dist

# Executável gerado em:
dist/win-unpacked/RochaSystem - Central de Apps.exe
```

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>

## 🎯 Casos de Uso

-  **Dashboard Centralizado**: Controle scripts de múltiplas máquinas
-  **Automação**: Scripts podem iniciar outros scripts via SQL
-  **Monitoramento**: Sistema de monitoramento pode reiniciar processos
-  **Integração**: APIs externas podem controlar execuções
-  **Emergências**: Parar processos de qualquer lugar
-  **Agendamento**: Sistemas de agendamento podem disparar execuções

## 📝 Logs

Cada execução gera um arquivo de log:

```
<pasta-do-script>/logs/<nome-script>-<timestamp>.log
```

Exemplo:
```
C:\Repositorios\Trabalho\API-CheckList\bats\logs\startImport-20260130143022.log
```

## 🔄 Sincronização

- **Comandos Remotos**: Verificados a cada 30 segundos
- **Status Sync**: Sincronização passiva a cada 15 minutos
- **Limpeza**: Comandos executados há mais de 7 dias são removidos automaticamente

## Contato

[![Email](https://img.shields.io/badge/Email-contato%40rochasystem.com.br-2b2b2b?logo=gmail&logoColor=red)](mailto:contato@rochasystem.com.br) [![Telefone](https://img.shields.io/badge/Telefone-%2B55%2037%2099972--8755-2b2b2b?logo=whatsapp&logoColor=GREEN)](tel:+5537999728755)

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>
