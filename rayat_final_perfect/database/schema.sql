-- Rayat IoT Platform - Database Schema
-- MySQL 5.7+ / MariaDB 10.2+

-- Drop existing tables if recreating
DROP TABLE IF EXISTS active_alerts;
DROP TABLE IF EXISTS alert_thresholds;
DROP TABLE IF EXISTS sensor_readings;
DROP TABLE IF EXISTS sensors;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS users;
DROP VIEW IF EXISTS user_dashboard;
DROP VIEW IF EXISTS latest_sensor_readings;
DROP TABLE IF EXISTS sensor_latest;

-- =====================================================
-- USERS TABLE
-- =====================================================
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) UNIQUE NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  language VARCHAR(5) DEFAULT 'it',
  phone VARCHAR(20),
  crop_type VARCHAR(100),
  latitude DECIMAL(10, 7),
  longitude DECIMAL(10, 7),
  location_name VARCHAR(255),
  location_address VARCHAR(255),
  verification_code VARCHAR(10),
  is_verified BOOLEAN DEFAULT FALSE,
  role ENUM('admin', 'farmer', 'client', 'super_admin', 'operator', 'operator_admin') DEFAULT 'client',
  client_code VARCHAR(20),
  payment_status ENUM('pagato','non_pagato') DEFAULT 'non_pagato',
  payment_date DATETIME NULL,
  subscription_expiry DATETIME NULL,
  registration_status ENUM('new','active') NOT NULL DEFAULT 'active',
  registration_source VARCHAR(20) NOT NULL DEFAULT 'legacy',
  approved_at DATETIME NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_role (role),
  INDEX idx_users_role_active_created (role, active, created_at),
  INDEX idx_users_client_code (client_code),
  INDEX idx_users_location_name (location_name),
  INDEX idx_users_registration_feed (registration_source, registration_status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- PASSWORD RESETS TABLE
-- =====================================================
CREATE TABLE password_resets (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_password_resets_token_hash (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- DEVICES TABLE (Router IoT + Sensori)
-- =====================================================
CREATE TABLE devices (
  id INT PRIMARY KEY AUTO_INCREMENT,
  device_id VARCHAR(100) UNIQUE NOT NULL,
  user_id INT NOT NULL,
  name VARCHAR(100),
  api_key VARCHAR(255) NOT NULL,
  location VARCHAR(255),
  status ENUM('active', 'inactive', 'error') DEFAULT 'active',
  last_seen TIMESTAMP NULL,
  metadata JSON COMMENT 'Info extra: modello, firmware, batteria, etc.',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_device_id (device_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_devices_user_status_last_seen (user_id, status, last_seen),
  INDEX idx_devices_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- SENSORS TABLE
-- =====================================================
CREATE TABLE sensors (
  id INT PRIMARY KEY AUTO_INCREMENT,
  device_id INT NOT NULL,
  type ENUM('energia', 'acqua', 'terreno', 'clima') NOT NULL,
  subtype VARCHAR(50) COMMENT 'es: terreno_moisture, terreno_ph, clima_temp, clima_humidity',
  name VARCHAR(100),
  unit VARCHAR(20),
  calibration_offset DECIMAL(10, 4) DEFAULT 0 COMMENT 'Offset calibrazione sensore',
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  INDEX idx_device_type (device_id, type),
  INDEX idx_enabled (enabled),
  INDEX idx_sensors_device_enabled_type (device_id, enabled, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- SENSOR READINGS TABLE (Dati sensori)
-- =====================================================
CREATE TABLE sensor_readings (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  sensor_id INT NOT NULL,
  value DECIMAL(10, 2) NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSON COMMENT 'Dati extra: qualità segnale, batteria, temperatura interna, etc.',
  FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE CASCADE,
  INDEX idx_sensor_time (sensor_id, timestamp DESC),
  INDEX idx_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Partitioning per performance (opzionale, per produzione con molti dati)
-- ALTER TABLE sensor_readings PARTITION BY RANGE (UNIX_TIMESTAMP(timestamp)) (
--   PARTITION p_2026_01 VALUES LESS THAN (UNIX_TIMESTAMP('2026-02-01')),
--   PARTITION p_2026_02 VALUES LESS THAN (UNIX_TIMESTAMP('2026-03-01')),
--   ...
-- );

-- =====================================================
-- ALERT THRESHOLDS TABLE (Soglie allarmi)
-- =====================================================
CREATE TABLE alert_thresholds (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  sensor_type VARCHAR(50) NOT NULL COMMENT 'es: energia, acqua, terreno_moisture, clima_temp',
  threshold_type ENUM('min', 'max') NOT NULL,
  threshold_value DECIMAL(10, 2) NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_sensor (user_id, sensor_type),
  INDEX idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- ACTIVE ALERTS TABLE (Allarmi attivi)
-- =====================================================
CREATE TABLE active_alerts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  sensor_id INT NOT NULL,
  alert_type ENUM('warning', 'critical') NOT NULL,
  message VARCHAR(255),
  reading_value DECIMAL(10, 2),
  threshold_value DECIMAL(10, 2),
  acknowledged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TIMESTAMP NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE CASCADE,
  INDEX idx_user_unack (user_id, acknowledged),
  INDEX idx_created (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- VIEWS per query comuni
-- =====================================================

-- Vista per ultimi valori di ogni sensore
CREATE OR REPLACE VIEW latest_sensor_readings AS
SELECT 
  sr.id,
  sr.sensor_id,
  s.device_id,
  s.type,
  s.subtype,
  s.name,
  s.unit,
  sr.value,
  sr.timestamp,
  sr.metadata
FROM sensor_readings sr
INNER JOIN sensors s ON sr.sensor_id = s.id
WHERE sr.timestamp = (
  SELECT MAX(timestamp) 
  FROM sensor_readings 
  WHERE sensor_id = sr.sensor_id
)
AND s.enabled = TRUE;

-- Vista per dashboard completa utente
CREATE OR REPLACE VIEW user_dashboard AS
SELECT 
  u.id as user_id,
  u.name as user_name,
  d.id as device_id,
  d.device_id as device_code,
  d.name as device_name,
  d.status as device_status,
  d.last_seen,
  s.id as sensor_id,
  s.type as sensor_type,
  s.subtype as sensor_subtype,
  s.name as sensor_name,
  s.unit as sensor_unit,
  lsr.value as latest_value,
  lsr.timestamp as latest_timestamp
FROM users u
LEFT JOIN devices d ON u.id = d.user_id
LEFT JOIN sensors s ON d.id = s.device_id
LEFT JOIN latest_sensor_readings lsr ON s.id = lsr.sensor_id
WHERE s.enabled = TRUE OR s.enabled IS NULL;

-- =====================================================
-- SENSOR LATEST TABLE (Valori in tempo reale)
-- =====================================================
CREATE TABLE IF NOT EXISTS sensor_latest (
  sensor_id INT PRIMARY KEY,
  value DECIMAL(10,2) NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (sensor_id) REFERENCES sensors(id)
    ON DELETE CASCADE,
  INDEX idx_sensor_latest_timestamp (timestamp)
);

-- Pulizia automatica dati vecchi ogni notte alle 2:00
CREATE EVENT IF NOT EXISTS cleanup_old_readings
ON SCHEDULE EVERY 1 DAY
STARTS (TIMESTAMP(CURRENT_DATE) + INTERVAL 2 HOUR)
DO
  DELETE FROM sensor_readings
  WHERE timestamp < DATE_SUB(NOW(), INTERVAL 1 YEAR);
