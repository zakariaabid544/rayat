-- Subscription Management Migration
-- Add payment tracking columns to users table

ALTER TABLE users ADD COLUMN payment_status ENUM('pagato','non_pagato') DEFAULT 'non_pagato';
ALTER TABLE users ADD COLUMN payment_date DATETIME NULL;
ALTER TABLE users ADD COLUMN subscription_expiry DATETIME NULL;
