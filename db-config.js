// db-config.js - Configuração da conexão MySQL
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_FILE = path.join(app.getPath('userData'), 'mysql-config.json');

// Configurações padrão do MySQL
const DEFAULT_CONFIG = {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: '',
  database: 'rochasystem_central'
};

/**
 * Carrega a configuração do MySQL do arquivo
 */
function loadMySQLConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error('[MySQL Config] Erro ao carregar configuração:', e);
  }
  return DEFAULT_CONFIG;
}

/**
 * Salva a configuração do MySQL no arquivo
 */
function saveMySQLConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log('[MySQL Config] Configuração salva com sucesso');
    return true;
  } catch (e) {
    console.error('[MySQL Config] Erro ao salvar configuração:', e);
    return false;
  }
}

module.exports = {
  loadMySQLConfig,
  saveMySQLConfig,
  DEFAULT_CONFIG
};
