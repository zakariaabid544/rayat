-- Rayat Admin Panel - Safe Database Migration
-- Run this ONCE against your existing database
-- It ONLY adds new role values - no data loss, no table recreation

-- Step 1: Extend the role ENUM to include super_admin and operator
ALTER TABLE users 
MODIFY COLUMN role ENUM('admin', 'farmer', 'client', 'super_admin', 'operator') 
DEFAULT 'client';

-- Step 2: Verify the change
-- SELECT DISTINCT role FROM users;
