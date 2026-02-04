USE rochasystem_central;

DROP TABLE IF EXISTS project_status;

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

DROP TABLE IF EXISTS remote_commands;

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