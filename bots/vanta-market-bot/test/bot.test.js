'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('../database');
const { PermissionsBitField } = require('discord.js');
const {
  COMMANDS,
  COMPONENT_IDS,
  createDatabase,
  hasAdminAccess,
  storeComponents,
  ticketOverwrites,
} = require('../index');

function setup() {
  const db = createDatabase(':memory:');
  Database.initializeGuildData(db, { guildId: 'guild-1', staffRoleId: 'role-staff' });
  const product = Database.listProducts(db, 'guild-1')[0];
  const created = Database.createOrder(db, {
    interactionId: `interaction-${Math.random()}`,
    guildId: 'guild-1',
    customerId: 'customer-1',
    product,
    quantity: 2,
  });
  return { db, order: created.order, ticket: created.ticket };
}

function confirmOrder(db, order, ticket) {
  assert.equal(Database.saveInitialTicketChannel(db, ticket.id, 'initial-channel').status, 'open');
  assert.equal(Database.selectPaymentMethod(db, {
    orderId: order.id,
    guildId: order.guild_id,
    customerId: order.customer_id,
    channelId: 'initial-channel',
  }), true);
  return Database.confirmOrder(db, {
    orderId: order.id,
    guildId: order.guild_id,
    customerId: order.customer_id,
    channelId: 'initial-channel',
  });
}

test('new guild setup seeds editable products and the legacy staff role', () => {
  const db = createDatabase(':memory:');
  try {
    Database.initializeGuildData(db, {
      guildId: 'guild-1',
      staffRoleId: 'role-staff',
      ordersChannelId: 'channel-orders',
      ticketCategoryId: 'category-tickets',
    });
    assert.equal(Database.listProducts(db, 'guild-1').length, 2);
    assert.equal(Database.getSetting(db, 'guild-1', 'orders_channel_id'), 'channel-orders');
    assert.deepEqual(Database.listProducts(db, 'guild-1').map((item) => item.product_key), [
      'minecraft',
      'digital_service',
    ]);
    assert.deepEqual(db.prepare('SELECT role_id FROM admin_roles').all(), [{ role_id: 'role-staff' }]);
  } finally {
    db.close();
  }
});

test('product buttons are arranged within Discord row limits and Support is absent', () => {
  const db = createDatabase(':memory:');
  try {
    Database.initializeGuildData(db, { guildId: 'guild-1' });
    const products = Database.listProducts(db, 'guild-1');
    const rows = storeComponents(products);
    const ids = rows.flatMap((row) => row.components.map((button) => button.data.custom_id));
    assert.equal(rows.length, 1);
    assert.deepEqual(ids, products.map((product) => `product:${product.id}`));
    assert.ok(rows.every((row) => row.components.length <= 5));
    assert.equal(COMMANDS.some((command) => command.name === 'store'), true);
    assert.equal(COMMANDS.some((command) => command.name === 'cmd'), true);
  } finally {
    db.close();
  }
});

