'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const ORDER_STATUSES = Object.freeze([
  'Pending',
  'Accepted',
  'Rejected',
  'Payment Pending',
  'Paid',
  'Completed',
  'Cancelled',
]);

const DEFAULT_PRODUCTS = Object.freeze([
  {
    key: 'minecraft',
    name: 'Minecraft Java + Bedrock',
    buttonLabel: 'Minecraft Java + Bedrock',
    ticketName: 'Minecraft Java + Bedrock',
    priceCents: 1300,
  },
  {
    key: 'digital_service',
    name: 'خدمة رقمية مرخّصة',
    buttonLabel: 'خدمة رقمية مرخّصة',
    ticketName: 'خدمة رقمية مرخّصة',
    priceCents: 800,
  },
]);

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
}

function sqlColumn(columns, name, fallback) {
  return columns.has(name) ? `o."${name}"` : fallback;
}

function needsLegacyMigration(db) {
  const orderTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'",
  ).get();
  const ticketTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'",
  ).get();
  if (!orderTable || !ticketTable) return false;

  const orderColumns = columnsOf(db, 'orders');
  const ticketColumns = columnsOf(db, 'tickets');
  return !orderTable.sql.includes("'Payment Pending'") ||
    !['quantity', 'unit_price_cents', 'customer_confirmed', 'accepted_by', 'rejected_by',
      'announcement_started_at']
      .every((column) => orderColumns.has(column)) ||
    /order_id\s+INTEGER\s+UNIQUE/i.test(ticketTable.sql) ||
    !ticketTable.sql.includes('UNIQUE(order_id, kind)') ||
    !['interaction_id', 'guild_id', 'customer_id', 'kind', 'order_id', 'channel_id',
      'channel_name', 'status', 'created_at', 'closed_at'].every((column) => ticketColumns.has(column));
}

