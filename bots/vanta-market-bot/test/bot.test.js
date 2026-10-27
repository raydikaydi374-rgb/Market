'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COMPONENT_IDS,
  createDatabase,
  finalizeTicketClosure,
  finishTicketRow,
  orderApprovalButtons,
  prepareTicketClosure,
  rejectOrder,
  storeButtons,
} = require('../index');

function makeOrder(db, status = 'open') {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO orders (
      interaction_id, guild_id, customer_id, product_key, product_name,
      price_cents, status, ticket_channel_id, created_at, updated_at
    ) VALUES (?, 'guild-1', 'customer-1', 'minecraft', 'Minecraft Java + Bedrock', 1300, ?, ?, ?, ?)
  `).run(`interaction-${Math.random()}`, status, `channel-${Math.random()}`, now, now);
  return Number(result.lastInsertRowid);
}

function makePurchaseTicket(db, orderId, status = 'open') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const result = db.prepare(`
    INSERT INTO tickets (
      interaction_id, guild_id, customer_id, kind, order_id,
      channel_id, channel_name, status, created_at
    ) VALUES (?, ?, ?, 'purchase', ?, ?, ?, ?, ?)
  `).run(
    `ticket-order-${orderId}`,
    order.guild_id,
    order.customer_id,
    orderId,
    order.ticket_channel_id,
    `purchase-${orderId}`,
    status,
    Date.now(),
  );
  return Number(result.lastInsertRowid);
}

test('SQLite schema enforces one open support ticket per customer', () => {
  const db = createDatabase(':memory:');
  try {
    db.prepare(`
      INSERT INTO tickets (
        interaction_id, guild_id, customer_id, kind, channel_name, status, created_at
      ) VALUES ('support-1', 'guild-1', 'customer-1', 'support', 'support-one', 'open', ?)
    `).run(Date.now());

    assert.throws(() => db.prepare(`
      INSERT INTO tickets (
        interaction_id, guild_id, customer_id, kind, channel_name, status, created_at
      ) VALUES ('support-2', 'guild-1', 'customer-1', 'support', 'support-two', 'creating', ?)
    `).run(Date.now()), /UNIQUE constraint failed/);

    db.prepare("UPDATE tickets SET status = 'closed' WHERE interaction_id = 'support-1'").run();
    assert.doesNotThrow(() => db.prepare(`
      INSERT INTO tickets (
        interaction_id, guild_id, customer_id, kind, channel_name, status, created_at
      ) VALUES ('support-3', 'guild-1', 'customer-1', 'support', 'support-three', 'creating', ?)
    `).run(Date.now()));
  } finally {
    db.close();
  }
});

test('order rejection is conditional and idempotent', () => {
  const db = createDatabase(':memory:');
  try {
    const pendingOrderId = makeOrder(db, 'pending_approval');
    assert.equal(rejectOrder(db, pendingOrderId, 'guild-1'), true);
    assert.equal(rejectOrder(db, pendingOrderId, 'guild-1'), false);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(pendingOrderId).status, 'rejected');

  } finally {
    db.close();
  }
});

test('closing a purchase ticket closes its order without recording payment', () => {
  const db = createDatabase(':memory:');
  try {
    const orderId = makeOrder(db, 'open');
    const ticketId = makePurchaseTicket(db, orderId);
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

    assert.equal(prepareTicketClosure(db, ticket), true);
    assert.equal(prepareTicketClosure(db, ticket), false);
    assert.equal(finalizeTicketClosure(db, ticketId).status, 'closed');
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'closed');
  } finally {
    db.close();
  }
});

test('new shop workflow has no wallet or payment-proof storage', () => {
  const db = createDatabase(':memory:');
  try {
    const columns = db.prepare('PRAGMA table_info(orders)').all().map((column) => column.name);
    assert.equal(columns.includes('payment_currency'), false);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payment_proofs'").get(),
      undefined,
    );
    assert.deepEqual(
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get().sql.match(/'[^']+'/g),
      ["'pending_approval'", "'ticket_creating'", "'open'", "'rejected'", "'closed'"],
    );
  } finally {
    db.close();
  }
});

test('all persistent component IDs match the active handlers', () => {
  const storeIds = storeButtons().components.map((component) => component.data.custom_id);
  const approvalIds = orderApprovalButtons(42).components.map((component) => component.data.custom_id);
  const finishId = finishTicketRow().components[0].data.custom_id;

  assert.deepEqual(storeIds, [
    COMPONENT_IDS.buyMinecraft,
    COMPONENT_IDS.buyService,
    COMPONENT_IDS.support,
  ]);
  assert.deepEqual(approvalIds, ['order:accept:42', 'order:reject:42']);
  assert.equal(finishId, COMPONENT_IDS.finishTicket);
  for (const id of [...storeIds, ...approvalIds, finishId]) assert.ok(id.length <= 100);
});
