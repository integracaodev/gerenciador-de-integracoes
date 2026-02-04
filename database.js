// database.js - Módulo de conexão e operações MySQL
const mysql = require('mysql2/promise');
const { loadMySQLConfig } = require('./db-config');

let pool = null;

/**
 * Inicializa o pool de conexões MySQL
 */
async function initDatabase() {
  try {
    const config = loadMySQLConfig();
    
    console.log('[MySQL] Conectando ao banco de dados...');
    console.log(`[MySQL] Host: ${config.host}:${config.port}`);
    console.log(`[MySQL] Database: ${config.database}`);
    
    pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
    
    // Testa a conexão
    const connection = await pool.getConnection();
    await connection.ping();
    console.log('[MySQL] Conexão estabelecida com sucesso!');
    connection.release();
    
    // Cria a tabela se não existir
    await createTableIfNotExists();
    
    return true;
  } catch (error) {
    console.error('[MySQL] Erro ao conectar:', error.message);
    throw error;
  }
}

/**
 * Cria a tabela de status dos projetos se não existir
 */
async function createTableIfNotExists() {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS project_status (
      id INT AUTO_INCREMENT PRIMARY KEY,
      script_path VARCHAR(500) NOT NULL UNIQUE,
      project_name VARCHAR(255) NOT NULL,
      script_name VARCHAR(255) NOT NULL,
      server_id VARCHAR(120) NULL,
      status ENUM('running', 'finished', 'error', 'stopped') NOT NULL,
      pid INT NULL,
      exit_code INT NULL,
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      last_log_file VARCHAR(500) NULL,
      auto_restart_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      auto_restart_interval INT NOT NULL DEFAULT 30 COMMENT 'Intervalo em segundos entre execuções',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_script_path (script_path),
      INDEX idx_server_id (server_id),
      INDEX idx_status (status),
      INDEX idx_project_name (project_name),
      INDEX idx_auto_restart (auto_restart_enabled),
      INDEX idx_pid (pid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
  
  const createRemoteCommandsTableSQL = `
    CREATE TABLE IF NOT EXISTS remote_commands (
      id INT AUTO_INCREMENT PRIMARY KEY,
      script_path VARCHAR(500) NOT NULL,
      command ENUM('start', 'stop') NOT NULL,
      status ENUM('pending', 'executed', 'failed') NOT NULL DEFAULT 'pending',
      target_server_id VARCHAR(120) NULL,
      requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      executed_at DATETIME NULL,
      error_message TEXT NULL,
      requested_by VARCHAR(100) NULL,
      INDEX idx_status (status),
      INDEX idx_script_path (script_path),
      INDEX idx_target_server_id (target_server_id),
      INDEX idx_requested_at (requested_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
  
  try {
    await pool.query(createTableSQL);
    console.log('[MySQL] Tabela project_status verificada/criada');
    
    await pool.query(createRemoteCommandsTableSQL);
    console.log('[MySQL] Tabela remote_commands verificada/criada');
  } catch (error) {
    console.error('[MySQL] Erro ao criar tabela:', error.message);
    throw error;
  }
}

/**
 * Salva ou atualiza o status de um projeto
 */
async function saveProjectStatus(scriptPath, projectName, scriptName, status, exitCode = null, logFile = null, pid = undefined, serverId = undefined) {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return false;
  }

  async function saveInternal({ includeExtras }) {
    const now = new Date();
    
    // Verifica se já existe
    const [existing] = await pool.query(
      'SELECT id, started_at FROM project_status WHERE script_path = ?',
      [scriptPath]
    );
    
    if (existing.length > 0) {
      // Atualiza registro existente
      let updateFields = {
        status: status,
        exit_code: exitCode,
        updated_at: now
      };
      
      if (status === 'running') {
        updateFields.started_at = now;
        updateFields.finished_at = null;
        if (includeExtras) {
          // Atualiza PID/agent quando fornecidos
          // pid pode ser null aqui para LIMPAR (ex.: status "running" sem processo durante intervalo)
          if (pid !== undefined) updateFields.pid = pid;
          if (serverId !== undefined) updateFields.server_id = serverId;
        }
      }
      
      if (status === 'finished' || status === 'error' || status === 'stopped') {
        updateFields.finished_at = now;
        if (includeExtras) {
          // Ao encerrar, PID deve ser limpo sempre
          updateFields.pid = null;
        }
      }
      
      if (logFile) {
        updateFields.last_log_file = logFile;
      }
      
      const setClause = Object.keys(updateFields).map(key => `${key} = ?`).join(', ');
      const values = Object.values(updateFields);
      values.push(scriptPath);
      
      await pool.query(
        `UPDATE project_status SET ${setClause} WHERE script_path = ?`,
        values
      );
      
      console.log('[MySQL] Status atualizado:', { scriptPath, status, exitCode });
    } else {
      // Insere novo registro
      if (includeExtras) {
        const pidToInsert = status === 'running' ? (pid ?? null) : null;
        const serverToInsert = serverId ?? null;
        await pool.query(
          `INSERT INTO project_status 
          (script_path, project_name, script_name, server_id, status, pid, exit_code, started_at, last_log_file, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            scriptPath,
            projectName,
            scriptName,
            serverToInsert,
            status,
            pidToInsert,
            exitCode,
            status === 'running' ? now : null,
            logFile,
            now,
            now
          ]
        );
      } else {
        await pool.query(
          `INSERT INTO project_status 
          (script_path, project_name, script_name, status, exit_code, started_at, last_log_file, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            scriptPath,
            projectName,
            scriptName,
            status,
            exitCode,
            status === 'running' ? now : null,
            logFile,
            now,
            now
          ]
        );
      }
      
      console.log('[MySQL] Status inserido:', { scriptPath, status });
    }
    
    return true;
  }

  try {
    return await saveInternal({ includeExtras: true });
  } catch (error) {
    const msg = String(error?.message || error);
    // Backward-compat: bancos antigos podem não ter pid/server_id ainda
    if (/unknown column/i.test(msg) && (msg.includes('pid') || msg.includes('server_id'))) {
      console.warn('[MySQL] Colunas extras (pid/server_id) não existem ainda; salvando sem elas.');
      try {
        return await saveInternal({ includeExtras: false });
      } catch (e2) {
        console.error('[MySQL] Erro ao salvar status (fallback):', String(e2?.message || e2));
        return false;
      }
    }
    console.error('[MySQL] Erro ao salvar status:', msg);
    return false;
  }
}

/**
 * Obtém o status de um projeto específico
 */
async function getProjectStatus(scriptPath) {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return null;
  }
  
  try {
    const [rows] = await pool.query(
      'SELECT * FROM project_status WHERE script_path = ?',
      [scriptPath]
    );
    
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('[MySQL] Erro ao buscar status:', error.message);
    return null;
  }
}

/**
 * Obtém todos os status de projetos
 */
async function getAllProjectStatuses() {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return [];
  }
  
  try {
    const [rows] = await pool.query(
      'SELECT * FROM project_status ORDER BY updated_at DESC'
    );
    
    return rows;
  } catch (error) {
    console.error('[MySQL] Erro ao buscar todos os status:', error.message);
    return [];
  }
}

/**
 * Fecha o pool de conexões
 */
async function closeDatabase() {
  if (pool) {
    try {
      await pool.end();
      console.log('[MySQL] Conexão fechada');
    } catch (error) {
      console.error('[MySQL] Erro ao fechar conexão:', error.message);
    }
  }
}

/**
 * Testa a conexão com o banco de dados
 */
async function testConnection(config) {
  try {
    const testPool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 1
    });
    
    const connection = await testPool.getConnection();
    await connection.ping();
    connection.release();
    await testPool.end();
    
    return { success: true, message: 'Conexão estabelecida com sucesso!' };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

/* ===================== Remote Commands ===================== */

/**
 * Obtém comandos remotos pendentes
 */
async function getPendingRemoteCommands() {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return [];
  }
  
  try {
    const [rows] = await pool.query(
      "SELECT * FROM remote_commands WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 50"
    );
    
    return rows;
  } catch (error) {
    console.error('[MySQL] Erro ao buscar comandos remotos:', error.message);
    return [];
  }
}

/**
 * Marca um comando remoto como executado
 */
async function markRemoteCommandAsExecuted(commandId) {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return false;
  }
  
  try {
    await pool.query(
      "UPDATE remote_commands SET status = 'executed', executed_at = NOW() WHERE id = ?",
      [commandId]
    );
    
    console.log('[MySQL] Comando remoto marcado como executado:', commandId);
    return true;
  } catch (error) {
    console.error('[MySQL] Erro ao marcar comando como executado:', error.message);
    return false;
  }
}

/**
 * Marca um comando remoto como falho
 */
async function markRemoteCommandAsFailed(commandId, errorMessage) {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return false;
  }
  
  try {
    await pool.query(
      "UPDATE remote_commands SET status = 'failed', executed_at = NOW(), error_message = ? WHERE id = ?",
      [errorMessage, commandId]
    );
    
    console.log('[MySQL] Comando remoto marcado como falho:', commandId);
    return true;
  } catch (error) {
    console.error('[MySQL] Erro ao marcar comando como falho:', error.message);
    return false;
  }
}

/**
 * Limpa comandos remotos antigos (executados há mais de X dias)
 */
async function cleanOldRemoteCommands(daysOld = 7) {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return false;
  }
  
  try {
    const [result] = await pool.query(
      "DELETE FROM remote_commands WHERE status IN ('executed', 'failed') AND requested_at < DATE_SUB(NOW(), INTERVAL ? DAY)",
      [daysOld]
    );
    
    console.log(`[MySQL] Comandos remotos antigos removidos: ${result.affectedRows}`);
    return result.affectedRows;
  } catch (error) {
    console.error('[MySQL] Erro ao limpar comandos antigos:', error.message);
    return false;
  }
}

/* ===================== Script Auto-Restart ===================== */

/**
 * Obtém configuração de auto-restart de um script
 */
async function getScriptSchedule(scriptPath) {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return null;
  }
  
  try {
    const [rows] = await pool.query(
      "SELECT auto_restart_enabled AS enabled, auto_restart_interval AS interval_seconds FROM project_status WHERE script_path = ?",
      [scriptPath]
    );
    
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('[MySQL] Erro ao buscar auto-restart:', error.message);
    return null;
  }
}

/**
 * Salva ou atualiza configuração de auto-restart
 */
async function saveScriptSchedule(scriptPath, enabled, intervalSeconds) {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return false;
  }
  
  try {
    await pool.query(
      `UPDATE project_status SET auto_restart_enabled = ?, auto_restart_interval = ? WHERE script_path = ?`,
      [enabled, intervalSeconds, scriptPath]
    );
    
    console.log('[MySQL] Auto-restart salvo:', scriptPath, enabled, intervalSeconds);
    return true;
  } catch (error) {
    console.error('[MySQL] Erro ao salvar auto-restart:', error.message);
    return false;
  }
}

/**
 * Remove configuração de auto-restart
 */
async function deleteScriptSchedule(scriptPath) {
  if (!pool) {
    console.error('[MySQL] Pool não inicializado');
    return false;
  }
  
  try {
    await pool.query(
      "UPDATE project_status SET auto_restart_enabled = FALSE WHERE script_path = ?",
      [scriptPath]
    );
    
    console.log('[MySQL] Auto-restart desabilitado:', scriptPath);
    return true;
  } catch (error) {
    console.error('[MySQL] Erro ao desabilitar auto-restart:', error.message);
    return false;
  }
}

module.exports = {
  initDatabase,
  saveProjectStatus,
  getProjectStatus,
  getAllProjectStatuses,
  closeDatabase,
  testConnection,
  getPendingRemoteCommands,
  markRemoteCommandAsExecuted,
  markRemoteCommandAsFailed,
  cleanOldRemoteCommands,
  getScriptSchedule,
  saveScriptSchedule,
  deleteScriptSchedule
};
