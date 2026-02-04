ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY '';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;

SET sql_mode = REPLACE(@@sql_mode, 'STRICT_TRANS_TABLES', '');
SET SESSION sql_mode = 'ALLOW_INVALID_DATES';

CREATE DATABASE IF NOT EXISTS rochasystem_central;