test('order creation stores quantity, unit and total price, and serializes duplicate clicks', () => {
  const { db, order, ticket } = setup();
  try {
    assert.equal(order.quantity, 2);
    assert.equal(order.unit_price_cents, 1300);
    assert.equal(order.price_cents, 2600);
    assert.match(order.order_code, /^VM-\d{6}$/);
    assert.equal(ticket.kind, 'confirmation');

    const duplicate = Database.createOrder(db, {
      interactionId: 'interaction-second',
      guildId: order.guild_id,
      customerId: order.customer_id,
      product: Database.listProducts(db, 'guild-1')[1],
      quantity: 1,
    });
    assert.equal(duplicate.existing, true);
    assert.equal(duplicate.order.id, order.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
  } finally {
    db.close();
  }
});

test('customer must choose LTC and type confirmation before order announcement', () => {
  const { db, order, ticket } = setup();
  try {
    Database.saveInitialTicketChannel(db, ticket.id, 'initial-channel');
    assert.equal(Database.confirmOrder(db, {
      orderId: order.id,
      guildId: order.guild_id,
      customerId: order.customer_id,
      channelId: 'initial-channel',
    }), null);
    assert.equal(Database.selectPaymentMethod(db, {
      orderId: order.id,
      guildId: order.guild_id,
      customerId: order.customer_id,
      channelId: 'initial-channel',
    }), true);
    const confirmed = Database.confirmOrder(db, {
      orderId: order.id,
      guildId: order.guild_id,
      customerId: order.customer_id,
      channelId: 'initial-channel',
    });
    assert.equal(confirmed.status, 'Pending');
    assert.equal(confirmed.customer_confirmed, 1);
    assert.equal(confirmed.payment_method, 'LTC');
    assert.equal(Database.confirmOrder(db, {
      orderId: order.id,
      guildId: order.guild_id,
      customerId: order.customer_id,
      channelId: 'initial-channel',
    }), null);
  } finally {
    db.close();
  }
});

test('acceptance saves the reviewer and only manual payment confirmation marks Paid', () => {
  const { db, order, ticket } = setup();
  try {
    const confirmed = confirmOrder(db, order, ticket);
    const reservation = Database.reserveAcceptance(db, order.id, order.guild_id, 'staff-1');
    assert.equal(reservation.order.status, 'Accepted');
    assert.equal(reservation.order.accepted_by, 'staff-1');
    assert.equal(Database.reserveAcceptance(db, order.id, order.guild_id, 'staff-2').error, 'in_progress');

    const accepted = Database.completeAcceptance(db, order.id, order.guild_id, 'discussion-channel', 'chat-test', 'staff-1');
    assert.equal(accepted.status, 'Payment Pending');
    assert.equal(accepted.accepted_by, 'staff-1');
    assert.equal(accepted.discussion_channel_id, 'discussion-channel');
    assert.equal(Database.markOrderPaid(db, order.id, order.guild_id, 'staff-1').status, 'Paid');
    assert.equal(Database.markOrderPaid(db, order.id, order.guild_id, 'staff-2'), null);
    assert.equal(Database.completeOrder(db, order.id, order.guild_id, 'staff-1').status, 'Completed');
    assert.equal(Database.completeOrder(db, order.id, order.guild_id, 'staff-1'), null);
    assert.deepEqual(
      db.prepare('SELECT new_status FROM order_events WHERE order_id = ?').all(order.id).map((row) => row.new_status),
      ['Pending', 'Pending', 'Accepted', 'Payment Pending', 'Paid', 'Completed'],
    );
    assert.equal(confirmed.customer_confirmed, 1);
  } finally {
    db.close();
  }
});

test('rejection is atomic, keeps its actor and optional reason, and cannot repeat', () => {
  const { db, order, ticket } = setup();
  try {
    confirmOrder(db, order, ticket);
    const rejected = Database.rejectOrder(db, order.id, order.guild_id, 'staff-9', 'المنتج غير متوفر');
    assert.equal(rejected.status, 'Rejected');
    assert.equal(rejected.rejected_by, 'staff-9');
    assert.equal(rejected.rejection_reason, 'المنتج غير متوفر');
    assert.equal(Database.rejectOrder(db, order.id, order.guild_id, 'staff-10'), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
  } finally {
    db.close();
  }
});

test('removing a product hides it while preserving the product and existing order', () => {
  const { db, order } = setup();
  try {
    assert.equal(Database.removeProduct(db, 'guild-1', Number(order.product_key === 'minecraft' ? 1 : 2)), true);
    assert.equal(Database.listProducts(db, 'guild-1').length, 1);
    assert.equal(db.prepare('SELECT product_name FROM orders WHERE id = ?').get(order.id).product_name, order.product_name);
  } finally {
    db.close();
  }
});

test('ticket access includes only the customer, configured owner/admin roles, and bot', () => {
  const db = createDatabase(':memory:');
  try {
    Database.initializeGuildData(db, { guildId: 'guild-1' });
    Database.setSetting(db, 'guild-1', 'owner_id', 'owner-user');
    db.prepare("INSERT INTO admin_roles (guild_id, role_id, added_by, created_at) VALUES ('guild-1', 'role-admin', 'owner-user', 1)").run();
    const result = ticketOverwrites({
      id: 'guild-1',
      roles: { everyone: { id: 'guild-1' } },
      client: { user: { id: 'bot-user' } },
    }, { customer_id: 'customer-1', status: 'open' }, db);
    assert.deepEqual(result.map((overwrite) => overwrite.id), [
      'guild-1',
      'customer-1',
      'owner-user',
      'role-admin',
      'bot-user',
    ]);
    assert.equal(result[0].deny.includes(PermissionsBitField.Flags.ViewChannel), true);
    assert.equal(result[1].deny.includes(PermissionsBitField.Flags.ManageChannels), true);
    assert.equal(result.at(-1).allow.includes(PermissionsBitField.Flags.ManageChannels), true);
  } finally {
    db.close();
  }
});

test('role and owner authorization requires an already-authorized user', () => {
  const roleMember = { id: 'member-1', roles: { cache: { has: (id) => id === 'role-admin', some: (check) => check('role-admin') } } };
  const ordinaryMember = { id: 'member-2', roles: { cache: { has: (id) => id === 'role-other', some: (check) => check('role-other') } } };
  assert.equal(hasAdminAccess(roleMember, 'owner-1', ['role-admin']), true);
  assert.equal(hasAdminAccess({ id: 'owner-1', roles: { cache: { some: () => false } } }, 'owner-1', []), true);
  assert.equal(hasAdminAccess(ordinaryMember, 'owner-1', ['role-admin']), false);
});

test('legacy SQLite orders, tickets, and custom buttons migrate without dropping customer data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-migration-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const RawDatabase = require('better-sqlite3');
  const legacy = new RawDatabase(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interaction_id TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        product_key TEXT NOT NULL,
        product_name TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'awaiting_confirmation', 'pending_approval', 'ticket_creating',
          'open', 'rejected', 'cancelled', 'closed'
        )),
        staff_message_id TEXT UNIQUE,
        ticket_channel_id TEXT UNIQUE,
        ticket_channel_name TEXT,
        ticket_creation_started_at INTEGER,
        payment_preference TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interaction_id TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        order_id INTEGER UNIQUE REFERENCES orders(id),
        channel_id TEXT UNIQUE,
        channel_name TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE TABLE custom_buttons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        label TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
    `);
    legacy.prepare(`
      INSERT INTO orders (
        interaction_id, guild_id, customer_id, product_key, product_name,
        price_cents, status, ticket_channel_id, ticket_channel_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-order', 'guild-1', 'customer-1', 'minecraft', 'Minecraft', 1300,
      'open', 'channel-old', 'purchase-old', 10, 20);
    legacy.prepare(`
      INSERT INTO tickets (
        interaction_id, guild_id, customer_id, kind, order_id, channel_id,
        channel_name, status, created_at
      ) VALUES ('legacy-ticket', 'guild-1', 'customer-1', 'purchase', 1, 'channel-old', 'purchase-old', 'open', 10)
    `).run();
    legacy.prepare(`
      INSERT INTO custom_buttons (guild_id, label, price_cents, created_by, created_at)
      VALUES ('guild-1', 'Custom', 500, 'staff-1', 10)
    `).run();
  } finally {
    legacy.close();
  }

  try {
    const db = createDatabase(databasePath);
    try {
      const migrated = db.prepare('SELECT * FROM orders WHERE id = 1').get();
      assert.equal(migrated.status, 'Payment Pending');
      assert.equal(migrated.discussion_channel_id, 'channel-old');
      assert.equal(migrated.legacy_status, 'open');
      assert.equal(migrated.order_code, 'VM-000001');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count, 1);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      assert.equal(Database.listProducts(db, 'guild-1', false).some((product) => product.product_name === 'Custom'), true);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
