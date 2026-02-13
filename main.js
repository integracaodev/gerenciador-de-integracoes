// main.js — RAIZ\<projeto>\public\*.php (todos os arquivos PHP dentro de public, recursivo)
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const { spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const treeKill = require('tree-kill');
const os = require('os');
const { initDatabase, saveProjectStatus, getProjectStatus, getAllProjectStatuses, closeDatabase, testConnection, getPendingRemoteCommands, markRemoteCommandAsExecuted, markRemoteCommandAsFailed, cleanOldRemoteCommands, getScriptSchedule, saveScriptSchedule, deleteScriptSchedule } = require('./database');
const { loadMySQLConfig, saveMySQLConfig } = require('./db-config');

let mainWindow;
let syncInterval = null;
let remoteCommandsInterval = null;
const scheduleTimers = {}; // { scriptPath: timeoutId }
const AGENT_HOST = os.hostname();
const AGENT_ID = `${AGENT_HOST}-${process.pid}`;

function getCurrentServerId() {
  // Priority: env var > config.json > hostname
  try {
    const envId = process.env.ROCHASYSTEM_SERVER_ID;
    if (envId && String(envId).trim()) return String(envId).trim();
  } catch {}
  try {
    const cfg = loadConfig();
    if (cfg?.serverId && String(cfg.serverId).trim()) return String(cfg.serverId).trim();
  } catch {}
  return AGENT_HOST;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let dbReinitPromise = null;
async function reinitDatabaseSafe() {
  if (dbReinitPromise) return dbReinitPromise;
  dbReinitPromise = (async () => {
    try {
      try { await closeDatabase(); } catch {}
      await initDatabase();
      console.log('[MySQL] Reconexão OK');
      return true;
    } catch (e) {
      console.error('[MySQL] Falha ao reconectar:', e?.message || e);
      return false;
    } finally {
      dbReinitPromise = null;
    }
  })();
  return dbReinitPromise;
}

async function saveStatusWithRetry(scriptPath, projectName, scriptName, status, exitCode = null, logFile = null, pid = undefined) {
  const serverId = getCurrentServerId();
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    const ok = await saveProjectStatus(scriptPath, projectName, scriptName, status, exitCode, logFile, pid, serverId);
    if (ok) return true;
    console.warn(`[MySQL] saveProjectStatus falhou (tentativa ${i}/${attempts})`, { scriptName, status });
    await reinitDatabaseSafe();
    await delay(250 * i);
  }
  return false;
}

function treeKillAsync(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(new Error('PID inválido'));
    // On Windows, tree-kill will use taskkill under the hood.
    treeKill(pid, 'SIGKILL', (err) => resolve(err || null));
  });
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it's running but we don't have permission
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

async function killAndWaitForExit(child, { gracefulMs = 800, forceMs = 10000 } = {}) {
  if (!child) return { ok: false, reason: 'child_missing' };
  // If it already exited, don't wait forever
  if (child.exitCode !== null || child.signalCode !== null) {
    return { ok: true, pid: child.pid, code: child.exitCode, signal: child.signalCode };
  }
  const pid = child.pid;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  // Try graceful first
  try { child.kill(); } catch {}
  let exited = await Promise.race([exitPromise, delay(gracefulMs)]);

  // If still running, force kill the whole tree
  if (!exited) {
    const killErr = await treeKillAsync(pid);
    if (killErr) {
      // If process already gone, consider it ok and continue waiting for 'exit'
      const msg = String(killErr?.message || killErr);
      if (!/no such process|not found|esrch/i.test(msg.toLowerCase())) {
        // Still wait a bit; sometimes taskkill returns non-zero but process exits anyway.
        console.warn('[Kill] treeKill error:', msg, 'pid:', pid);
      }
    }
    exited = await Promise.race([exitPromise, delay(Math.max(0, forceMs - gracefulMs))]);
  }

  if (!exited) return { ok: false, reason: 'timeout', pid };
  return { ok: true, pid, ...exited };
}

async function stopScriptLikeTabClose(scriptPath, {
  reason = 'STOP',
  closeTabUi = false,
  allowPidFallback = false,
  updateDbWhenNoLocalProcess = true,
} = {}) {
  // Cancelar timer pendente de auto-restart (se houver)
  if (scheduleTimers[scriptPath]) {
    clearTimeout(scheduleTimers[scriptPath]);
    delete scheduleTimers[scriptPath];
    console.log(`[Stop] Timer de auto-restart cancelado: ${scriptPath}`);
  }

  // Extrair informações do projeto
  const pathSegments = scriptPath.split(path.sep);
  const projectName = pathSegments[pathSegments.length - 3] || 'Unknown';
  const scriptName = path.basename(scriptPath, path.extname(scriptPath));

  const entry = procMap[scriptPath];
  if (!entry) {
    if (allowPidFallback) {
      const dbRow = await getProjectStatus(scriptPath);
      const dbPid = dbRow?.pid;
      const dbServer = dbRow?.server_id;
      const currentServerId = getCurrentServerId();

      // If the row is tagged to another server, don't touch it.
      if (dbServer && dbServer !== currentServerId) {
        return {
          ok: false,
          reason: 'different_server',
          message: `script pertence a outro servidor (db.server_id=${dbServer}, this=${currentServerId})`,
        };
      }

      if (dbPid) {
        console.warn(`[Stop] procMap vazio. Tentando parar por PID=${dbPid}. script=${scriptPath}`);
        await treeKillAsync(dbPid);
        await delay(600);
        if (isPidAlive(dbPid)) {
          return { ok: false, reason: 'pid_still_alive', pid: dbPid };
        }
        const saved = await saveStatusWithRetry(scriptPath, projectName, scriptName, 'stopped', null, null, null);
        if (!saved) {
          return { ok: false, reason: 'db_write_failed', method: 'pid', pid: dbPid };
        }
        return { ok: true, method: 'pid', pid: dbPid };
      }
    }

    // Não há processo local sob controle:
    // - UI close: pode atualizar status por intenção
    // - multi-server: NÃO deve consumir o comando se outro servidor pode executar
    if (updateDbWhenNoLocalProcess) {
      const saved = await saveStatusWithRetry(scriptPath, projectName, scriptName, 'stopped', null, null, null);
      if (!saved) {
        return { ok: false, reason: 'db_write_failed', method: 'intent' };
      }
    }
    return { ok: false, reason: 'no_local_process' };
  }

  const { process: child, logStream } = entry;

  // Mimic UI X: fechar tab antes de matar (somente quando existe processo local)
  if (closeTabUi && mainWindow) {
    mainWindow.webContents.send('close-tab', scriptPath);
  }

  // Marcar como manualmente parado para não disparar auto-restart no exit handler
  try { procMap[scriptPath].manuallyStopped = true; } catch {}

  try {
    logStream?.write(`\n[${reason}] Script parado via ${reason}\n`);
  } catch {}

  const result = await killAndWaitForExit(child, { gracefulMs: 800, forceMs: 12000 });
  if (!result.ok) {
    // Não mentir no banco se não conseguiu parar
    const savedRunning = await saveStatusWithRetry(scriptPath, projectName, scriptName, 'running', null, null, child?.pid ?? undefined);
    if (!savedRunning) {
      return { ok: false, reason: 'db_write_failed', method: 'procMap', pid: result.pid ?? child?.pid };
    }
    return { ok: false, reason: 'kill_timeout', pid: result.pid ?? child?.pid };
  }

  const savedStopped = await saveStatusWithRetry(scriptPath, projectName, scriptName, 'stopped', null, null, null);
  if (!savedStopped) {
    // Processo parou, mas não conseguimos refletir no banco
    return { ok: false, reason: 'db_write_failed', method: 'procMap', pid: result.pid, killed: true };
  }
  return { ok: true, method: 'procMap', pid: result.pid };
}