function migrateLegacyTables(db) {
  if (!needsLegacyMigration(db)) return;

  const orderColumns = columnsOf(db, 'orders');
  const ticketColumns = columnsOf(db, 'tickets');
  const status = 'lower(o.status)';
  const mappedStatus = `CASE
    WHEN ${status} IN ('pending', 'accepted', 'rejected', 'payment pending', 'paid', 'completed', 'cancelled')
      THEN CASE ${status}
        WHEN 'pending' THEN 'Pending'
        WHEN 'accepted' THEN 'Accepted'
        WHEN 'rejected' THEN 'Rejected'
        WHEN 'payment pending' THEN 'Payment Pending'
        WHEN 'paid' THEN 'Paid'
        WHEN 'completed' THEN 'Completed'
        ELSE 'Cancelled'
      END
    WHEN ${status} = 'rejected' THEN 'Rejected'
    WHEN ${status} = 'cancelled' THEN 'Cancelled'
    WHEN ${status} = 'paid' THEN 'Paid'
    WHEN ${status} = 'completed' THEN 'Completed'
    WHEN ${status} IN ('awaiting_payment', 'proof_submitted', 'open', 'closed_unpaid', 'closed')
      THEN CASE WHEN ${status} IN ('closed_unpaid', 'closed') THEN 'Cancelled' ELSE 'Payment Pending' END
    WHEN ${status} = 'ticket_creating' THEN 'Accepted'
    ELSE 'Pending'
  END`;
  const confirmed = `CASE WHEN ${status} IN (
    'pending_approval', 'ticket_creating', 'open', 'awaiting_payment',
    'proof_submitted', 'paid', 'completed', 'accepted', 'payment pending'
  ) THEN 1 ELSE 0 END`;
  const oldStatus = sqlColumn(orderColumns, 'legacy_status', `CASE
    WHEN ${status} IN ('pending', 'accepted', 'rejected', 'payment pending', 'paid', 'completed', 'cancelled') THEN NULL
    ELSE o.status
  END`);
  const paymentMethod = orderColumns.has('payment_method')
    ? 'o.payment_method'
    : orderColumns.has('payment_preference')
      ? "CASE o.payment_preference WHEN 'crypto' THEN 'LTC' WHEN 'staff' THEN 'Manual' ELSE NULL END"
      : 'NULL';
  const oldOrderCode = orderColumns.has('order_code')
    ? "COALESCE(NULLIF(o.order_code, ''), 'VM-' || printf('%06d', o.id))"
    : "'VM-' || printf('%06d', o.id)";

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE orders_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interaction_id TEXT NOT NULL UNIQUE,
        order_code TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        product_key TEXT NOT NULL,
        product_name TEXT NOT NULL,
        button_label TEXT,
        ticket_name TEXT,
        quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
        price_cents INTEGER NOT NULL CHECK (price_cents > 0),
        status TEXT NOT NULL CHECK (status IN (
          'Pending', 'Accepted', 'Rejected', 'Payment Pending', 'Paid', 'Completed', 'Cancelled'
        )),
        customer_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (customer_confirmed IN (0, 1)),
        payment_method TEXT,
        staff_message_id TEXT UNIQUE,
        ticket_channel_id TEXT UNIQUE,
        ticket_channel_name TEXT,
        ticket_creation_started_at INTEGER,
        discussion_creation_started_at INTEGER,
        announcement_started_at INTEGER,
        accepted_by TEXT,
        rejected_by TEXT,
        rejection_reason TEXT,
        paid_by TEXT,
        completed_by TEXT,
        discussion_channel_id TEXT UNIQUE,
        legacy_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO orders_v2 (
        id, interaction_id, order_code, guild_id, customer_id, product_key, product_name,
        button_label, ticket_name, quantity, unit_price_cents, price_cents, status,
        customer_confirmed, payment_method, staff_message_id, ticket_channel_id,
        ticket_channel_name, ticket_creation_started_at, accepted_by, rejected_by,
        rejection_reason, paid_by, completed_by, discussion_channel_id, announcement_started_at, legacy_status,
        created_at, updated_at
      )
      SELECT
        o.id,
        ${sqlColumn(orderColumns, 'interaction_id', `('legacy-' || o.id)`)},
        ${oldOrderCode},
        ${sqlColumn(orderColumns, 'guild_id', "'unknown'")},
        ${sqlColumn(orderColumns, 'customer_id', "'unknown'")},
        ${sqlColumn(orderColumns, 'product_key', "'legacy'")},
        ${sqlColumn(orderColumns, 'product_name', "'منتج قديم'")},
        ${sqlColumn(orderColumns, 'button_label', sqlColumn(orderColumns, 'product_name', "'منتج قديم'"))},
        ${sqlColumn(orderColumns, 'ticket_name', sqlColumn(orderColumns, 'product_name', "'منتج قديم'"))},
        ${sqlColumn(orderColumns, 'quantity', '1')},
        ${sqlColumn(orderColumns, 'unit_price_cents', sqlColumn(orderColumns, 'price_cents', '100'))},
        ${sqlColumn(orderColumns, 'price_cents', sqlColumn(orderColumns, 'unit_price_cents', '100'))},
        ${mappedStatus},
        ${sqlColumn(orderColumns, 'customer_confirmed', confirmed)},
        ${paymentMethod},
        ${sqlColumn(orderColumns, 'staff_message_id', 'NULL')},
        ${sqlColumn(orderColumns, 'ticket_channel_id', 'NULL')},
        ${sqlColumn(orderColumns, 'ticket_channel_name', 'NULL')},
        ${sqlColumn(orderColumns, 'ticket_creation_started_at', 'NULL')},
        ${sqlColumn(orderColumns, 'accepted_by', 'NULL')},
        ${sqlColumn(orderColumns, 'rejected_by', 'NULL')},
        ${sqlColumn(orderColumns, 'rejection_reason', 'NULL')},
        ${sqlColumn(orderColumns, 'paid_by', 'NULL')},
        ${sqlColumn(orderColumns, 'completed_by', 'NULL')},
        ${sqlColumn(orderColumns, 'discussion_channel_id',
          `CASE WHEN ${status} IN ('open', 'awaiting_payment', 'proof_submitted', 'paid', 'completed') THEN ${sqlColumn(orderColumns, 'ticket_channel_id', 'NULL')} ELSE NULL END`)},
        ${sqlColumn(orderColumns, 'announcement_started_at', 'NULL')},
        ${oldStatus},
        ${sqlColumn(orderColumns, 'created_at', '0')},
        ${sqlColumn(orderColumns, 'updated_at', '0')}
      FROM orders o;

      CREATE TABLE tickets_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interaction_id TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'purchase', 'support')),
        order_id INTEGER REFERENCES orders_v2(id),
        channel_id TEXT UNIQUE,
        channel_name TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'closing', 'closed')),
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        UNIQUE(order_id, kind)
      );
      INSERT INTO tickets_v2 (
        id, interaction_id, guild_id, customer_id, kind, order_id,
        channel_id, channel_name, status, created_at, closed_at
      )
      SELECT
        ${sqlColumn(ticketColumns, 'id', 'rowid')},
        ${sqlColumn(ticketColumns, 'interaction_id', `('legacy-ticket-' || rowid)`)},
        ${sqlColumn(ticketColumns, 'guild_id', "'unknown'")},
        ${sqlColumn(ticketColumns, 'customer_id', "'unknown'")},
        ${sqlColumn(ticketColumns, 'kind', "'purchase'")},
        ${sqlColumn(ticketColumns, 'order_id', 'NULL')},
        ${sqlColumn(ticketColumns, 'channel_id', 'NULL')},
        ${sqlColumn(ticketColumns, 'channel_name', `('legacy-ticket-' || rowid)`)},
        ${sqlColumn(ticketColumns, 'status', "'closed'")},
        ${sqlColumn(ticketColumns, 'created_at', '0')},
        ${sqlColumn(ticketColumns, 'closed_at', 'NULL')}
      FROM tickets o;

      DROP TABLE tickets;
      DROP TABLE orders;
      ALTER TABLE orders_v2 RENAME TO orders;
      ALTER TABLE tickets_v2 RENAME TO tickets;
    `);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function createDatabase(databasePath = process.env.DATABASE_PATH?.trim() || path.join(__dirname, 'data', 'vanta-market.sqlite')) {
  const resolvedPath = databasePath === ':memory:' ? databasePath : path.resolve(__dirname, databasePath);
  if (resolvedPath !== ':memory:') fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrateLegacyTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interaction_id TEXT NOT NULL UNIQUE,
      order_code TEXT NOT NULL UNIQUE,
      guild_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      product_name TEXT NOT NULL,
      button_label TEXT,
      ticket_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      status TEXT NOT NULL CHECK (status IN (
        'Pending', 'Accepted', 'Rejected', 'Payment Pending', 'Paid', 'Completed', 'Cancelled'
      )),
      customer_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (customer_confirmed IN (0, 1)),
      payment_method TEXT,
      staff_message_id TEXT UNIQUE,
      ticket_channel_id TEXT UNIQUE,
      ticket_channel_name TEXT,
      ticket_creation_started_at INTEGER,
      discussion_creation_started_at INTEGER,
      announcement_started_at INTEGER,
      accepted_by TEXT,
      rejected_by TEXT,
      rejection_reason TEXT,
      paid_by TEXT,
      completed_by TEXT,
      discussion_channel_id TEXT UNIQUE,
      legacy_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interaction_id TEXT NOT NULL UNIQUE,
      guild_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'purchase', 'support')),
      order_id INTEGER REFERENCES orders(id),
      channel_id TEXT UNIQUE,
      channel_name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'closing', 'closed')),
      created_at INTEGER NOT NULL,
      closed_at INTEGER,
      UNIQUE(order_id, kind)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_support_ticket_per_customer
      ON tickets(guild_id, customer_id)
      WHERE kind = 'support' AND status IN ('creating', 'open', 'closing');
    CREATE INDEX IF NOT EXISTS tickets_by_channel_status ON tickets(channel_id, status);
    CREATE INDEX IF NOT EXISTS orders_by_status_created ON orders(status, created_at);
    CREATE TABLE IF NOT EXISTS custom_buttons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      label TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      product_name TEXT NOT NULL,
      button_label TEXT NOT NULL,
      ticket_name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      UNIQUE(guild_id, product_key)
    );
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT NOT NULL,
      setting_key TEXT NOT NULL,
      setting_value TEXT NOT NULL,
      updated_by TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, setting_key)
    );
    CREATE TABLE IF NOT EXISTS admin_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS staff_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS store_panels (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, channel_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      previous_status TEXT,
      new_status TEXT NOT NULL,
      actor_id TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  const oldProducts = db.prepare('SELECT * FROM custom_buttons ORDER BY id').all();
  const importOldProduct = db.prepare(`
    INSERT OR IGNORE INTO products (
      id, guild_id, product_key, product_name, button_label, ticket_name,
      price_cents, created_by, created_at, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const button of oldProducts) {
    importOldProduct.run(
      button.id,
      button.guild_id,
      `legacy_custom_${button.id}`,
      button.label,
      button.label,
      button.label,
      button.price_cents,
      button.created_by,
      button.created_at,
      button.active,
    );
  }
  return db;
}

