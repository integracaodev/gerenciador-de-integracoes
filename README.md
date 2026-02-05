<a id="readme-top"></a>

<br />

<div align="center">
  <a href="https://rochasystem.com.br/">
    <img src="https://rochasystem.com.br/wp-content/uploads/2024/09/logo5.3.png" alt="RochaSystem" width="140">
  </a>
  <h3 align="center">Central de Apps</h3>

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
    <li><a href="#estrutura-de-pastas">Estrutura de Pastas</a></li>
    <li><a href="#começando">Começando</a></li>
    <li><a href="#agendamento-automático-auto-execução">Agendamento Automático</a></li>
    <li><a href="#controle-remoto"> Controle Remoto</a></li>
    <li><a href="#logs">Logs</a></li>
    <li><a href="#contato">Contato</a></li>
  </ol>
</details>

## Sobre o Projeto

**RochaSystem Central de Apps** é uma aplicação desktop desenvolvida em Electron para gerenciar e executar múltiplos scripts de forma centralizada. Execute scripts `.bat` e `.php` simultaneamente, monitore em tempo real e *controle remotamente* via banco de dados MySQL.

### Principais Funcionalidades

- **Execução Centralizada**: Execute múltiplos scripts `.bat` e `.php` simultaneamente
- **Terminal Integrado**: Monitore a saída de cada script em tempo real com xterm.js
- **Controle Remoto**: Inicie/pare scripts remotamente via comandos SQL no banco de dados
- **Agendamento Automático**: Configure scripts para executar automaticamente em intervalos (ex: a cada 30s)
- **Filtros Inteligentes**: Visualize scripts por status (todos/rodando/parados/erro)
- **Logs Automáticos**: Cada execução gera um arquivo de log com timestamp
- **Interface Moderna**: UI responsiva com indicadores visuais de status

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

<br/>

## Começando

### Pré-requisitos

* **Node.js** 14+ e **npm**
  ```sh
  node --version
  npm --version
  ```

