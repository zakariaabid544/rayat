-- Rayat IoT Platform - Seed Data
-- Dati di esempio per testing e demo

-- =====================================================
-- DEMO USER
-- =====================================================
-- Password: demo123 (hashed con bcrypt)
INSERT INTO users (email, password_hash, name, language, role, client_code, payment_status, payment_date, subscription_expiry) VALUES
('demo@rayat.ma', '$2b$10$VZ.Vkc08VcvlvHUUOabAbe6Sb3hU1w.dSiUqqIZimHwW5kf9ms1XC', 'Mario Rossi', 'it', 'client', '0001', 'pagato', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY));

SET @demo_user_id = LAST_INSERT_ID();

-- =====================================================
-- DEMO DEVICE
-- =====================================================
INSERT INTO devices (device_id, user_id, name, api_key, location, status, last_seen) VALUES
('RAYAT_DEVICE_001', @demo_user_id, 'Campo Principale', 'demo_api_key_12345', 'Agadir, Morocco', 'active', NOW());

SET @demo_device_id = LAST_INSERT_ID();

-- =====================================================
-- SENSORS
-- =====================================================

-- Sensore Energia
INSERT INTO sensors (device_id, type, subtype, name, unit) VALUES
(@demo_device_id, 'energia', 'energia_consumption', 'Consumo Pompa Irrigazione', 'kW'),
(@demo_device_id, 'energia', 'energia_daily', 'Energia Giornaliera', 'kWh'),
(@demo_device_id, 'energia', 'energia_cost', 'Costo Energia', 'DH');

-- Sensore Acqua
INSERT INTO sensors (device_id, type, subtype, name, unit) VALUES
(@demo_device_id, 'acqua', 'acqua_level', 'Livello Pozzo GL801', 'm'),
(@demo_device_id, 'acqua', 'acqua_pressure', 'Pressione Acqua', 'bar');

-- Sensore Terreno 7-in-1
INSERT INTO sensors (device_id, type, subtype, name, unit) VALUES
(@demo_device_id, 'terreno', 'terreno_moisture', 'Umidità Terreno', '%'),
(@demo_device_id, 'terreno', 'terreno_temperature', 'Temperatura Terreno', '°C'),
(@demo_device_id, 'terreno', 'terreno_ec', 'Conducibilità Elettrica', 'dS/m'),
(@demo_device_id, 'terreno', 'terreno_ph', 'pH Terreno', 'pH'),
(@demo_device_id, 'terreno', 'terreno_nitrogen', 'Azoto (N)', 'ppm'),
(@demo_device_id, 'terreno', 'terreno_phosphorus', 'Fosforo (P)', 'ppm'),
(@demo_device_id, 'terreno', 'terreno_potassium', 'Potassio (K)', 'ppm');

-- Sensore Clima
INSERT INTO sensors (device_id, type, subtype, name, unit) VALUES
(@demo_device_id, 'clima', 'clima_temperature', 'Temperatura Ambiente', '°C'),
(@demo_device_id, 'clima', 'clima_humidity', 'Umidità Relativa', '%'),
(@demo_device_id, 'clima', 'clima_wind', 'Velocità Vento', 'km/h');

-- =====================================================
-- SENSOR READINGS - Ultimi 30 giorni
-- =====================================================

-- Funzione helper per generare timestamp negli ultimi 30 giorni
SET @days_back = 30;

-- ENERGIA: Consumo pompa (varia tra 2.0 e 2.6 kW)
INSERT INTO sensor_readings (sensor_id, value, timestamp)
SELECT 
  (SELECT id FROM sensors WHERE subtype = 'energia_consumption' LIMIT 1),
  ROUND(2.0 + (RAND() * 0.6), 2),
  DATE_SUB(NOW(), INTERVAL n DAY) + INTERVAL FLOOR(RAND() * 24) HOUR
FROM (
  SELECT 0 AS n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 
  UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 
  UNION SELECT 12 UNION SELECT 13 UNION SELECT 14 UNION SELECT 15 UNION SELECT 16 UNION SELECT 17 
  UNION SELECT 18 UNION SELECT 19 UNION SELECT 20 UNION SELECT 21 UNION SELECT 22 UNION SELECT 23 
  UNION SELECT 24 UNION SELECT 25 UNION SELECT 26 UNION SELECT 27 UNION SELECT 28 UNION SELECT 29
) days;

-- ACQUA: Livello pozzo (varia tra 13.8 e 15.0 m, trend discendente)
INSERT INTO sensor_readings (sensor_id, value, timestamp)
SELECT 
  (SELECT id FROM sensors WHERE subtype = 'acqua_level' LIMIT 1),
  ROUND(15.0 - (n * 0.04) + (RAND() * 0.3 - 0.15), 2),
  DATE_SUB(NOW(), INTERVAL n DAY) + INTERVAL FLOOR(RAND() * 24) HOUR
FROM (
  SELECT 0 AS n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 
  UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 
  UNION SELECT 12 UNION SELECT 13 UNION SELECT 14 UNION SELECT 15 UNION SELECT 16 UNION SELECT 17 
  UNION SELECT 18 UNION SELECT 19 UNION SELECT 20 UNION SELECT 21 UNION SELECT 22 UNION SELECT 23 
  UNION SELECT 24 UNION SELECT 25 UNION SELECT 26 UNION SELECT 27 UNION SELECT 28 UNION SELECT 29
) days;

-- TERRENO: Umidità (varia tra 55% e 65%)
INSERT INTO sensor_readings (sensor_id, value, timestamp)
SELECT 
  (SELECT id FROM sensors WHERE subtype = 'terreno_moisture' LIMIT 1),
  ROUND(55 + (RAND() * 10), 0),
  DATE_SUB(NOW(), INTERVAL n DAY) + INTERVAL FLOOR(RAND() * 24) HOUR