function withTransaction(db, callback) {
  return db.transaction(callback).immediate();
}

function orderCode(orderId) {
  return `VM-${String(orderId).padStart(6, '0')}`;
}

function logOrderEvent(db, orderId, previousStatus, newStatus, actorId, note = null) {
  db.prepare(`
    INSERT INTO order_events (order_id, previous_status, new_status, actor_id, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(orderId, previousStatus || null, newStatus, actorId || null, note, Date.now());
}

function getSetting(db, guildId, key) {
  return db.prepare('SELECT setting_value FROM guild_settings WHERE guild_id = ? AND setting_key = ?')
    .get(guildId, key)?.setting_value ?? null;
}

function setSetting(db, guildId, key, value, actorId = null) {
  if (value === null || value === undefined || String(value).trim() === '') {
    db.prepare('DELETE FROM guild_settings WHERE guild_id = ? AND setting_key = ?').run(guildId, key);
    return null;
  }
  db.prepare(`
    INSERT INTO guild_settings (guild_id, setting_key, setting_value, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, setting_key) DO UPDATE SET
      setting_value = excluded.setting_value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(guildId, key, String(value).trim(), actorId, Date.now());
  return String(value).trim();
}

function initializeGuildData(db, config) {
  const guildId = config.guildId;
  for (const [key, value] of Object.entries({
    orders_channel_id: config.ordersChannelId,
    ticket_category_id: config.ticketCategoryId,
    mention_user_id: config.orderNotifyUserId,
    owner_id: config.ownerId,
    payment_wallet_ltc: config.paymentWallet,
  })) {
    if (value && !getSetting(db, guildId, key)) setSetting(db, guildId, key, value, 'environment');
  }

  if (config.staffRoleId) {
    db.prepare(`
      INSERT OR IGNORE INTO admin_roles (guild_id, role_id, added_by, created_at)
      VALUES (?, ?, 'environment', ?)
    `).run(guildId, config.staffRoleId, Date.now());
  }

  const insertProduct = db.prepare(`
    INSERT OR IGNORE INTO products (
      guild_id, product_key, product_name, button_label, ticket_name,
      price_cents, created_by, created_at, active
    ) VALUES (?, ?, ?, ?, ?, ?, 'system', ?, 1)
  `);
  for (const product of DEFAULT_PRODUCTS) {
    insertProduct.run(
      guildId, product.key, product.name, product.buttonLabel,
      product.ticketName, product.priceCents, Date.now(),
    );
  }

  const legacyOrders = db.prepare(`
    SELECT id, legacy_status, status FROM orders
    WHERE order_code = '' OR order_code IS NULL
  `).all();
  const updateCode = db.prepare('UPDATE orders SET order_code = ? WHERE id = ?');
  for (const order of legacyOrders) updateCode.run(orderCode(order.id), order.id);
}

function getStaffRoleIds(db, guildId) {
  return db.prepare('SELECT role_id FROM staff_roles WHERE guild_id = ? ORDER BY created_at, role_id')
    .all(guildId).map((row) => row.role_id);
}

function listProducts(db, guildId, activeOnly = true) {
  return db.prepare(`
    SELECT * FROM products WHERE guild_id = ? ${activeOnly ? 'AND active = 1' : ''}
    ORDER BY id ASC
  `).all(guildId);
}

function initialTicketName(order) {
  const productPart = String(order.ticket_name || order.product_name)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36) || 'طلب';
  return `order-${productPart}-${order.customer_id.slice(-4)}-${order.id}`.slice(0, 95);
}