* **MySQL Server** 5.7+ (OBRIGATÓRIO)
  - [MySQL Community Server](https://dev.mysql.com/downloads/mysql/) ou [XAMPP](https://www.apachefriends.org/)

* **PHP** 

<br/>

### Instalação

1. Clone o repositório:

   ```sh
   git clone https://github.com/integracaodev/gerenciador-de-integracoes
   cd gerenciador-de-integracoes
   ```

2. Instale as dependências usando comando `npm install`.

3. Crie o banco de dados e suas respectivas tabelas
   1. O projeto possui uma pasta *.docker* contendo scripts *sql* para execução para teste, mas eles podem ser utilizados para criação do banco e das tabelas.
   2. Se desejar testar o sistema usando o docker, entre na pasta *.docker* usando o comando 
`cd .docker` e execute o comando `docker compose up`.
4. Execute a aplicação com o comando `npm run start`.
5. Configure na primeira execução (via interface):
   - **Configurações > Configurar Servidor**: Ip do servidor atual
   - **Configurações > Configurar MySQL**: Dados de conexão do banco
     - Se estiver rodando via docker, utilize as seguintes informações:
       - localhost:3306 
       - root | sem senha
   - **Configurações > Configurar Pasta RAIZ**: Pasta que as integrações (Vide <a href="#estruturadeprojetos"> Estrutura de Projetos Esperada </a>)
   - **Configurações > Configurar PHP**: Executável do PHP


<a id="estruturadeprojetos"></a>
**Estrutura de Projetos Esperada**

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

**Localização dos Arquivos de Configuração**

As configurações feitas via `interface > menu Configurações` são salvas em arquivos. Se por algum motivo precisar acessar os arquivos, eles ficam em:
```
Windows: C:\Users\<Usuario>\AppData\Roaming\rochasystem-central-de-apps\
Linux:   ~/.config/rochasystem-central-de-apps/
macOS:   ~/Library/Application Support/rochasystem-central-de-apps/
```

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>

<br/>

## Agendamento Automático (Auto-Execução)

É possível configurar scripts para executar **automaticamente** em intervalos regulares personalizados. Por padrão, todos os scripts/.bats são executados automaticamente a cada 30 segundos.

### Como Configurar 

1. Clique no botão ⏱ ao lado do nome do script na lista
2. Marque *"Ativar execução automática"*
3. Defina o intervalo em segundos (Padrão: 30s)
4. Clique em "Salvar"

O script será iniciado imediatamente e re-executado automaticamente após cada conclusão!

<br/>

## Controle Remoto

Execute comandos remotamente através do banco de dados MySQL de **qualquer computador** conectado ao servidor.

#### Como Funciona

1. Você insere um comando SQL na tabela `remote_commands`
2. A aplicação processa automaticamente (verifica a cada 30 segundos)
3. Script é iniciado ou parado conforme o comando
4. Comando é marcado como `executed` ou `failed`

#### Tabelas do Banco de Dados

A tabela `project_status`  armazena os status dos scripts por projeto. 
- Os status possíveis são: running, finished, error e stopped. 
- Ela também contém o *server_id* que representa o IP do servidor onde a integração está instalada e as informações do script, como seu caminho no windows, nome do projeto e nome do script. 
- Esta tabela também contém os campos *auto_restart_enabled* e *auto_restart_interval*. 
  - Quando o *auto restart* estiver habilitado (auto_restart_enabled = 1) isso significa que o script será executado de tempos em tempos, conforme o intervalo cadastrado no campo *auto_restart_interval*. 
  - Por padrão, o *auto restart* está sempre habilitado, com intervalo de 30 segundos, mas isso pode ser alterado individualmente para cada script, via banco de dados, ou idealmente via interface.

A tabela `remote_commands` serve como uma fila/histórico de comandos.
- A tabela possui o campo *target_server_id* que diz em qual servidor aquele comando deve rodar.
- Possui também o campo *script_path* que mostra o caminho do script/.bat a ser executado/parado.
- E por fim, possui o campo *status* que pode ser *executed, failed e pending*. Sendo *pending* para os comandos ainda não executados, *executed* para comandos executados com sucesso e *failed* para comandos executados que resultaram em erro. Quando o status for *failed* o campo *error_message* também deverá estar preenchido, ajudando na depuração.


### Exemplos

```sql
--Iniciar um script/.bat
USE api_monitor;

INSERT INTO remote_commands (script_path, command, requested_by, target_server_id)
SELECT script_path, 'start', 'usuarioatual', server_id
FROM project_status
WHERE script_name='indexNome' AND project_name='integracao-nome'
LIMIT 1;

--Parar um script/.bat
USE api_monitor;

INSERT INTO remote_commands (script_path, command, requested_by, target_server_id)
SELECT script_path, 'stop', 'usuarioatual', server_id
FROM project_status
WHERE script_name='indexNome' AND project_name='integracao-nome'
LIMIT 1;
```

### ⚠️ Importante: Caminhos no Windows

Ao digitar caminhos manualmente no SQL, use `\\` (barra dupla):

```sql
-- ERRADO (barras somem)
'C:\Repositorios\Projeto\script.bat'

--  CORRETO
'C:\\Repositorios\\Projeto\\script.bat'
```

> **💡 Recomendação**: Use o método com `SELECT` da tabela `project_status` (como nos exemplos acima) para evitar erros.


<br/>

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>




### Instalação

**1.** Faça o build da aplicação ou baixe a versão mais recente do sistema no GitHub.
- Para gerar o build localmente, execute o comando `npm run pack`.
- Vá no [repositório da aplicação no GitHub](https://github.com/integracaodev/gerenciador-de-integracoes), acesse o menu [releases](https://github.com/integracaodev/gerenciador-de-integracoes/releases) e baixe o *.zip* mais recente.

**2.** Copie o conteúdo para o servidor. 
- Se tiver feito o build local, é necessário copiar **toda a pasta** `RochaSystem - Central de Apps-win32-x64`, que se encontra dentro da pasta *dist*, para que o executável funcione.
- Se baixou a versão direto do GitHub, extraia o conteúdo do *.zip* no servidor desejado.

**3.** Dê um duplo click no arquivo *.exe*.
**4.** Faça as configurações necessárias através do menu superior:
   - **Configurações > Configurar Servidor**: Adicione o IP do servidor atual
   - **Configurações > Configurar PHP**: Navegue e selecione a pasta que contém o executável do PHP
   - **Configurações > Configurar MySQL**: Adicione os dados de conexão com o banco.
     - No momento, o banco de dados da aplicação está no servidor *192.168.1.29*. O banco é o *api_monitor*, usuário *root* e senha *Broot123*.
   - **Configurações > Configurar Pasta RAIZ**: Navegue e selecione a pasta das integrações, elas aparecerão automaticamente na interface do sistema.
     - A pasta deve estar nessa estrutura:
    <br/>
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


<br/>

## Logs

Cada execução gera um arquivo de log:

```
<pasta-do-script>/logs/<nome-script>-<timestamp>.log
```

Exemplo:
```
C:\Repositorios\Trabalho\API-CheckList\bats\logs\startImport-20260130143022.log
```

<br/>

## Contato

[![Email](https://img.shields.io/badge/Email-contato%40rochasystem.com.br-2b2b2b?logo=gmail&logoColor=red)](mailto:contato@rochasystem.com.br) [![Telefone](https://img.shields.io/badge/Telefone-%2B55%2037%2099972--8755-2b2b2b?logo=whatsapp&logoColor=GREEN)](tel:+5537999728755)

<p align="right">(<a href="#readme-top">voltar ao topo</a>)</p>