/* ===================== Database (MySQL) ===================== */
// As funções de banco de dados agora são importadas do módulo database.js

/* ===================== Sincronização com Banco de Dados ===================== */
/**
 * Sincroniza o estado dos processos locais com o banco de dados.
 * Se um script está rodando localmente mas o banco diz "stopped", o script é parado.
 * Isso permite controle remoto através de alterações diretas no banco de dados.
 */
async function syncWithDatabase() {
  try {
    console.log('[Sync] Iniciando sincronização com banco de dados...');
    
    // Obter todos os status do banco de dados
    const dbStatuses = await getAllProjectStatuses();
    
    if (!dbStatuses || dbStatuses.length === 0) {
      console.log('[Sync] Nenhum status no banco de dados');
      return;
    }
    
    let stoppedCount = 0;
    let updatedCount = 0;
    
    // Verificar cada processo em execução
    for (const scriptPath in procMap) {
      const dbStatus = dbStatuses.find(s => s.script_path === scriptPath);
      
      if (dbStatus) {
        // Se o banco diz que deve estar parado, mas está rodando localmente
        if (dbStatus.status === 'stopped' && procMap[scriptPath]) {
          console.log(`[Sync] Parando script remotamente: ${scriptPath}`);
          
          const entry = procMap[scriptPath];
          const { process: child, logStream } = entry;

          // Marcar como manualmente parado para não disparar auto-restart
          try { procMap[scriptPath].manuallyStopped = true; } catch {}
          
          // Adicionar mensagem no log
          const msg = `\n[REMOTE STOP] Script parado remotamente via sincronização de banco de dados\n`;
          try { logStream.write(msg); } catch {}

          console.log(`[Sync] Killing pid=${child?.pid} (agent=${AGENT_ID})`);
          const result = await killAndWaitForExit(child, { gracefulMs: 800, forceMs: 12000 });
          if (!result.ok) {
            console.error(`[Sync] Falha ao parar (pid=${result.pid ?? child?.pid ?? '??'}). Mantendo status como running para não mentir no banco.`);
            await saveStatusWithRetry(scriptPath, dbStatus.project_name, dbStatus.script_name, 'running', null, null, child?.pid ?? undefined);
          } else {
            // Garantir stopped no banco (já deveria estar), mas atualiza timestamps
            await saveStatusWithRetry(scriptPath, dbStatus.project_name, dbStatus.script_name, 'stopped', null, null, null);
          }
          
          stoppedCount++;
        }
      }
    }
    
    // Verificar processos que deveriam estar rodando mas não estão
    // (Atualizar status no banco para refletir a realidade)
    const currentServerId = getCurrentServerId();
    for (const dbStatus of dbStatuses) {
      // MULTI-SERVIDOR: só “corrige” scripts deste servidor (ou sem server_id)
      if (dbStatus.server_id && dbStatus.server_id !== currentServerId) {
        continue;
      }
      if (dbStatus.status === 'running' && !procMap[dbStatus.script_path]) {
        // O banco diz que está rodando, mas não está localmente
        // Atualizar para "stopped" para refletir a realidade
        console.log(`[Sync] Atualizando status de script não encontrado: ${dbStatus.script_path}`);
        
        const pathSegments = dbStatus.script_path.split(path.sep);
        const projectName = pathSegments[pathSegments.length - 3] || 'Unknown';
        const scriptName = path.basename(dbStatus.script_path, path.extname(dbStatus.script_path));
        
        await saveStatusWithRetry(dbStatus.script_path, projectName, scriptName, 'stopped', null, null, null);
        
        updatedCount++;
      }
    }
    
    console.log(`[Sync] Sincronização concluída - Parados: ${stoppedCount}, Atualizados: ${updatedCount}`);
    
  } catch (error) {
    console.error('[Sync] Erro na sincronização:', error.message);
  }
}

/**
 * Inicia o timer de sincronização periódica (a cada 15 minutos)
 */
function startSyncTimer() {
  // Limpar timer existente se houver
  if (syncInterval) {
    clearInterval(syncInterval);
  }
  
  // Executar primeira sincronização após 30 segundos
  setTimeout(() => {
    syncWithDatabase();
  }, 30000);
  
  // Configurar sincronização a cada 15 minutos (900000 ms)
  syncInterval = setInterval(() => {
    syncWithDatabase();
  }, 15 * 60 * 1000);
  
  console.log('[Sync] Timer de sincronização iniciado (15 minutos)');
}

/**
 * Para o timer de sincronização
 */
function stopSyncTimer() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    console.log('[Sync] Timer de sincronização parado');
  }
}

/* ===================== Processamento de Comandos Remotos ===================== */
/**
 * Processa comandos remotos pendentes no banco de dados
 */
async function processRemoteCommands() {
  try {
    console.log('[RemoteCmd] Verificando comandos remotos pendentes...');
    
    const commands = await getPendingRemoteCommands();
    
    if (!commands || commands.length === 0) {
      console.log('[RemoteCmd] Nenhum comando pendente');
      return;
    }
    
    console.log(`[RemoteCmd] Encontrados ${commands.length} comando(s) pendente(s)`);
    
    for (const cmd of commands) {
      try {
        console.log(`[RemoteCmd] Processando comando #${cmd.id}: ${cmd.command} para ${cmd.script_path}`);
        
        if (cmd.command === 'start') {
          // Comando para INICIAR script
          await executeRemoteStartCommand(cmd);
        } else if (cmd.command === 'stop') {
          // Comando para PARAR script
          await executeRemoteStopCommand(cmd);
        } else {
          throw new Error(`Comando desconhecido: ${cmd.command}`);
        }
        
      } catch (error) {
        console.error(`[RemoteCmd] Erro ao processar comando #${cmd.id}:`, error.message);
        await markRemoteCommandAsFailed(cmd.id, error.message);
      }
    }
    
  } catch (error) {
    console.error('[RemoteCmd] Erro no processamento de comandos remotos:', error.message);
  }
}