function addProduct(db, guildId, actorId, input) {
  const key = `product_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const result = db.prepare(`
    INSERT INTO products (
      guild_id, product_key, product_name, button_label, ticket_name,
      price_cents, created_by, created_at, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    guildId, key, input.productName, input.buttonLabel, input.ticketName,
    input.priceCents, actorId, Date.now(),
  );
  return db.prepare('SELECT * FROM products WHERE id = ?').get(Number(result.lastInsertRowid));
}

function getProduct(db, guildId, productId, activeOnly = false) {
  return db.prepare(`
    SELECT * FROM products WHERE id = ? AND guild_id = ? ${activeOnly ? 'AND active = 1' : ''}
  `).get(productId, guildId) || null;
}

function updateProduct(db, guildId, productId, changes) {
  const product = getProduct(db, guildId, productId);
  if (!product) return null;
  db.prepare(`
    UPDATE products
    SET product_name = ?, button_label = ?, ticket_name = ?, price_cents = ?
    WHERE id = ? AND guild_id = ?
  `).run(
    changes.productName ?? product.product_name,
    changes.buttonLabel ?? product.button_label,
    changes.ticketName ?? product.ticket_name,
    changes.priceCents ?? product.price_cents,
    productId,
    guildId,
  );
  return getProduct(db, guildId, productId);
}