FROM (
  SELECT 0 AS n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 
  UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 
  UNION SELECT 12 UNION SELECT 13 UNION SELECT 14 UNION SELECT 15 UNION SELECT 16 UNION SELECT 17 
  UNION SELECT 18 UNION SELECT 19 UNION SELECT 20 UNION SELECT 21 UNION SELECT 22 UNION SELECT 23 
  UNION SELECT 24 UNION SELECT 25 UNION SELECT 26 UNION SELECT 27 UNION SELECT 28 UNION SELECT 29
) days;

-- TERRENO: Temperatura (varia tra 20°C e 24°C)
INSERT INTO sensor_readings (sensor_id, value, timestamp)
SELECT 
  (SELECT id FROM sensors WHERE subtype = 'terreno_temperature' LIMIT 1),
  ROUND(20 + (RAND() * 4), 1),
  DATE_SUB(NOW(), INTERVAL n DAY) + INTERVAL FLOOR(RAND() * 24) HOUR
FROM (
  SELECT 0 AS n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 
  UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 
  UNION SELECT 12 UNION SELECT 13 UNION SELECT 14 UNION SELECT 15 UNION SELECT 16 UNION SELECT 17 
  UNION SELECT 18 UNION SELECT 19 UNION SELECT 20 UNION SELECT 21 UNION SELECT 22 UNION SELECT 23 
  UNION SELECT 24 UNION SELECT 25 UNION SELECT 26 UNION SELECT 27 UNION SELECT 28 UNION SELECT 29
) days;

-- CLIMA: Temperatura ambiente (varia tra 25°C e 35°C)
INSERT INTO sensor_readings (sensor_id, value, timestamp)
SELECT 
  (SELECT id FROM sensors WHERE subtype = 'clima_temperature' LIMIT 1),
  ROUND(25 + (RAND() * 10), 1),
  DATE_SUB(NOW(), INTERVAL n DAY) + INTERVAL FLOOR(RAND() * 24) HOUR
FROM (
  SELECT 0 AS n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 
  UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 
  UNION SELECT 12 UNION SELECT 13 UNION SELECT 14 UNION SELECT 15 UNION SELECT 16 UNION SELECT 17 
  UNION SELECT 18 UNION SELECT 19 UNION SELECT 20 UNION SELECT 21 UNION SELECT 22 UNION SELECT 23 
  UNION SELECT 24 UNION SELECT 25 UNION SELECT 26 UNION SELECT 27 UNION SELECT 28 UNION SELECT 29
) days;

-- CLIMA: Umidità relativa (varia tra 40% e 60%)
INSERT INTO sensor_readings (sensor_id, value, timestamp)
SELECT 
  (SELECT id FROM sensors WHERE subtype = 'clima_humidity' LIMIT 1),
  ROUND(40 + (RAND() * 20), 0),
  DATE_SUB(NOW(), INTERVAL n DAY) + INTERVAL FLOOR(RAND() * 24) HOUR
FROM (
  SELECT 0 AS n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 
  UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 
  UNION SELECT 12 UNION SELECT 13 UNION SELECT 14 UNION SELECT 15 UNION SELECT 16 UNION SELECT 17 
  UNION SELECT 18 UNION SELECT 19 UNION SELECT 20 UNION SELECT 21 UNION SELECT 22 UNION SELECT 23 
  UNION SELECT 24 UNION SELECT 25 UNION SELECT 26 UNION SELECT 27 UNION SELECT 28 UNION SELECT 29
) days;

-- Altri sensori terreno (valori statici per semplicità)
INSERT INTO sensor_readings (sensor_id, value, timestamp)
SELECT id, 
  CASE subtype
    WHEN 'terreno_ec' THEN 1.2
    WHEN 'terreno_ph' THEN 7.2
    WHEN 'terreno_nitrogen' THEN 120
    WHEN 'terreno_phosphorus' THEN 45
    WHEN 'terreno_potassium' THEN 180
    WHEN 'energia_daily' THEN 18.4
    WHEN 'energia_cost' THEN 24.7
    WHEN 'acqua_pressure' THEN 4.2
    WHEN 'clima_wind' THEN 12
  END,
  NOW()
FROM sensors
WHERE subtype IN ('terreno_ec', 'terreno_ph', 'terreno_nitrogen', 'terreno_phosphorus', 
                  'terreno_potassium', 'energia_daily', 'energia_cost', 'acqua_pressure', 'clima_wind');

-- =====================================================
-- ALERT THRESHOLDS (Soglie allarmi)
-- =====================================================
INSERT INTO alert_thresholds (user_id, sensor_type, threshold_type, threshold_value, enabled) VALUES
(@demo_user_id, 'energia_consumption', 'max', 2.2, TRUE),
(@demo_user_id, 'acqua_level', 'min', 5.0, TRUE),
(@demo_user_id, 'terreno_moisture', 'min', 40.0, TRUE),
(@demo_user_id, 'clima_temperature', 'max', 32.0, TRUE),
(@demo_user_id, 'clima_temperature', 'min', 10.0, TRUE);

-- =====================================================
-- SUMMARY
-- =====================================================
SELECT 'Database seeded successfully!' as status;
SELECT COUNT(*) as total_users FROM users;
SELECT COUNT(*) as total_devices FROM devices;
SELECT COUNT(*) as total_sensors FROM sensors;
SELECT COUNT(*) as total_readings FROM sensor_readings;
SELECT COUNT(*) as total_thresholds FROM alert_thresholds;