/**
 * Executa comando remoto para INICIAR um script
 */
async function executeRemoteStartCommand(cmd) {
  const scriptPath = cmd.script_path;
  const currentServerId = getCurrentServerId();
  const targetServerId = cmd.target_server_id;

  // Se comando é direcionado para outro servidor, não processar (deixa pending)
  if (targetServerId && targetServerId !== currentServerId) {
    return;
  }

  // Se project_status já indica que o script pertence a outro servidor, não consumir
  try {
    const dbRow = await getProjectStatus(scriptPath);
    const dbServer = dbRow?.server_id;
    if (dbServer && dbServer !== currentServerId && !targetServerId) {
      return;
    }
  } catch {}
  
  // Verificar se o script já está rodando
  if (procMap[scriptPath]) {
    console.log(`[RemoteCmd] Script já está rodando: ${scriptPath}`);
    // Garantir que o banco reflita running (pode ter ficado stopped por falha anterior)
    try {
      const pathSegments = scriptPath.split(path.sep);
      const projectName = pathSegments[pathSegments.length - 3] || 'Unknown';
      const scriptName = path.basename(scriptPath, path.extname(scriptPath));
      const pid = procMap[scriptPath]?.process?.pid;
      await saveStatusWithRetry(scriptPath, projectName, scriptName, 'running', null, null, pid ?? undefined);
    } catch {}
    await markRemoteCommandAsExecuted(cmd.id);
    return;
  }
  
  // Verificar se o arquivo existe
  if (!fs.existsSync(scriptPath)) {
    // Multi-servidor: se não for direcionado, outro servidor pode executar -> não consome
    if (!targetServerId) {
      console.log(`[RemoteCmd] Arquivo não existe neste servidor (${currentServerId}). Mantendo comando pending: ${scriptPath}`);
      return;
    }
    // Direcionado para este servidor, então falha de verdade
    throw new Error(`Arquivo não encontrado neste servidor (${currentServerId}): ${scriptPath}`);
  }
  
  console.log(`[RemoteCmd] Iniciando script remotamente: ${scriptPath}`);
  
  // Criar um evento falso para usar a função runScript existente
  const fakeEvent = {
    reply: (channel, data) => {
      if (mainWindow) {
        mainWindow.webContents.send(channel, data);
      }
    }
  };
  
  // Iniciar o script usando a função existente
  const started = await runScript(fakeEvent, scriptPath);
  if (!started) {
    throw new Error(`Falha ao iniciar script (status não persistido no banco): ${scriptPath}`);
  }
  
  // Marcar como executado
  await markRemoteCommandAsExecuted(cmd.id);
  
  // Notificar o renderer para atualizar a lista
  if (mainWindow) {
    mainWindow.webContents.send('refresh-projects');
  }
  
  console.log(`[RemoteCmd] Script iniciado com sucesso: ${scriptPath}`);
}

/**
 * Executa comando remoto para PARAR um script
 */
async function executeRemoteStopCommand(cmd) {
  const scriptPath = cmd.script_path;
  const currentServerId = getCurrentServerId();
  const targetServerId = cmd.target_server_id;

  // Se comando é direcionado para outro servidor, não processar (deixa pending)
  if (targetServerId && targetServerId !== currentServerId) {
    return;
  }
  
  // Para script usando a MESMA lógica do stop-bat (stopScriptLikeTabClose)
  const stopResult = await stopScriptLikeTabClose(scriptPath, {
    reason: 'REMOTE_STOP',
    // Multi-servidor: não feche UI se este servidor não executar o comando
    closeTabUi: false,
    allowPidFallback: true,
    // Se não houver processo local, NÃO atualiza DB e NÃO consome comando (outro servidor pode executar)
    updateDbWhenNoLocalProcess: false,
  });

  // Se matou/parou, mas não conseguiu gravar no banco, NÃO consome o comando (deixa pending para retry)
  if (!stopResult.ok && stopResult.reason === 'db_write_failed') {
    console.warn(`[RemoteCmd] Stop: processo/parada OK, mas falhou gravar status no DB. Mantendo pending para retry. script=${scriptPath}`);
    // Ainda assim, se o processo de fato foi encerrado, podemos fechar a tab para refletir o estado real,
    // e deixar o comando pending para re-tentar persistir no banco na próxima rodada.
    if (mainWindow && (stopResult.killed || stopResult.method === 'pid' || stopResult.method === 'procMap')) {
      mainWindow.webContents.send('close-tab', scriptPath);
      mainWindow.webContents.send('refresh-projects');
    }
    return;
  }

  // Se não temos processo local e não era direcionado, deixa pending para outro servidor
  if (!stopResult.ok && stopResult.reason === 'no_local_process' && !targetServerId) {
    // Se o status no DB pertence a ESTE servidor, tratamos como stop idempotente (garantir stopped + consumir)
    let dbRow = null;
    try {
      dbRow = await getProjectStatus(scriptPath);
    } catch (e) {
      console.warn(`[RemoteCmd] Stop: falha ao ler project_status (mantendo pending). script=${scriptPath} err=${e?.message || e}`);
      return;
    }
    const dbServer = dbRow?.server_id;

    if (dbServer && dbServer !== currentServerId) {
      console.log(`[RemoteCmd] Stop: sem processo local e script é de outro servidor (db.server_id=${dbServer}). Mantendo pending: ${scriptPath}`);
      return;
    }

    if (dbServer === currentServerId) {
      const pathSegments = scriptPath.split(path.sep);
      const projectName = pathSegments[pathSegments.length - 3] || 'Unknown';
      const scriptName = path.basename(scriptPath, path.extname(scriptPath));
      const saved = await saveStatusWithRetry(scriptPath, projectName, scriptName, 'stopped', null, null, null);
      if (!saved) {
        console.warn(`[RemoteCmd] Stop idempotente (server_id=this): falha ao gravar stopped. Mantendo pending: ${scriptPath}`);
        return;
      }
      console.log(`[RemoteCmd] Stop idempotente (server_id=this): atualizado para stopped. Marcando executado: ${scriptPath}`);
      await markRemoteCommandAsExecuted(cmd.id);
      if (mainWindow) {
        mainWindow.webContents.send('close-tab', scriptPath);
        mainWindow.webContents.send('refresh-projects');
      }
      return;
    }

    console.log(`[RemoteCmd] Stop: sem processo local neste servidor (${currentServerId}) e sem server_id confiável. Mantendo pending: ${scriptPath}`);
    return;
  }

  // Se o script pertence a outro servidor (segundo project_status) e não era direcionado, deixa pending
  if (!stopResult.ok && stopResult.reason === 'different_server' && !targetServerId) {
    console.log(`[RemoteCmd] Stop: script de outro servidor. Mantendo comando pending: ${scriptPath}`);
    return;
  }

  // Se o comando é direcionado para ESTE servidor e não há processo local, trate como stop idempotente (sucesso)
  if (!stopResult.ok && stopResult.reason === 'no_local_process' && targetServerId === currentServerId) {
    const pathSegments = scriptPath.split(path.sep);
    const projectName = pathSegments[pathSegments.length - 3] || 'Unknown';
    const scriptName = path.basename(scriptPath, path.extname(scriptPath));
    const saved = await saveStatusWithRetry(scriptPath, projectName, scriptName, 'stopped', null, null, null);
    if (!saved) {
      console.warn(`[RemoteCmd] Stop direcionado (idempotente): falha ao gravar stopped. Mantendo pending: ${scriptPath}`);
      return;
    }
    console.log(`[RemoteCmd] Stop direcionado: sem processo local (idempotente). Atualizado para stopped e marcando executado: ${scriptPath}`);
    await markRemoteCommandAsExecuted(cmd.id);
    if (mainWindow) {
      mainWindow.webContents.send('close-tab', scriptPath);
      mainWindow.webContents.send('refresh-projects');
    }
    return;
  }

  if (!stopResult.ok) {
    const msg = `[${AGENT_ID}] Falha ao parar via comando remoto. reason=${stopResult.reason} pid=${stopResult.pid ?? '??'} script=${scriptPath}`;
    await markRemoteCommandAsFailed(cmd.id, msg);
    return;
  }

  await markRemoteCommandAsExecuted(cmd.id);
  if (mainWindow) {
    // Mimic UI X: fecha tab quando o stop realmente foi executado aqui
    mainWindow.webContents.send('close-tab', scriptPath);
    mainWindow.webContents.send('refresh-projects');
  }
}