function removeProduct(db, guildId, productId) {
  const result = db.prepare(`
    UPDATE products SET active = 0 WHERE id = ? AND guild_id = ? AND active = 1
  `).run(productId, guildId);
  return result.changes === 1;
}

function createOrder(db, input) {
  return withTransaction(db, () => {
    const existing = db.prepare(`
      SELECT o.*, t.channel_id AS active_channel_id
      FROM orders o
      LEFT JOIN tickets t ON t.order_id = o.id AND t.kind = 'confirmation' AND t.status = 'open'
      WHERE o.guild_id = ? AND o.customer_id = ?
        AND o.status IN ('Pending', 'Accepted', 'Payment Pending')
      ORDER BY o.id DESC LIMIT 1
    `).get(input.guildId, input.customerId);
    if (existing) return { order: existing, existing: true };

    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO orders (
        interaction_id, order_code, guild_id, customer_id, product_key, product_name,
        button_label, ticket_name, quantity, unit_price_cents, price_cents, status,
        customer_confirmed, created_at, updated_at
      ) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 0, ?, ?)
    `).run(
      input.interactionId,
      input.guildId,
      input.customerId,
      input.product.product_key,
      input.product.product_name,
      input.product.button_label,
      input.product.ticket_name,
      input.quantity,
      input.product.price_cents,
      input.product.price_cents * input.quantity,
      now,
      now,
    );
    const id = Number(result.lastInsertRowid);
    const code = orderCode(id);
    db.prepare('UPDATE orders SET order_code = ? WHERE id = ?').run(code, id);
    logOrderEvent(db, id, null, 'Pending', input.customerId, 'تم إنشاء الطلب');
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    const ticketResult = db.prepare(`
      INSERT INTO tickets (
        interaction_id, guild_id, customer_id, kind, order_id,
        channel_name, status, created_at
      ) VALUES (?, ?, ?, 'confirmation', ?, ?, 'creating', ?)
    `).run(
      `confirmation:${order.id}`,
      order.guild_id,
      order.customer_id,
      order.id,
      initialTicketName(order),
      now,
    );
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(ticketResult.lastInsertRowid));
    return { order, ticket, existing: false };
  });
}

function createInitialTicketReservation(db, order) {
  return withTransaction(db, () => {
    const existing = db.prepare(`
      SELECT * FROM tickets WHERE order_id = ? AND kind = 'confirmation'
    `).get(order.id);
    if (existing) return existing;
    const name = initialTicketName(order);
    const result = db.prepare(`
      INSERT INTO tickets (
        interaction_id, guild_id, customer_id, kind, order_id,
        channel_name, status, created_at
      ) VALUES (?, ?, ?, 'confirmation', ?, ?, 'creating', ?)
    `).run(`confirmation:${order.id}`, order.guild_id, order.customer_id, order.id, name, Date.now());
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(result.lastInsertRowid));
  });
}

function saveInitialTicketChannel(db, ticketId, channelId) {
  return withTransaction(db, () => {
    const result = db.prepare(`
      UPDATE tickets SET channel_id = ?, status = 'open'
      WHERE id = ? AND status IN ('creating', 'open')
    `).run(channelId, ticketId);
    return result.changes === 1 ? db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) : null;
  });
}

function cancelInitialOrder(db, orderId, actorId, note) {
  return withTransaction(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order || !['Pending'].includes(order.status)) return null;
    const result = db.prepare(`
      UPDATE orders SET status = 'Cancelled', updated_at = ?
      WHERE id = ? AND status = 'Pending'
    `).run(Date.now(), orderId);
    if (result.changes !== 1) return null;
    logOrderEvent(db, orderId, order.status, 'Cancelled', actorId, note);
    return order;
  });
}

function selectPaymentMethod(db, input) {
  const result = db.prepare(`
    UPDATE orders SET payment_method = 'LTC', updated_at = ?
    WHERE id = ? AND guild_id = ? AND customer_id = ?
      AND status = 'Pending' AND customer_confirmed = 0
      AND EXISTS (
        SELECT 1 FROM tickets WHERE tickets.order_id = orders.id
          AND tickets.kind = 'confirmation' AND tickets.channel_id = ? AND tickets.status = 'open'
      )
  `).run(Date.now(), input.orderId, input.guildId, input.customerId, input.channelId);
  return result.changes === 1;
}

function confirmOrder(db, input) {
  return withTransaction(db, () => {
    const order = db.prepare(`
      SELECT * FROM orders
      WHERE id = ? AND guild_id = ? AND customer_id = ?
        AND status = 'Pending' AND customer_confirmed = 0 AND payment_method = 'LTC'
        AND EXISTS (
          SELECT 1 FROM tickets WHERE tickets.order_id = orders.id
            AND tickets.kind = 'confirmation' AND tickets.channel_id = ? AND tickets.status = 'open'
        )
    `).get(input.orderId, input.guildId, input.customerId, input.channelId);
    if (!order) return null;
    const result = db.prepare(`
      UPDATE orders SET customer_confirmed = 1, updated_at = ?
      WHERE id = ? AND status = 'Pending' AND customer_confirmed = 0
    `).run(Date.now(), input.orderId);
    if (result.changes !== 1) return null;
    logOrderEvent(db, input.orderId, 'Pending', 'Pending', input.customerId, 'أكد العميل الطلب');
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(input.orderId);
  });
}

function rejectOrder(db, orderId, guildId, actorId, reason = null) {
  return withTransaction(db, () => {
    const order = db.prepare(`
      SELECT * FROM orders WHERE id = ? AND guild_id = ? AND status = 'Pending' AND customer_confirmed = 1
    `).get(orderId, guildId);
    if (!order) return null;
    const updated = db.prepare(`
      UPDATE orders SET status = 'Rejected', rejected_by = ?, rejection_reason = ?, updated_at = ?
      WHERE id = ? AND guild_id = ? AND status = 'Pending' AND customer_confirmed = 1
    `).run(actorId, reason?.trim() || null, Date.now(), orderId, guildId);
    if (updated.changes !== 1) return null;
    logOrderEvent(db, orderId, 'Pending', 'Rejected', actorId, reason?.trim() || null);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
}

function reserveAcceptance(db, orderId, guildId, actorId) {
  return withTransaction(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND guild_id = ?').get(orderId, guildId);
    if (!order) return { error: 'not_found' };
    if (order.status === 'Payment Pending' || order.discussion_channel_id) {
      return { error: 'already_accepted', order };
    }
    if (order.status === 'Accepted') {
      if (order.discussion_creation_started_at &&
          Date.now() - order.discussion_creation_started_at < 2 * 60 * 1000) {
        return { error: 'in_progress', order };
      }
      const retry = db.prepare(`
        UPDATE orders SET discussion_creation_started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'Accepted' AND discussion_channel_id IS NULL
      `).run(Date.now(), Date.now(), order.id);
      return retry.changes === 1
        ? { order: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), retry: true }
        : { error: 'in_progress', order };
    }
    if (order.status !== 'Pending' || order.customer_confirmed !== 1) return { error: 'processed', order };
    const updated = db.prepare(`
      UPDATE orders SET status = 'Accepted', accepted_by = ?, discussion_creation_started_at = ?,
        updated_at = ?
      WHERE id = ? AND guild_id = ? AND status = 'Pending' AND customer_confirmed = 1
    `).run(actorId, Date.now(), Date.now(), orderId, guildId);
    if (updated.changes !== 1) return { error: 'processed', order };
    logOrderEvent(db, orderId, 'Pending', 'Accepted', actorId, 'قبول الطلب وبدء إنشاء تذكرة المناقشة');
    return { order: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) };
  });
}

function completeAcceptance(db, orderId, guildId, channelId, channelName, actorId) {
  return withTransaction(db, () => {
    const order = db.prepare(`
      SELECT * FROM orders WHERE id = ? AND guild_id = ? AND status = 'Accepted'
        AND discussion_channel_id IS NULL
    `).get(orderId, guildId);
    if (!order) return null;
    const now = Date.now();
    db.prepare(`
      INSERT INTO tickets (
        interaction_id, guild_id, customer_id, kind, order_id,
        channel_id, channel_name, status, created_at
      ) VALUES (?, ?, ?, 'purchase', ?, ?, ?, 'open', ?)
    `).run(
      `discussion:${orderId}`, guildId, order.customer_id, orderId, channelId, channelName, now,
    );
    const updated = db.prepare(`
      UPDATE orders SET status = 'Payment Pending', discussion_channel_id = ?,
        discussion_creation_started_at = NULL, ticket_channel_id = ?,
        ticket_channel_name = ?, ticket_creation_started_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'Accepted' AND discussion_channel_id IS NULL
    `).run(channelId, channelId, channelName, now, orderId);
    if (updated.changes !== 1) throw new Error('تغيرت حالة الطلب قبل اكتمال إنشاء التذكرة.');
    logOrderEvent(db, orderId, 'Accepted', 'Payment Pending', actorId, 'تم إنشاء تذكرة المناقشة');
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
}

function resetAcceptanceAttempt(db, orderId) {
  db.prepare(`
    UPDATE orders SET discussion_creation_started_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'Accepted' AND discussion_channel_id IS NULL
  `).run(Date.now(), orderId);
}

function markOrderPaid(db, orderId, guildId, actorId) {
  return transitionOrder(db, orderId, guildId, ['Payment Pending'], 'Paid', actorId, 'أكد الستاف استلام الدفع', {
    paid_by: actorId,
  });
}

function completeOrder(db, orderId, guildId, actorId) {
  return transitionOrder(db, orderId, guildId, ['Paid'], 'Completed', actorId, 'اكتملت معالجة الطلب', {
    completed_by: actorId,
  });
}

function transitionOrder(db, orderId, guildId, fromStatuses, toStatus, actorId, note, extra = {}) {
  return withTransaction(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND guild_id = ?').get(orderId, guildId);
    if (!order || !fromStatuses.includes(order.status)) return null;
    const assignments = ['status = ?', 'updated_at = ?'];
    const values = [toStatus, Date.now()];
    for (const [key, value] of Object.entries(extra)) {
      if (!['paid_by', 'completed_by'].includes(key)) throw new Error(`حقل تحديث غير مسموح: ${key}`);
      assignments.push(`${key} = ?`);
      values.push(value);
    }
    values.push(orderId, guildId, ...fromStatuses);
    const result = db.prepare(`
      UPDATE orders SET ${assignments.join(', ')}
      WHERE id = ? AND guild_id = ? AND status IN (${fromStatuses.map(() => '?').join(', ')})
    `).run(...values);
    if (result.changes !== 1) return null;
    logOrderEvent(db, orderId, order.status, toStatus, actorId, note);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
}

function closeTicketRecord(db, ticketId) {
  return db.prepare(`
    UPDATE tickets SET status = 'closed', closed_at = ?
    WHERE id = ? AND status IN ('open', 'closing', 'creating')
  `).run(Date.now(), ticketId).changes === 1;
}

function getTicket(db, channelId, guildId) {
  return db.prepare(`
    SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ? AND status = 'open'
  `).get(channelId, guildId) || null;
}

function recordTicketCreationFailure(db, orderId, ticketId, actorId) {
  return withTransaction(db, () => {
    db.prepare(`
      UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status IN ('creating', 'open')
    `).run(Date.now(), ticketId);
    const order = db.prepare(`
      SELECT * FROM orders WHERE id = ? AND status = 'Pending'
    `).get(orderId);
    if (!order) return;
    db.prepare(`
      UPDATE orders SET status = 'Cancelled', updated_at = ? WHERE id = ? AND status = 'Pending'
    `).run(Date.now(), orderId);
    logOrderEvent(db, orderId, 'Pending', 'Cancelled', actorId, 'تعذر إنشاء تذكرة الطلب');
  });
}

module.exports = {
  DEFAULT_PRODUCTS,
  ORDER_STATUSES,
  addProduct,
  cancelInitialOrder,
  closeTicketRecord,
  completeAcceptance,
  completeOrder,
  confirmOrder,
  createDatabase,
  createInitialTicketReservation,
  createOrder,
  getStaffRoleIds,
  getProduct,
  getSetting,
  getTicket,
  initializeGuildData,
  listProducts,
  logOrderEvent,
  markOrderPaid,
  orderCode,
  recordTicketCreationFailure,
  rejectOrder,
  removeProduct,
  resetAcceptanceAttempt,
  reserveAcceptance,
  saveInitialTicketChannel,
  selectPaymentMethod,
  setSetting,
  transitionOrder,
  updateProduct,
  withTransaction,
};
