'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COMPONENT_IDS,
  createDatabase,
  finalizeTicketClosure,
  finishTicketRow,
  orderApprovalButtons,
  paymentCurrencyRow,
  prepareTicketClosure,
  rejectOrder,
  reviewPaymentProof,
  storeButtons,
} = require('../index');

function makeOrder(db, status = 'awaiting_payment') {
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

function makeProof(db, orderId) {
  const result = db.prepare(`
    INSERT INTO payment_proofs (
      order_id, message_id, submitted_by, transaction_reference,
      attachment_urls, status, created_at
    ) VALUES (?, ?, 'customer-1', ?, '[]', 'submitted', ?)
  `).run(orderId, `message-${orderId}`, 'a'.repeat(64), Date.now());
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

test('staff rejection and payment confirmation are conditional and idempotent', () => {
  const db = createDatabase(':memory:');
  try {
    const pendingOrderId = makeOrder(db, 'pending_approval');
    assert.equal(rejectOrder(db, pendingOrderId, 'guild-1'), true);
    assert.equal(rejectOrder(db, pendingOrderId, 'guild-1'), false);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(pendingOrderId).status, 'rejected');

    const orderId = makeOrder(db, 'proof_submitted');
    makePurchaseTicket(db, orderId);
    const proofId = makeProof(db, orderId);
    const result = reviewPaymentProof(db, proofId, 'guild-1', 'staff-1', 'confirm');
    assert.equal(result.error, undefined);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'paid');
    assert.equal(db.prepare('SELECT status FROM payment_proofs WHERE id = ?').get(proofId).status, 'confirmed');
    assert.equal(reviewPaymentProof(db, proofId, 'guild-1', 'staff-2', 'confirm').error, 'processed');
  } finally {
    db.close();
  }
});

test('closing an unpaid ticket never marks its order as paid', () => {
  const db = createDatabase(':memory:');
  try {
    const orderId = makeOrder(db, 'awaiting_payment');
    const ticketId = makePurchaseTicket(db, orderId);
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

    assert.equal(prepareTicketClosure(db, ticket), true);
    assert.equal(prepareTicketClosure(db, ticket), false);
    assert.equal(finalizeTicketClosure(db, ticketId).status, 'closed');
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'closed_unpaid');
  } finally {
    db.close();
  }
});

test('proof rejection returns an open order to payment without verifying it', () => {
  const db = createDatabase(':memory:');
  try {
    const orderId = makeOrder(db, 'proof_submitted');
    makePurchaseTicket(db, orderId, 'open');
    const proofId = makeProof(db, orderId);
    reviewPaymentProof(db, proofId, 'guild-1', 'staff-1', 'reject');

    assert.equal(db.prepare('SELECT status FROM payment_proofs WHERE id = ?').get(proofId).status, 'rejected');
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'awaiting_payment');
  } finally {
    db.close();
  }
});

test('staff can confirm a submitted proof after the customer closes the unpaid ticket', () => {
  const db = createDatabase(':memory:');
  try {
    const orderId = makeOrder(db, 'proof_submitted');
    const ticketId = makePurchaseTicket(db, orderId);
    const proofId = makeProof(db, orderId);
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

    prepareTicketClosure(db, ticket);
    finalizeTicketClosure(db, ticketId);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'closed_unpaid');

    const result = reviewPaymentProof(db, proofId, 'guild-1', 'staff-1', 'confirm');
    assert.equal(result.error, undefined);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'paid');
    assert.equal(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticketId).status, 'closed');
  } finally {
    db.close();
  }
});

test('all persistent component IDs have matching handler prefixes', () => {
  const storeIds = storeButtons().components.map((component) => component.data.custom_id);
  const approvalIds = orderApprovalButtons(42).components.map((component) => component.data.custom_id);
  const paymentIds = paymentCurrencyRow(42).components.map((component) => component.data.custom_id);
  const finishId = finishTicketRow().components[0].data.custom_id;

  assert.deepEqual(storeIds, [
    COMPONENT_IDS.buyMinecraft,
    COMPONENT_IDS.buyService,
    COMPONENT_IDS.support,
  ]);
  assert.deepEqual(approvalIds, ['order:accept:42', 'order:reject:42']);
  assert.deepEqual(paymentIds, ['pay:42:LTC', 'pay:42:BTC', 'pay:42:USDT']);
  assert.equal(finishId, COMPONENT_IDS.finishTicket);
  for (const id of [...approvalIds, ...paymentIds]) assert.ok(id.length <= 100);
});