/**
 * Inicia o timer de processamento de comandos remotos (a cada 30 segundos)
 */
function startRemoteCommandsTimer() {
  // Limpar timer existente se houver
  if (remoteCommandsInterval) {
    clearInterval(remoteCommandsInterval);
  }
  
  // Executar primeira verificação após 15 segundos
  setTimeout(() => {
    processRemoteCommands();
  }, 15000);
  
  // Configurar verificação a cada 30 segundos
  remoteCommandsInterval = setInterval(() => {
    processRemoteCommands();
  }, 30 * 1000);
  
  console.log('[RemoteCmd] Timer de comandos remotos iniciado (30 segundos)');
}

/**
 * Para o timer de comandos remotos
 */
function stopRemoteCommandsTimer() {
  if (remoteCommandsInterval) {
    clearInterval(remoteCommandsInterval);
    remoteCommandsInterval = null;
    console.log('[RemoteCmd] Timer de comandos remotos parado');
  }
}

/* ===================== Persistência ===================== */
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
function getPhpPath()      { return loadConfig().phpPath || null; }
function setPhpPath(p)     { const c=loadConfig(); c.phpPath=p; saveConfig(c); }
function getScriptsRoot()  { return loadConfig().scriptsRoot || null; }
function setScriptsRoot(p) { const c=loadConfig(); c.scriptsRoot=p; saveConfig(c); }
function getServerIdCfg()  { return loadConfig().serverId || null; }
function setServerIdCfg(v) { const c=loadConfig(); c.serverId=v; saveConfig(c); }

/* ===================== Dialogs ===================== */
async function choosePhpBinary(forceDialog=false) {
  if (!forceDialog && process.env.PHP_BIN) {
    setPhpPath(process.env.PHP_BIN);
    return process.env.PHP_BIN;
  }
  const filters = process.platform === 'win32'
    ? [{ name: 'PHP', extensions: ['exe'] }]
    : [{ name: 'PHP', extensions: ['*'] }];
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione o executável do PHP',
    properties: ['openFile'],
    filters
  });
  if (res.canceled || !res.filePaths?.length) return null;
  const php = res.filePaths[0];
  setPhpPath(php);
  return php;
}

async function ensurePhpForRun() {
  if (process.env.PHP_BIN) return process.env.PHP_BIN;
  let php = getPhpPath();
  if (php) return php;
  php = await choosePhpBinary(true);
  return php;
}

async function chooseScriptsDir() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione a PASTA RAIZ dos projetos (ex.: C:\\Repositorios\\Trabalho)',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths?.length) return null;
  const dir = res.filePaths[0];
  setScriptsRoot(dir);
  return dir;
}

function resolveScriptsRoot() {
  const dir = getScriptsRoot();
  if (!dir) return null;
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  } catch {}
  return null;
}

