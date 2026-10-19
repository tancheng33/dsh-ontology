-- MySQL test schema: same business domain as the PostgreSQL one
--
-- Load with an explicit charset, or the Chinese labels double-encode:
--   docker exec -i dsh-mysql-test mysql -uroot -ptestpass business \
--     --default-character-set=utf8mb4 < schema-mysql.sql
-- (the `mysql` client defaults to latin1 when stdin is not a terminal).

DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS suppliers;

CREATE TABLE teams (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  region      VARCHAR(50),
  deleted_at  DATETIME NULL
) ENGINE=InnoDB;

CREATE TABLE users (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  full_name   VARCHAR(100) NOT NULL,
  email       VARCHAR(100),
  phone       VARCHAR(30),
  status      VARCHAR(20),
  bio         TEXT,
  team_id     INT,
  manager_id  INT,
  CONSTRAINT fk_users_team    FOREIGN KEY (team_id)    REFERENCES teams(id),
  CONSTRAINT fk_users_manager FOREIGN KEY (manager_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE suppliers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  company_name  VARCHAR(100) NOT NULL,
  contact_email VARCHAR(100),
  country       VARCHAR(10)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  order_no    VARCHAR(50) NOT NULL,
  amount      DECIMAL(12,2),
  status      VARCHAR(20),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_id     INT NOT NULL,
  supplier_id INT NOT NULL,
  CONSTRAINT fk_orders_user     FOREIGN KEY (user_id)     REFERENCES users(id),
  CONSTRAINT fk_orders_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
) ENGINE=InnoDB;

INSERT INTO teams (id, name, region) VALUES
  (1, 'Platform',   'cn-north'),
  (2, 'Payments',   'cn-east'),
  (3, 'Deprecated', 'cn-south');
UPDATE teams SET deleted_at = NOW() WHERE id = 3;

INSERT INTO users (id, full_name, email, phone, status, bio, team_id, manager_id) VALUES
  (1, '张三', 'ZhangSan@Example.COM', ' 138-0000-0001 ', 'active',   '平台组负责人', 1, NULL),
  (2, '李四', 'lisi@example.com',     '138-0000-0002',   'active',   NULL,           1, 1),
  (3, '王五', 'wangwu@example.com',   '138-0000-0003',   'inactive', '已离职',       2, 1),
  (4, '赵六', 'zhaoliu@example.com',  NULL,              'active',   NULL,           2, 2);

INSERT INTO suppliers (id, company_name, contact_email, country) VALUES
  (101, '阿里云', 'ali@cloud.example.com',     'CN'),
  (102, '腾讯云', 'tencent@cloud.example.com', 'CN'),
  (103, 'AWS',    'aws@cloud.example.com',     'US');

INSERT INTO orders (id, order_no, amount, status, user_id, supplier_id) VALUES
  (1001, 'ORD-2026-001', 5000.00, 'paid',      1, 101),
  (1002, 'ORD-2026-002', 3000.00, 'paid',      1, 102),
  (1003, 'ORD-2026-003', 8000.00, 'pending',   1, 103),
  (1004, 'ORD-2026-004', 1200.00, 'paid',      2, 101),
  (1005, 'ORD-2026-005', 4500.00, 'cancelled', 3, 102);