/* ===================== Menu ===================== */
function buildMenu() {
  const template = [
    {
      label: 'Configurações',
      submenu: [        
        { label: 'Configurar Servidor…', click: async () => { await showServerIdConfig(); } },
        { type: 'separator' },
        { label: 'Configurar PHP…', click: async () => { await choosePhpBinary(true); } },
        { type: 'separator' },
        { label: 'Configurar Pasta RAIZ…', click: async () => { await chooseScriptsDir(); } },
        { label: 'Abrir Pasta RAIZ', click: () => { const d=getScriptsRoot(); if (d) shell.openPath(d); } },
        { type: 'separator' },
        { label: 'Configurar MySQL…', click: async () => { await showMySQLConfig(); } },
        { type: 'separator' },
        { role: 'quit', label: 'Sair' }
      ]
    },
    {
      label: 'Exibir',
      submenu: [
        { role: 'reload', label: 'Recarregar' },
        { role: 'toggleDevTools', label: 'Exibir DevTools' },
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/* ===================== MySQL Configuration Dialog ===================== */
async function showMySQLConfig() {
  if (!mainWindow) return;
  
  // Carregar configuração atual
  const currentConfig = loadMySQLConfig();
  
  // Criar HTML para o diálogo
  const configWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 500,
    height: 550,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'Configurar MySQL',
    autoHideMenuBar: true
  });
  
  // HTML do formulário de configuração
  const configHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          padding: 20px;
          margin: 0;
          background: #f5f5f5;
        }
        .container {
          background: white;
          padding: 25px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h2 {
          margin-top: 0;
          color: #333;
          font-size: 20px;
        }
        .form-group {
          margin-bottom: 15px;
        }
        label {
          display: block;
          margin-bottom: 5px;
          color: #555;
          font-weight: 500;
          font-size: 14px;
        }
        input {
          width: 100%;
          padding: 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 14px;
          box-sizing: border-box;
        }
        input:focus {
          outline: none;
          border-color: #4CAF50;
        }
        .button-group {
          display: flex;
          gap: 10px;
          margin-top: 25px;
        }
        button {
          flex: 1;
          padding: 12px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.2s;
        }
        .btn-test {
          background: #2196F3;
          color: white;
        }
        .btn-test:hover {
          background: #1976D2;
        }
        .btn-save {
          background: #4CAF50;
          color: white;
        }
        .btn-save:hover {
          background: #45a049;
        }
        .btn-cancel {
          background:#6c757d; 
          color:white;
        }
        .btn-cancel:hover {
          background:#6c757d; 
          color:white;
        }
        .message {
          margin-top: 15px;
          padding: 10px;
          border-radius: 4px;
          font-size: 14px;
          display: none;
        }
        .message.success {
          background: #d4edda;
          color: #155724;
          border: 1px solid #c3e6cb;
          display: block;
        }
        .message.error {
          background: #f8d7da;
          color: #721c24;
          border: 1px solid #f5c6cb;
          display: block;
        }
        .hint {
          font-size: 12px;
          color: #888;
          margin-top: 3px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🗄️ Configuração do MySQL</h2>
        <form id="configForm">
          <div class="form-group">
            <label for="host">Host:</label>
            <input type="text" id="host" value="${currentConfig.host}" required>
            <div class="hint">Ex: localhost ou 192.168.1.10</div>
          </div>
          
          <div class="form-group">
            <label for="port">Porta:</label>
            <input type="number" id="port" value="${currentConfig.port}" required>
            <div class="hint">Porta padrão: 3306</div>
          </div>
          
          <div class="form-group">
            <label for="user">Usuário:</label>
            <input type="text" id="user" value="${currentConfig.user}" required>
            <div class="hint">Ex: root</div>
          </div>
          
          <div class="form-group">
            <label for="password">Senha:</label>
            <input type="password" id="password" value="${currentConfig.password}">
            <div class="hint">Deixe em branco se não tiver senha</div>
          </div>
          
          <div class="form-group">
            <label for="database">Banco de Dados:</label>
            <input type="text" id="database" value="${currentConfig.database}" required>
            <div class="hint">Nome: rochasystem_central</div>
          </div>
          
          <div class="button-group">
            <button type="button" class="btn-test" onclick="testConnection()"> Testar conexão</button>
            <button type="submit" class="btn-save">Salvar</button>
          </div>
          
          <div id="message" class="message"></div>
        </form>
      </div>
      
      <script>
        const { ipcRenderer } = require('electron');
        
        function getFormData() {
          return {
            host: document.getElementById('host').value,
            port: parseInt(document.getElementById('port').value),
            user: document.getElementById('user').value,
            password: document.getElementById('password').value,
            database: document.getElementById('database').value
          };
        }
        
        function showMessage(text, type) {
          const msg = document.getElementById('message');
          msg.textContent = text;
          msg.className = 'message ' + type;
        }
        
        async function testConnection() {
          const config = getFormData();
          showMessage('Testando conexão...', 'success');
          
          try {
            const result = await ipcRenderer.invoke('test-mysql-connection', config);
            if (result.success) {
              showMessage('✅ ' + result.message, 'success');
            } else {
              showMessage('❌ Erro: ' + result.message, 'error');
            }
          } catch (error) {
            showMessage('❌ Erro: ' + error.message, 'error');
          }
        }
        
        document.getElementById('configForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const config = getFormData();
          
          showMessage('Salvando configuração...', 'success');
          
          try {
            const result = await ipcRenderer.invoke('save-mysql-config', config);
            if (result.success) {
              showMessage('✅ ' + result.message, 'success');
              setTimeout(() => {
                window.close();
              }, 1500);
            } else {
              showMessage('❌ Erro: ' + result.message, 'error');
            }
          } catch (error) {
            showMessage('❌ Erro: ' + error.message, 'error');
          }
        });
        
        function closeWindow() {
          window.close();
        }
      </script>
    </body>
    </html>
  `;
  
  configWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(configHTML));
}

/* ===================== Server ID Configuration Dialog ===================== */
async function showServerIdConfig() {
  if (!mainWindow) return;

  const current = getServerIdCfg() || AGENT_HOST;

  const serverWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 500,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'Configurar Servidor',
    autoHideMenuBar: true
  });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; padding: 20px; margin: 0; background: #f5f5f5; }
        .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h2 { margin-top: 0; color: #333; font-size: 18px; }
        label { display:block; margin: 10px 0 6px; color:#555; font-weight:500; font-size: 14px; }
        input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; box-sizing: border-box; }
        .hint { font-size: 12px; color: #888; margin-top: 6px; line-height: 1.4; }
        .buttons { display:flex; gap:10px; margin-top: 16px; }
        button { flex:1; padding: 10px; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; }
        .save { background:#4CAF50; color:white; }
        .cancel { background:#6c757d; color:white; }
        .message { margin-top: 12px; padding: 8px; border-radius: 4px; display:none; font-size: 13px; }
        .message.success { display:block; background:#d4edda; color:#155724; border:1px solid #c3e6cb; }
        .message.error { display:block; background:#f8d7da; color:#721c24; border:1px solid #f5c6cb; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🖥️ Identificação do Servidor</h2>
        <label for="serverId">Servidor atual (serverId)</label>
        <input id="serverId" value="${String(current).replace(/\"/g,'&quot;')}" />
        <div class="hint">
          Esta identificação é usada para filtrar comandos da tabela <b>remote_commands</b> quando <code>target_server_id</code> estiver preenchido.<br/>
          Se vazio, o sistema usará o hostname: <b>${AGENT_HOST}</b>.
        </div>
        <div class="buttons">
          <button class="save" id="saveBtn">Salvar</button>
          <button class="cancel" id="cancelBtn">Cancelar</button>
        </div>
        <div id="msg" class="message"></div>
      </div>
      <script>
        const { ipcRenderer } = require('electron');
        const msgEl = document.getElementById('msg');
        function showMsg(text, type) {
          msgEl.textContent = text;
          msgEl.className = 'message ' + type;
        }
        document.getElementById('cancelBtn').addEventListener('click', () => window.close());
        document.getElementById('saveBtn').addEventListener('click', async () => {
          const v = document.getElementById('serverId').value.trim();
          try {
            const res = await ipcRenderer.invoke('save-server-id', v);
            if (res.success) {
              showMsg('✅ Salvo! Reinicie a aplicação para garantir que todos os timers usem o novo serverId.', 'success');
              setTimeout(() => window.close(), 1300);
            } else {
              showMsg('❌ ' + res.message, 'error');
            }
          } catch (e) {
            showMsg('❌ ' + (e.message || e), 'error');
          }
        });
      </script>
    </body>
    </html>
  `;

  serverWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow () {
  buildMenu();
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    icon: path.join(__dirname, 'newlogo.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
}

/**
 * Sincroniza status no banco ao iniciar a aplicação
 * Scripts com status 'running' mas sem processo ativo são marcados como 'stopped'
 */
async function syncOrphanProcessesOnStartup() {
  try {
    console.log('[Startup] Verificando processos órfãos...');
    
    const allStatuses = await getAllProjectStatuses();
    let orphanCount = 0;
    const currentServerId = getCurrentServerId();
    
    for (const status of allStatuses) {
      // MULTI-SERVIDOR: só trata scripts deste servidor (ou sem server_id)
      if (status.server_id && status.server_id !== currentServerId) continue;

      // Se o banco diz 'running' mas não há processo no procMap
      if (status.status === 'running' && !procMap[status.script_path]) {
        // Se há PID vivo, não marca stopped (pode ser um órfão ainda rodando)
        if (status.pid && isPidAlive(status.pid)) {
          console.warn(`[Startup] PID ainda vivo para ${status.script_name} (pid=${status.pid}). Mantendo status running.`);
          continue;
        }

        console.log(`[Startup] Processo órfão detectado: ${status.script_name}`);
        
        // Atualizar para 'stopped' pois a aplicação não tem controle sobre ele
        await saveStatusWithRetry(status.script_path, status.project_name, status.script_name, 'stopped', null, null, null);
        
        orphanCount++;
      }
    }
    
    if (orphanCount > 0) {
      console.log(`[Startup] ${orphanCount} processo(s) órfão(s) marcado(s) como 'stopped'`);
    } else {
      console.log('[Startup] Nenhum processo órfão encontrado');
    }
  } catch (error) {
    console.error('[Startup] Erro ao sincronizar processos órfãos:', error.message);
  }
}

app.whenReady().then(async () => {
  try {
    await initDatabase();
    console.log('[App] Banco de dados MySQL inicializado');
    
    // Sincronizar processos órfãos ao iniciar
    await syncOrphanProcessesOnStartup();
    
    // Iniciar timer de sincronização
    startSyncTimer();
    
    // Iniciar timer de comandos remotos
    startRemoteCommandsTimer();
    
    // Limpar comandos remotos antigos (7 dias)
    cleanOldRemoteCommands(7).catch(err => 
      console.error('[App] Erro ao limpar comandos antigos:', err.message)
    );
  } catch (error) {
    console.error('[App] Erro ao inicializar MySQL:', error.message);
    dialog.showErrorBox(
      'Erro de Conexão MySQL',
      `Não foi possível conectar ao banco de dados MySQL.\n\nErro: ${error.message}\n\nPor favor, configure a conexão MySQL no menu Arquivo > Configurar MySQL.`
    );
  }
  createWindow();
});

/**
 * Para todos os scripts em execução
 */
async function stopAllRunningScripts() {
  const runningScripts = Object.keys(procMap);
  
  if (runningScripts.length === 0) {
    console.log('[Shutdown] Nenhum script rodando');
    return;
  }
  
  console.log(`[Shutdown] Parando ${runningScripts.length} script(s) em execução...`);
  
  // Parar todos os scripts
  for (const scriptPath of runningScripts) {
    const entry = procMap[scriptPath];
    if (!entry) continue;
    
    const { process: child, logStream } = entry;
    const pathSegments = scriptPath.split(path.sep);
    const projectName = pathSegments[pathSegments.length - 3] || 'Unknown';
    const scriptName = path.basename(scriptPath, path.extname(scriptPath));
    
    console.log(`[Shutdown] Parando: ${scriptName}`);
    
    // Marcar como manualmente parado
    if (procMap[scriptPath]) {
      procMap[scriptPath].manuallyStopped = true;
    }
    
    // Cancelar timer de auto-restart se houver
    if (scheduleTimers[scriptPath]) {
      clearTimeout(scheduleTimers[scriptPath]);
      delete scheduleTimers[scriptPath];
    }
    
    // Adicionar mensagem no log
    const msg = `\n[SHUTDOWN] Script parado automaticamente ao fechar aplicação\n`;
    try { logStream.write(msg); } catch {}

    const result = await killAndWaitForExit(child, { gracefulMs: 400, forceMs: 6000 });
    if (!result.ok) {
      console.error(`[Shutdown] Falha ao parar ${scriptName} (pid=${result.pid ?? child?.pid ?? '??'}). Processo pode permanecer órfão.`);
      // Não marcar stopped para não mentir (processo pode continuar vivo)
      await saveStatusWithRetry(scriptPath, projectName, scriptName, 'running', null, null, child?.pid ?? undefined);
    } else {
      await saveStatusWithRetry(scriptPath, projectName, scriptName, 'stopped', null, null, null);
    }
  }
  
  // Limpar procMap
  Object.keys(procMap).forEach(key => delete procMap[key]);
  
  console.log('[Shutdown] Todos os scripts foram parados');
}

app.on('before-quit', async (event) => {
  // Prevenir fechamento imediato
  event.preventDefault();
  
  console.log('[Shutdown] Aplicação sendo fechada...');
  
  try {
    // Parar todos os scripts primeiro
    await stopAllRunningScripts();
    
    // Parar timers
    stopSyncTimer();
    stopRemoteCommandsTimer();
    
    // Fechar conexão com banco
    await closeDatabase();
    
    console.log('[Shutdown] Shutdown completo!');
  } catch (error) {
    console.error('[Shutdown] Erro durante shutdown:', error.message);
  }
  
  // Agora sim, permitir fechar
  app.exit(0);
});

/* ===================== Helpers ===================== */

// indexSascarA -> "Index Sascar A"
// index_sascar_a -> "Index Sascar A"
// index-sascar-a -> "Index Sascar A"
function toFriendlyTitle(raw) {
  if (!raw) return raw;

  // Normaliza separadores comuns
  let s = String(raw).replace(/[_-]+/g, ' ').trim();

  // Separa camelCase/PascalCase: "indexSascarA" -> "index Sascar A"
  s = s.replace(/(?<!^)([A-Z])/g, ' $1');

  // Colapsa espaços
  s = s.replace(/\s+/g, ' ').trim();

  // Capitaliza, preservando siglas já em maiúsculo (ex.: API, GPS)
  return s
    .split(' ')
    .map(w => {
      if (!w) return w;
      // Mantém siglas (2+ letras todas maiúsculas) e números
      if (/^[A-Z0-9]{2,}$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}


function friendlyTitleForPhp(fullPath, defaultTitle) {
  let title = defaultTitle;
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines   = content.split(/\r?\n/);
    // Support both PHP (//) and batch (REM or ::) comment styles
    const m = lines.find(l => /^\s*(\/\/|#|REM|::)\s*title\s*:/i.test(l));
    if (m) title = m.replace(/^\s*(\/\/|#|REM|::)\s*title\s*:/i, '').trim();
  } catch {}
  // If no title found, use filename without extension
  if (title === defaultTitle) {
    title = path.basename(fullPath, path.extname(fullPath));
  }
  return toFriendlyTitle(title);
}

function walkPhpFiles(dir, acc, baseDir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  entries.forEach(ent => {
    const p = path.join(dir, ent.name);
    // pula algumas pastas comuns sem utilidade para execução
    if (ent.isDirectory()) {
      if (['vendor', '.git', 'node_modules', 'storage', 'cache'].includes(ent.name.toLowerCase())) return;
      walkPhpFiles(p, acc, baseDir);
    } else if (ent.isFile() && (/\.php$/i.test(ent.name) || /\.bat$/i.test(ent.name))) {
      const rel = path.relative(baseDir, p); // relativo ao public/
      acc.push({ full: p, rel });
    }
  });
  return acc;
}

/* ===================== Listagem: RAIZ\projeto\public\*.php (recursivo) ===================== */
const procMap = {}; // { fullPath: { process, logStream, exitCode } }

ipcMain.handle('list-bats', async () => { // mantemos o canal por compatibilidade
  let root = resolveScriptsRoot();
  if (!root) {
    root = await chooseScriptsDir();
    if (!root) return {};
  }

  const map = {};
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {
    console.error('[list-bats] readdirSync falhou:', e?.message || e);
    return {};
  }

  // Process entries sequentially to avoid race conditions
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const projDir   = path.join(root, ent.name);
    const publicDir = path.join(projDir, 'public');
    const batsDir   = path.join(projDir, 'bats');
    
    let found = [];
    
    // Look for PHP files in public/ directory
    if (fs.existsSync(publicDir) && fs.statSync(publicDir).isDirectory()) {
      const phpFiles = walkPhpFiles(publicDir, [], publicDir);
      found = found.concat(phpFiles);
    }
    
    // Look for .bat files in bats/ directory (new structure)
    if (fs.existsSync(batsDir) && fs.statSync(batsDir).isDirectory()) {
      const batFiles = walkPhpFiles(batsDir, [], batsDir); // walkPhpFiles now finds both .php and .bat
      found = found.concat(batFiles);
    }
    
    if (!found.length) continue;

    map[ent.name] = await Promise.all(found.map(async ({ full, rel }) => {
      const dbStatus = await getProjectStatus(full);
      return {
        name: friendlyTitleForPhp(full, rel.replace(/\\/g,'/')),
        path: full,
        running: !!procMap[full],
        exitCode: procMap[full]?.exitCode,
        dbStatus: dbStatus ? {
          status: dbStatus.status,
          exitCode: dbStatus.exit_code,
          startedAt: dbStatus.started_at,
          finishedAt: dbStatus.finished_at,
          lastLogFile: dbStatus.last_log_file
        } : null
      };
    }));
  }

  return map;
});

/* ===================== Execução e Logs ===================== */
function writeBoth(evt, fullPath, logStream, chunk) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  // Evita ERR_STREAM_WRITE_AFTER_END: stdout/stderr podem emitir dados após exit → logStream já foi end()
  if (logStream && logStream.writable) {
    try { logStream.write(text); } catch (_) {}
  }
  try {
    evt.reply('terminal-output', { batPath: fullPath, data: text });
  } catch (_) { /* renderer pode ter fechado */ }
}

async function runScript(evt, fullPath) {
  if (procMap[fullPath]) {
    evt.reply('focus-tab', fullPath);
    return true;
  }
  
  // Extract project and script names
  const pathSegments = fullPath.split(path.sep);
  const projectName = pathSegments[pathSegments.length - 3] || 'Unknown';
  const scriptName = path.basename(fullPath, path.extname(fullPath));
  
  const cwd = path.dirname(fullPath);

  // logs: ao lado do arquivo (…/public/<subpasta>) em "logs"
  const logsDir = path.join(cwd, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  const stamp   = new Date().toISOString().replace(/[-:T]/g,'').slice(0,15);
  const base    = path.basename(fullPath, path.extname(fullPath));
  const logFile = path.join(logsDir, `${base}-${stamp}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  logStream.write(`==== START ${new Date().toLocaleString()} ====\n`);

  // Check if this is a .bat file - if so, execute it directly with cmd.exe
  const isBatFile = /\.bat$/i.test(fullPath);
  let phpPath = null;
  if (!isBatFile) {
    phpPath = await ensurePhpForRun();
    if (!phpPath) {
      writeBoth(evt, fullPath, logStream, "[ERRO] Caminho do PHP não definido.\n");
      try { logStream.end(); } catch {}
      return false;
    }
  }

  let child;
  if (isBatFile) {
    logStream.write(`ENGINE: cmd.exe /c (bat file)\n`);
    child = spawn('cmd.exe', ['/c', fullPath], { cwd, windowsHide: false, shell: true });
  } else {
    logStream.write(`ENGINE: ${phpPath} (php)\n`);
    child = spawn(phpPath, [fullPath], { cwd, windowsHide: false });
  }

  procMap[fullPath] = { process: child, logStream, exitCode: null, manuallyStopped: false };
  
  // Save to database (retries). If it fails, cancel execution to keep consistency.
  const saved = await saveStatusWithRetry(fullPath, projectName, scriptName, 'running', null, logFile, child.pid);
  if (!saved) {
    const msg = "[ERRO] Não foi possível salvar status 'running' no banco. Execução cancelada para manter consistência.\n";
    writeBoth(evt, fullPath, logStream, msg);
    try { child.kill(); } catch {}
    try { logStream.end(); } catch {}
    delete procMap[fullPath];
    return false;
  }
  
  evt.reply('bat-started', fullPath);

  child.stdout.on('data', (buf) => writeBoth(evt, fullPath, logStream, buf));
  child.stderr.on('data', (buf) => writeBoth(evt, fullPath, logStream, buf));

  child.on('exit', async (code, signal) => {
    const endedAt = new Date().toLocaleString();
    logStream.write(`\n==== END ${endedAt} (code=${code} signal=${signal || ''}) ====\n`);
    try { logStream.end(); } catch {}
    
    // Check if process was manually stopped
    const wasManuallyStopped = procMap[fullPath]?.manuallyStopped;
    
    // Save to database - if manually stopped, keep status as 'stopped'
    if (!wasManuallyStopped) {
      // Check if script has auto-restart enabled (schedule)
      try {
        const schedule = await getScriptSchedule(fullPath);
        if (schedule && schedule.enabled) {
          const intervalMs = schedule.interval_seconds * 1000;
          console.log(`[Schedule] Agendando próxima execução de ${scriptName} em ${schedule.interval_seconds}s`);
          
          // Clear existing timer if any
          if (scheduleTimers[fullPath]) {
            clearTimeout(scheduleTimers[fullPath]);
          }
          
          // Keep status as 'running' for scheduled scripts (even during interval)
          // Only update exit_code to track if last execution had errors
          // Durante o intervalo (sem processo), limpamos PID para evitar PID reciclado matar processo errado
          await saveStatusWithRetry(fullPath, projectName, scriptName, 'running', code, logFile, null);
          
          // Schedule next execution
          scheduleTimers[fullPath] = setTimeout(() => {
            console.log(`[Schedule] Executando script agendado: ${scriptName}`);
            runScript(evt, fullPath);
            delete scheduleTimers[fullPath];
          }, intervalMs);
        } else {
          // No schedule - save final status (finished or error)
          const status = (code === 0) ? 'finished' : 'error';
          await saveStatusWithRetry(fullPath, projectName, scriptName, status, code, logFile, undefined);
        }
      } catch (error) {
        console.error('[Schedule] Erro ao verificar schedule:', error.message);
        // If error checking schedule, save status anyway
        const status = (code === 0) ? 'finished' : 'error';
        await saveStatusWithRetry(fullPath, projectName, scriptName, status, code, logFile, undefined);
      }
    }
    
    evt.reply('bat-exited', { fullPath, exitCode: code });
    delete procMap[fullPath];
  });

  child.on('error', (err) => {
    const msg = `[ERRO spawn] ${err?.message || err}\n`;
    writeBoth(evt, fullPath, logStream, msg);
  });

  return true;
}

/* ===================== IPC Execução ===================== */
ipcMain.on('run-bat', (evt, fullPath) => runScript(evt, fullPath));

ipcMain.on('run-all', async (evt, projectName) => {
  const root = resolveScriptsRoot();
  if (!root) return;
  const projDir   = path.join(root, projectName);
  const publicDir = path.join(projDir, 'public');
  const batsDir   = path.join(projDir, 'bats');

  let found = [];
  if (fs.existsSync(publicDir) && fs.statSync(publicDir).isDirectory()) {
    found = found.concat(walkPhpFiles(publicDir, [], publicDir));
  }
  if (fs.existsSync(batsDir) && fs.statSync(batsDir).isDirectory()) {
    found = found.concat(walkPhpFiles(batsDir, [], batsDir));
  }

  const files = found.map(o => o.full);
  if (!files.length) return;

  // Mesmo método do clique individual: "run-bat" -> runScript -> grava running -> abre tab
  files.forEach(f => ipcMain.emit('run-bat', evt, f));
});

ipcMain.on('stop-all', async (_evt, projectName) => {
  const root = resolveScriptsRoot();
  if (!root) return;

  const projDir = path.join(root, projectName);
  const prefix = projDir + path.sep;

  // Parar processos rodando + timers de auto-restart (scripts em intervalo)
  const candidates = new Set([
    ...Object.keys(procMap),
    ...Object.keys(scheduleTimers),
  ]);

  const toStop = [...candidates].filter(p => p.startsWith(prefix));
  if (toStop.length === 0) {
    console.log('[stop-all] Nenhum script para parar em:', projectName);
    return;
  }

  console.log(`[stop-all] Parando ${toStop.length} script(s) do projeto: ${projectName}`);

  for (const p of toStop) {
    try {
      // Mesmo método do "X" da tab: fecha UI primeiro, depois para
      if (mainWindow) {
        mainWindow.webContents.send('close-tab', p);
      }
      await stopScriptLikeTabClose(p, {
        reason: 'UI_STOP_ALL',
        closeTabUi: false,
        allowPidFallback: false,
        // UI stop-all é uma intenção local: pode atualizar stopped mesmo se não houver procMap
        updateDbWhenNoLocalProcess: true,
      });
    } catch (e) {
      console.error('[stop-all] Erro ao parar:', p, e?.message || e);
    }
  }

  if (mainWindow) mainWindow.webContents.send('refresh-projects');
});

ipcMain.on('stop-bat', async (_, fullPath) => {
  // Extract project and script names for database
  console.log('[stop-bat] Stopping process:', fullPath);
  
  await stopScriptLikeTabClose(fullPath, {
    reason: 'UI_STOP',
    closeTabUi: false, // a UI já remove a tab antes de chamar stop-bat
    allowPidFallback: false,
  });

  // A UI recarrega a lista imediatamente (antes do processo morrer). Envie refresh ao final
  // para atualizar ícones (⏹/▶) conforme o estado real após parar.
  if (mainWindow) {
    mainWindow.webContents.send('refresh-projects');
  }
});

// MySQL configuration endpoints
ipcMain.handle('get-mysql-config', async () => {
  return loadMySQLConfig();
});

ipcMain.handle('save-mysql-config', async (_, config) => {
  const saved = saveMySQLConfig(config);
  if (saved) {
    // Reinitialize database with new config
    try {
      await closeDatabase();
      await initDatabase();
      return { success: true, message: 'Configuração salva e conexão reinicializada!' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
  return { success: false, message: 'Erro ao salvar configuração' };
});

ipcMain.handle('test-mysql-connection', async (_, config) => {
  return await testConnection(config);
});

ipcMain.handle('save-server-id', async (_, serverId) => {
  try {
    const v = String(serverId || '').trim();
    // allow empty (fallback to hostname)
    setServerIdCfg(v || '');
    return { success: true, message: 'OK' };
  } catch (e) {
    return { success: false, message: e?.message || String(e) };
  }
});

// Schedule management endpoints
ipcMain.handle('get-script-schedule', async (_, scriptPath) => {
  return await getScriptSchedule(scriptPath);
});

ipcMain.handle('save-script-schedule', async (_, scriptPath, enabled, intervalSeconds) => {
  const saved = await saveScriptSchedule(scriptPath, enabled, intervalSeconds);
  
  // If disabling, clear any pending timer
  if (!enabled && scheduleTimers[scriptPath]) {
    clearTimeout(scheduleTimers[scriptPath]);
    delete scheduleTimers[scriptPath];
    console.log(`[Schedule] Timer cancelado para: ${scriptPath}`);
  }
  
  // If enabling and script is not running, start it
  if (enabled && !procMap[scriptPath]) {
    console.log(`[Schedule] Iniciando script agendado: ${scriptPath}`);
    const fakeEvent = {
      reply: (channel, data) => {
        if (mainWindow) {
          mainWindow.webContents.send(channel, data);
        }
      }
    };
    await runScript(fakeEvent, scriptPath);
  }
  
  return { success: saved, message: saved ? 'Agendamento salvo com sucesso!' : 'Erro ao salvar agendamento' };
});

ipcMain.handle('delete-script-schedule', async (_, scriptPath) => {
  // Clear any pending timer
  if (scheduleTimers[scriptPath]) {
    clearTimeout(scheduleTimers[scriptPath]);
    delete scheduleTimers[scriptPath];
    console.log(`[Schedule] Timer cancelado para: ${scriptPath}`);
  }
  
  const deleted = await deleteScriptSchedule(scriptPath);
  return { success: deleted, message: deleted ? 'Agendamento removido!' : 'Erro ao remover agendamento' };
});
