'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
} = require('discord.js');

dotenv.config({ path: path.join(__dirname, '.env') });

const PRODUCTS = Object.freeze({
  minecraft: {
    key: 'minecraft',
    name: 'Minecraft Java + Bedrock',
    priceCents: 1300,
  },
  digital_service: {
    key: 'digital_service',
    name: 'خدمة رقمية مرخّصة',
    priceCents: 800,
  },
});

const SNOWFLAKE = /^\d{17,20}$/;
const TICKET_LEASE_MS = 2 * 60 * 1000;
const OPEN_TICKET_STATUSES = ['creating', 'open', 'closing'];
const COMPONENT_IDS = Object.freeze({
  buyMinecraft: 'shop:buy:minecraft',
  buyService: 'shop:buy:digital_service',
  finishTicket: 'ticket:finish',
  deleteTicket: 'ticket:delete',
});

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`متغير البيئة ${name} مطلوب. أضفه إلى ملف .env.`);
  return value;
}

function loadConfig() {
  const config = {
    token: requiredEnv('DISCORD_TOKEN'),
    clientId: requiredEnv('CLIENT_ID'),
    guildId: requiredEnv('GUILD_ID'),
    staffRoleId: requiredEnv('STAFF_ROLE_ID'),
    ordersChannelId: requiredEnv('ORDERS_CHANNEL_ID'),
    ticketCategoryId: requiredEnv('TICKET_CATEGORY_ID'),
    orderNotifyUserId: requiredEnv('ORDER_NOTIFY_USER_ID'),
    databasePath: process.env.DATABASE_PATH?.trim() || path.join('data', 'vanta-market.sqlite'),
  };

  for (const [name, value] of Object.entries({
    CLIENT_ID: config.clientId,
    GUILD_ID: config.guildId,
    STAFF_ROLE_ID: config.staffRoleId,
    ORDERS_CHANNEL_ID: config.ordersChannelId,
    TICKET_CATEGORY_ID: config.ticketCategoryId,
    ORDER_NOTIFY_USER_ID: config.orderNotifyUserId,
  })) {
    if (!SNOWFLAKE.test(value)) throw new Error(`${name} يجب أن يكون Discord ID صالحًا.`);
  }

  if (config.token.length < 20) throw new Error('DISCORD_TOKEN غير صالح أو غير مكتمل.');

  return config;
}

function createDatabase(databasePath = process.env.DATABASE_PATH?.trim() || path.join(__dirname, 'data', 'vanta-market.sqlite')) {
  const resolvedPath = databasePath === ':memory:' ? databasePath : path.resolve(__dirname, databasePath);
  if (resolvedPath !== ':memory:') fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const existingOrders = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'",
  ).get();
  const existingTickets = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'",
  ).get();
  const needsOrderMigration = existingOrders && !existingOrders.sql.includes('awaiting_confirmation');
  const needsTicketMigration = existingTickets && (
    !existingTickets.sql.includes('confirmation') ||
    /order_id\s+INTEGER\s+UNIQUE/i.test(existingTickets.sql)
  );
  if (needsOrderMigration || needsTicketMigration) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS orders_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interaction_id TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        product_key TEXT NOT NULL,
        product_name TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK (price_cents > 0),
        status TEXT NOT NULL CHECK (status IN (
          'awaiting_confirmation', 'pending_approval', 'ticket_creating',
          'open', 'rejected', 'cancelled', 'closed'
        )),
        staff_message_id TEXT UNIQUE,
        ticket_channel_id TEXT UNIQUE,
        ticket_channel_name TEXT,
        ticket_creation_started_at INTEGER,
        payment_preference TEXT CHECK (payment_preference IN ('crypto', 'staff') OR payment_preference IS NULL),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR REPLACE INTO orders_rebuilt (
        id, interaction_id, guild_id, customer_id, product_key, product_name,
        price_cents, status, staff_message_id, ticket_channel_id,
        ticket_channel_name, ticket_creation_started_at, created_at, updated_at
      )
      SELECT o.id, o.interaction_id, o.guild_id, o.customer_id, o.product_key,
        o.product_name, o.price_cents,
        CASE
          WHEN o.status IN ('awaiting_confirmation', 'pending_approval', 'ticket_creating', 'rejected', 'cancelled') THEN o.status
          WHEN o.status IN ('closed', 'closed_unpaid') THEN 'closed'
          WHEN EXISTS (
            SELECT 1 FROM tickets t WHERE t.order_id = o.id AND t.status = 'closed'
          ) THEN 'closed'
          ELSE 'open'
        END,
        o.staff_message_id, o.ticket_channel_id, o.ticket_channel_name,
        o.ticket_creation_started_at, o.created_at, o.updated_at
      FROM orders o;

      CREATE TABLE IF NOT EXISTS tickets_rebuilt (
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
      INSERT OR REPLACE INTO tickets_rebuilt (
        id, interaction_id, guild_id, customer_id, kind, order_id,
        channel_id, channel_name, status, created_at, closed_at
      )
      SELECT id, interaction_id, guild_id, customer_id, kind, order_id,
        channel_id, channel_name, status, created_at, closed_at
      FROM tickets;

      DROP TABLE tickets;
      DROP TABLE orders;
      ALTER TABLE orders_rebuilt RENAME TO orders;
      ALTER TABLE tickets_rebuilt RENAME TO tickets;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interaction_id TEXT NOT NULL UNIQUE,
      guild_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      product_name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      status TEXT NOT NULL CHECK (status IN (
        'awaiting_confirmation', 'pending_approval', 'ticket_creating',
        'open', 'rejected', 'cancelled', 'closed'
      )),
      staff_message_id TEXT UNIQUE,
      ticket_channel_id TEXT UNIQUE,
      ticket_channel_name TEXT,
      ticket_creation_started_at INTEGER,
      payment_preference TEXT CHECK (payment_preference IN ('crypto', 'staff') OR payment_preference IS NULL),
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

    CREATE INDEX IF NOT EXISTS tickets_by_channel_status
      ON tickets(channel_id, status);
    CREATE INDEX IF NOT EXISTS orders_by_status_created
      ON orders(status, created_at);
    CREATE TABLE IF NOT EXISTS custom_buttons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      label TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
  `);
  return db;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function createStoreEmbed() {
  return new EmbedBuilder()
    .setColor(0x7546ff)
    .setTitle('Vanta Market | المتجر')
    .setDescription([
      'اختر المنتج لفتح تذكرة تأكيد خاصة. يبدأ الطلب بعد تأكيدك وموافقة الإدارة.',
      '',
      `**Minecraft Java + Bedrock** — ${money(PRODUCTS.minecraft.priceCents)}`,
      `**خدمة رقمية مرخّصة** — ${money(PRODUCTS.digital_service.priceCents)}`,
      '',
      'يمكنك إضافة أزرار طلب مخصصة عبر الأمر الإداري /custom_button.',
    ].join('\n'))
    .setThumbnail('attachment://vanta-market-logo.png')
    .setFooter({ text: 'لا ترسل كلمات مرور أو مفاتيح خاصة أو عبارات استرداد.' });
}

function storeButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(COMPONENT_IDS.buyMinecraft)
      .setLabel('Minecraft Java + Bedrock · $13')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(COMPONENT_IDS.buyService)
      .setLabel('خدمة رقمية مرخّصة · $8')
      .setStyle(ButtonStyle.Primary),
  );
}

function orderApprovalEmbed(order) {
  return new EmbedBuilder()
    .setColor(0x7546ff)
    .setTitle(`طلب جديد #${order.id}`)
    .setDescription([
      `**العميل:** <@${order.customer_id}> (\`${order.customer_id}\`)`,
      `**المنتج:** ${order.product_name}`,
      `**السعر:** ${money(order.price_cents)}`,
      `**طريقة الدفع المفضلة:** ${order.payment_preference === 'crypto' ? 'كريبتو' : 'الاتفاق مع الموظف'}`,
      `**الحالة:** بانتظار مراجعة الموظف`,
    ].join('\n'))
    .setTimestamp(new Date(order.created_at));
}

function orderApprovalButtons(orderId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`order:accept:${orderId}`)
      .setLabel('قبول الطلب')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`order:reject:${orderId}`)
      .setLabel('رفض الطلب')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function finishTicketRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(COMPONENT_IDS.finishTicket)
      .setLabel('إنهاء العملية')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(COMPONENT_IDS.deleteTicket)
      .setLabel('حذف التذكرة')
      .setStyle(ButtonStyle.Danger),
  );
}

function deleteTicketRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(COMPONENT_IDS.deleteTicket)
      .setLabel('حذف التذكرة')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function customButtonRow(buttonId, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`custombuy:${buttonId}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary),
  );
}

function paymentPreferenceRow(orderId, selected = null) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`paypref:crypto:${orderId}`)
      .setLabel('كريبتو')
      .setStyle(selected === 'crypto' ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`paypref:staff:${orderId}`)
      .setLabel('الاتفاق مع الموظف')
      .setStyle(selected === 'staff' ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
}

function ticketIntroEmbed(ticket, order = null) {
  if (ticket.kind === 'support') {
    return new EmbedBuilder()
      .setColor(0x7546ff)
      .setTitle('تذكرة دعم Vanta Market')
      .setDescription([
        `مرحبًا <@${ticket.customer_id}>. اكتب رسالتك هنا وسيجيبك فريق الدعم.`,
        'يمكنك إنهاء التذكرة عبر زر **إنهاء العملية**.',
        'لا ترسل كلمات المرور أو المفاتيح الخاصة أو عبارات الاسترداد.',
      ].join('\n'));
  }

  if (ticket.kind === 'confirmation') {
    return new EmbedBuilder()
      .setColor(0x7546ff)
      .setTitle(`تأكيد الطلب #${order.id}`)
      .setDescription([
        `**العميل:** <@${order.customer_id}>`,
        `**الطلب:** ${order.product_name}`,
        `**السعر:** ${money(order.price_cents)}`,
        `**طريقة الدفع المفضلة:** ${order.payment_preference === 'crypto' ? 'كريبتو' : order.payment_preference === 'staff' ? 'الاتفاق مع الموظف' : 'لم تُحدد بعد'}`,
        '',
        'اختر طريقة الدفع المفضلة إن أردت، ثم اكتب **تأكيد** لإرسال الطلب للإدارة.',
        'اكتب **إلغاء** لإلغاء الطلب وحذف تذكرة التأكيد.',
        'اختيار كريبتو يسجل التفضيل فقط؛ لا يعرض البوت عناوين محافظ ولا يتابع التحويل.',
      ].join('\n'));
  }

  return new EmbedBuilder()
    .setColor(0x7546ff)
    .setTitle(`تذكرة شراء ونقاش #${order.id}`)
    .setDescription([
      `**المنتج:** ${order.product_name}`,
      `**رقم الطلب:** #${order.id}`,
      `**السعر:** ${money(order.price_cents)}`,
      `**طريقة الدفع المفضلة:** ${order.payment_preference === 'crypto' ? 'كريبتو' : order.payment_preference === 'staff' ? 'الاتفاق مع الموظف' : 'اتفق مع الموظف هنا'}`,
      '',
      'تحدث مع الموظف هنا للاتفاق على تفاصيل الطلب وطريقة الدفع.',
      'البوت لا يستقبل التحويلات ولا يتابعها أو يتحقق منها.',
      'لا ترسل كلمات مرور أو مفاتيح خاصة أو عبارات استرداد.',
    ].join('\n'));
}

function parsePositiveInteger(value) {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasStaffRole(member, staffRoleId) {
  if (member?.roles?.cache?.has) return member.roles.cache.has(staffRoleId);
  return Array.isArray(member?.roles) && member.roles.includes(staffRoleId);
}

function findButton(message, customId) {
  return message.components.some((row) =>
    row.components.some((component) => component.customId === customId),
  );
}

function withTransaction(db, callback) {
  return db.transaction(callback).immediate();
}

function channelOverwrites(guild, customerId, staffRoleId, botUserId) {
  return [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: customerId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
    {
      id: staffRoleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
    {
      id: botUserId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
        PermissionsBitField.Flags.ManageChannels,
      ],
    },
  ];
}

function findNamedTicketChannel(guild, channelName) {
  return guild.channels.fetch().then((channels) =>
    channels.find(
      (channel) => channel?.type === ChannelType.GuildText && channel.name === channelName,
    ) || null,
  );
}

async function ensureTicketPrompt(db, ticket, guild, config) {
  if (!ticket.channel_id || ticket.status !== 'open') return;
  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const order = ticket.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.order_id) : null;
  const isConfirmation = ticket.kind === 'confirmation';
  const isPurchase = ticket.kind === 'purchase';
  const components = isConfirmation && order
    ? [paymentPreferenceRow(order.id, order.payment_preference), finishTicketRow()]
    : [finishTicketRow()];
  const mentions = isPurchase
    ? [ticket.customer_id, config.orderNotifyUserId]
    : isConfirmation ? [ticket.customer_id] : [];
  const content = mentions.length
    ? `${mentions.map((userId) => `<@${userId}>`).join(' ')}${isConfirmation ? '\nاكتب **تأكيد** لإرسال الطلب للإدارة أو **إلغاء** لإلغائه.' : ''}`
    : ticket.kind === 'support' ? `<@&${config.staffRoleId}>` : undefined;
  const allowedMentions = mentions.length
    ? { users: mentions }
    : ticket.kind === 'support' ? { roles: [config.staffRoleId] } : undefined;
  const payload = {
    content,
    allowedMentions,
    embeds: [ticketIntroEmbed(ticket, order)],
    components,
  };
  const existingPrompt = recent?.find((message) =>
    message.author.id === guild.client.user.id && findButton(message, COMPONENT_IDS.finishTicket),
  );
  if (existingPrompt) {
    await existingPrompt.edit(payload);
    return;
  }
  await channel.send(payload);
}

function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

function createOrder(db, interaction, product) {
  const now = Date.now();
  return withTransaction(db, () => {
    const existing = db.prepare(`
      SELECT o.*, t.channel_id AS active_channel_id
      FROM orders o
      LEFT JOIN tickets t ON t.order_id = o.id AND t.status = 'open'
      WHERE o.guild_id = ? AND o.customer_id = ?
        AND o.status IN ('awaiting_confirmation', 'pending_approval', 'ticket_creating', 'open')
      ORDER BY o.id DESC, CASE t.kind WHEN 'purchase' THEN 0 ELSE 1 END LIMIT 1
    `).get(interaction.guildId, interaction.user.id);
    if (existing) return { order: existing, existing: true };

    const result = db.prepare(`
    INSERT INTO orders (
      interaction_id, guild_id, customer_id, product_key, product_name,
      price_cents, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?, ?)
    `).run(
      interaction.id,
      interaction.guildId,
      interaction.user.id,
      product.key,
      product.name,
      product.priceCents,
      now,
      now,
    );
    return {
      order: db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(result.lastInsertRowid)),
      existing: false,
    };
  });
}

function safeChannelPart(value, maxLength = 30) {
  return String(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength)
    .replace(/-$/g, '') || 'طلب';
}

function createTicketName(prefix, productName, username, orderId) {
  return [
    prefix,
    safeChannelPart(productName, 28),
    safeChannelPart(username, 24),
    String(orderId).slice(-6),
  ].join('-').slice(0, 95);
}

async function findOrPostOrderMessage(db, order, ordersChannel) {
  if (order.staff_message_id) {
    const existing = await ordersChannel.messages.fetch(order.staff_message_id).catch(() => null);
    if (existing) return existing;
  }

  const recent = await ordersChannel.messages.fetch({ limit: 100 }).catch(() => null);
  const existing = recent?.find((message) =>
    message.author.id === ordersChannel.client.user.id &&
    findButton(message, `order:accept:${order.id}`),
  );
  if (existing) {
    db.prepare('UPDATE orders SET staff_message_id = ?, updated_at = ? WHERE id = ?')
      .run(existing.id, Date.now(), order.id);
    return existing;
  }

  const posted = await ordersChannel.send({
    content: `<@&${ordersChannel.client.config.staffRoleId}> <@${ordersChannel.client.config.orderNotifyUserId}>`,
    allowedMentions: {
      roles: [ordersChannel.client.config.staffRoleId],
      users: [ordersChannel.client.config.orderNotifyUserId],
    },
    embeds: [orderApprovalEmbed(order)],
    components: [orderApprovalButtons(order.id)],
  });
  db.prepare('UPDATE orders SET staff_message_id = ?, updated_at = ? WHERE id = ?')
    .run(posted.id, Date.now(), order.id);
  return posted;
}

async function publishUnannouncedOrders(db, ordersChannel) {
  const orders = db.prepare(`
    SELECT * FROM orders
    WHERE status = 'pending_approval' AND staff_message_id IS NULL
    ORDER BY created_at ASC
  `).all();
  for (const order of orders) {
    try {
      await findOrPostOrderMessage(db, order, ordersChannel);
    } catch (error) {
      console.error(`تعذر إرسال تنبيه الطلب #${order.id}:`, error.message);
    }
  }
}

function saveCustomButton(db, guildId, createdBy, label, priceCents) {
  const result = db.prepare(`
    INSERT INTO custom_buttons (guild_id, label, price_cents, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, label, priceCents, createdBy, Date.now());
  return db.prepare('SELECT * FROM custom_buttons WHERE id = ?')
    .get(Number(result.lastInsertRowid));
}

function reserveConfirmationTicket(db, order, interaction) {
  return withTransaction(db, () => {
    const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    if (!currentOrder || currentOrder.status !== 'awaiting_confirmation') {
      return { error: 'processed' };
    }
    const existing = db.prepare(`
      SELECT * FROM tickets WHERE order_id = ? AND kind = 'confirmation'
    `).get(order.id);
    if (existing) return existing;

    const channelName = createTicketName(
      'confirm',
      order.product_name,
      interaction.member?.displayName || interaction.user.username,
      order.id,
    );
    const result = db.prepare(`
      INSERT INTO tickets (
        interaction_id, guild_id, customer_id, kind, order_id,
        channel_name, status, created_at
      ) VALUES (?, ?, ?, 'confirmation', ?, ?, 'creating', ?)
    `).run(
      `confirmation:${order.id}`,
      order.guild_id,
      order.customer_id,
      order.id,
      channelName,
      Date.now(),
    );
    return db.prepare('SELECT * FROM tickets WHERE id = ?')
      .get(Number(result.lastInsertRowid));
  });
}

async function createConfirmationTicket(db, interaction, order, guild, config) {
  let ticket = reserveConfirmationTicket(db, order, interaction);
  if (ticket.error) {
    await interaction.editReply('هذا الطلب لم يعد بانتظار التأكيد.');
    return null;
  }

  if (ticket.status === 'open' && ticket.channel_id) {
    await interaction.editReply(`لديك طلب مفتوح بالفعل: <#${ticket.channel_id}>`);
    return null;
  }

  let channel = ticket.channel_id
    ? await guild.channels.fetch(ticket.channel_id).catch(() => null)
    : null;
  if (!channel) channel = await findNamedTicketChannel(guild, ticket.channel_name);

  try {
    if (!channel) {
      channel = await guild.channels.create({
        name: ticket.channel_name,
        type: ChannelType.GuildText,
        parent: config.ticketCategoryId,
        topic: `vanta-confirm:${order.id};owner:${order.customer_id}`,
        permissionOverwrites: channelOverwrites(
          guild,
          order.customer_id,
          config.staffRoleId,
          guild.client.user.id,
        ),
      });
    }

    db.prepare(`
      UPDATE tickets SET channel_id = ?, status = 'open'
      WHERE id = ? AND status IN ('creating', 'open')
    `).run(channel.id, ticket.id);
    ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    await ensureTicketPrompt(db, ticket, guild, config);
    await interaction.editReply(`تم فتح تذكرة التأكيد الخاصة بطلبك: <#${channel.id}>`);
    return channel;
  } catch (error) {
    if (!channel) {
      withTransaction(db, () => {
        db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'creating'")
          .run(Date.now(), ticket.id);
        db.prepare(`
          UPDATE orders SET status = 'cancelled', updated_at = ?
          WHERE id = ? AND status = 'awaiting_confirmation'
        `).run(Date.now(), order.id);
      });
    }
    throw error;
  }
}

async function beginOrder(db, interaction, product, guild, config) {
  const result = createOrder(db, interaction, product);
  if (result.existing) {
    const channelId = result.order.active_channel_id || result.order.ticket_channel_id;
    await interaction.editReply(
      channelId
        ? `لديك طلب مفتوح بالفعل: <#${channelId}>`
        : `لديك طلب مفتوح بالفعل **#${result.order.id}** وهو بانتظار المراجعة.`,
    );
    return;
  }
  await createConfirmationTicket(db, interaction, result.order, guild, config);
}

function submitOrderConfirmation(db, orderId, guildId, customerId) {
  const result = db.prepare(`
    UPDATE orders SET status = 'pending_approval', updated_at = ?
    WHERE id = ? AND guild_id = ? AND customer_id = ? AND status = 'awaiting_confirmation'
  `).run(Date.now(), orderId, guildId, customerId);
  return result.changes === 1;
}

function cancelOrderConfirmation(db, orderId, guildId, customerId) {
  return withTransaction(db, () => {
    const order = db.prepare(`
      SELECT * FROM orders
      WHERE id = ? AND guild_id = ? AND customer_id = ?
        AND status IN ('awaiting_confirmation', 'pending_approval')
    `).get(orderId, guildId, customerId);
    if (!order) return null;
    const updated = db.prepare(`
      UPDATE orders SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status IN ('awaiting_confirmation', 'pending_approval')
    `).run(Date.now(), orderId);
    return updated.changes === 1 ? order : null;
  });
}

function updatePaymentPreference(db, orderId, channelId, guildId, customerId, preference) {
  const result = db.prepare(`
    UPDATE orders
    SET payment_preference = ?, updated_at = ?
    WHERE id = ? AND guild_id = ? AND customer_id = ?
      AND status = 'awaiting_confirmation'
      AND EXISTS (
        SELECT 1 FROM tickets
        WHERE tickets.order_id = orders.id AND tickets.kind = 'confirmation'
          AND tickets.channel_id = ? AND tickets.status = 'open'
      )
  `).run(preference, Date.now(), orderId, guildId, customerId, channelId);
  return result.changes === 1;
}

async function reserveOrGetSupportTicket(db, interaction, guildId) {
  return withTransaction(db, () => {
    const open = db.prepare(`
      SELECT * FROM tickets
      WHERE guild_id = ? AND customer_id = ? AND kind = 'support'
        AND status IN ('creating', 'open', 'closing')
      ORDER BY id DESC LIMIT 1
    `).get(guildId, interaction.user.id);

    if (open) {
      if (open.status === 'creating' && Date.now() - open.created_at >= TICKET_LEASE_MS) {
        db.prepare("UPDATE tickets SET created_at = ? WHERE id = ? AND status = 'creating'")
          .run(Date.now(), open.id);
        return { ...open, created_at: Date.now(), retry: true };
      }
      return { ...open, retry: false };
    }

    const result = db.prepare(`
      INSERT INTO tickets (
        interaction_id, guild_id, customer_id, kind, channel_name, status, created_at
      ) VALUES (?, ?, ?, 'support', ?, 'creating', ?)
    `).run(
      interaction.id,
      guildId,
      interaction.user.id,
      `support-${randomUUID().slice(0, 8)}`,
      Date.now(),
    );
    return {
      ...db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(result.lastInsertRowid)),
      retry: true,
    };
  });
}

async function createOrResumeSupportTicket(db, interaction, guild, config) {
  const ticket = await reserveOrGetSupportTicket(db, interaction, guild.id);
  if (ticket.status === 'open' && ticket.channel_id) {
    await interaction.editReply(`لديك تذكرة دعم مفتوحة بالفعل: <#${ticket.channel_id}>`);
    return;
  }
  if (ticket.status === 'closing' || (ticket.status === 'creating' && !ticket.retry &&
      Date.now() - ticket.created_at < TICKET_LEASE_MS)) {
    await interaction.editReply('يتم تجهيز تذكرتك أو إغلاقها الآن. انتظر قليلًا ثم جرّب مجددًا.');
    return;
  }

  const channelName = ticket.channel_name;
  let channel = await findNamedTicketChannel(guild, channelName);
  try {
    if (!channel) {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: config.ticketCategoryId,
        topic: `vanta-support:${ticket.id};owner:${ticket.customer_id}`,
        permissionOverwrites: channelOverwrites(
          guild,
          ticket.customer_id,
          config.staffRoleId,
          guild.client.user.id,
        ),
      });
    }

    db.prepare(`
      UPDATE tickets SET channel_id = ?, status = 'open'
      WHERE id = ? AND status = 'creating'
    `).run(channel.id, ticket.id);
    const savedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    await ensureTicketPrompt(db, savedTicket, guild, config);
    await interaction.editReply(`تم فتح تذكرة الدعم الخاصة بك: <#${channel.id}>`);
  } catch (error) {
    if (!channel) {
      db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'creating'")
        .run(Date.now(), ticket.id);
    }
    throw error;
  }
}

async function acceptOrder(db, interaction, orderId, guild, config) {
  const now = Date.now();
  const order = withTransaction(db, () => {
    const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!current || current.guild_id !== guild.id) return { error: 'not_found' };
    if (current.status === 'open') return { ...current, alreadyOpen: true };
    if (current.status === 'pending_approval') {
      db.prepare(`
        UPDATE orders
        SET status = 'ticket_creating', ticket_creation_started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending_approval'
      `).run(now, now, current.id);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(current.id);
    }
    if (current.status === 'ticket_creating' &&
        now - (current.ticket_creation_started_at || 0) >= TICKET_LEASE_MS) {
      db.prepare(`
        UPDATE orders SET ticket_creation_started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'ticket_creating'
      `).run(now, now, current.id);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(current.id);
    }
    return { error: current.status === 'ticket_creating' ? 'in_progress' : 'processed' };
  });

  if (order.alreadyOpen && order.ticket_channel_id) {
    await interaction.editReply(`تم فتح تذكرة هذا الطلب مسبقًا: <#${order.ticket_channel_id}>`);
    return order;
  }
  if (order.error) {
    const messages = {
      not_found: 'لم يتم العثور على هذا الطلب في هذا السيرفر.',
      in_progress: 'يجري تجهيز تذكرة هذا الطلب بالفعل. انتظر قليلًا.',
      processed: 'تمت معالجة هذا الطلب مسبقًا.',
    };
    await interaction.editReply(messages[order.error]);
    return;
  }

  const customer = await guild.client.users.fetch(order.customer_id).catch(() => null);
  const channelName = order.ticket_channel_name || createTicketName(
    'buy',
    order.product_name,
    customer?.username || order.customer_id,
    order.id,
  );
  db.prepare(`
    UPDATE orders SET ticket_channel_name = ?, updated_at = ?
    WHERE id = ? AND status = 'ticket_creating' AND ticket_channel_name IS NULL
  `).run(channelName, Date.now(), order.id);
  const savedChannelName = db.prepare('SELECT ticket_channel_name FROM orders WHERE id = ?').get(order.id).ticket_channel_name;
  let channel = await findNamedTicketChannel(guild, savedChannelName);
  try {
    if (!channel) {
      channel = await guild.channels.create({
        name: savedChannelName,
        type: ChannelType.GuildText,
        parent: config.ticketCategoryId,
        topic: `vanta-order:${order.id};owner:${order.customer_id}`,
        permissionOverwrites: channelOverwrites(
          guild,
          order.customer_id,
          config.staffRoleId,
          guild.client.user.id,
        ),
      });
    }

    withTransaction(db, () => {
      const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      if (current.status !== 'ticket_creating') throw new Error('تم تغيير حالة الطلب أثناء فتح التذكرة.');
      const ticket = db.prepare(`
        SELECT * FROM tickets WHERE order_id = ? AND kind = 'purchase'
      `).get(order.id);
      if (!ticket) {
        db.prepare(`
          INSERT INTO tickets (
            interaction_id, guild_id, customer_id, kind, order_id,
            channel_id, channel_name, status, created_at
          ) VALUES (?, ?, ?, 'purchase', ?, ?, ?, 'open', ?)
        `).run(
          `purchase:${order.id}`,
          order.guild_id,
          order.customer_id,
          order.id,
          channel.id,
          savedChannelName,
          Date.now(),
        );
      } else {
        db.prepare(`
          UPDATE tickets SET channel_id = ?, status = 'open'
          WHERE id = ? AND status IN ('creating', 'open', 'closing')
        `).run(channel.id, ticket.id);
      }
      db.prepare(`
        UPDATE orders SET status = 'open', ticket_channel_id = ?,
          ticket_creation_started_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'ticket_creating'
      `).run(channel.id, Date.now(), order.id);
    });

    const savedTicket = db.prepare(`
      SELECT * FROM tickets WHERE order_id = ? AND kind = 'purchase'
    `).get(order.id);
    const savedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    await ensureTicketPrompt(db, savedTicket, guild, config);
    await interaction.editReply(`تم قبول الطلب وفتح تذكرة خاصة: <#${channel.id}>`);
    if (customer) {
      await customer.send(`تم قبول طلبك **#${order.id}**. انتقل إلى تذكرة النقاش والشراء: <#${channel.id}>`)
        .catch(() => {});
    }
    await removeConfirmationTicket(db, order.id, guild, channel.id);
    return savedOrder;
  } catch (error) {
    if (!channel) {
      db.prepare(`
        UPDATE orders SET status = 'pending_approval', ticket_creation_started_at = NULL,
          ticket_channel_name = NULL, updated_at = ?
        WHERE id = ? AND status = 'ticket_creating'
      `).run(Date.now(), order.id);
    }
    throw error;
  }
}

async function removeConfirmationTicket(db, orderId, guild, purchaseChannelId = null) {
  const ticket = db.prepare(`
    SELECT * FROM tickets
    WHERE order_id = ? AND kind = 'confirmation' AND status = 'open'
  `).get(orderId);
  if (!ticket) return;

  const channel = ticket.channel_id
    ? await guild.channels.fetch(ticket.channel_id).catch(() => null)
    : null;
  if (channel?.type === ChannelType.GuildText) {
    try {
      await channel.delete('Order moved from confirmation to purchase discussion');
    } catch (error) {
      console.error(`تعذر حذف تذكرة التأكيد #${orderId}:`, error.message);
      await makeTicketCustomerReadOnly(ticket, guild).catch(() => {});
      const notice = purchaseChannelId
        ? `تم نقل الطلب إلى تذكرة النقاش: <#${purchaseChannelId}>. هذه التذكرة لم تعد نشطة.`
        : 'تم إغلاق طلب التأكيد. هذه التذكرة لم تعد نشطة.';
      await channel.send(notice).catch(() => {});
    }
  }
  db.prepare(`
    UPDATE tickets SET status = 'closed', closed_at = ?
    WHERE id = ? AND status = 'open'
  `).run(Date.now(), ticket.id);
}

function disableApprovalMessage(db, order, guild, config) {
  if (!order.staff_message_id) return Promise.resolve();
  return guild.channels.fetch(config.ordersChannelId)
    .then((channel) => channel?.messages.fetch(order.staff_message_id))
    .then((message) => message?.edit({ components: [orderApprovalButtons(order.id, true)] }))
    .catch((error) => console.error(`تعذر تحديث أزرار الطلب #${order.id}:`, error.message));
}

function normalizeArabicCommand(text) {
  return text
    .normalize('NFKC')
    .trim()
    .replace(/[أإآ]/gu, 'ا')
    .replace(/[.!؟?،]+$/gu, '')
    .toLocaleLowerCase();
}

async function handleOrderConfirmationMessage(db, message, config) {
  if (message.author.bot || message.guildId !== config.guildId) return;
  const ticket = db.prepare(`
    SELECT * FROM tickets
    WHERE channel_id = ? AND guild_id = ? AND kind = 'confirmation' AND status = 'open'
  `).get(message.channelId, message.guildId);
  if (!ticket || ticket.customer_id !== message.author.id) return;

  const command = normalizeArabicCommand(message.content);
  if (['تاكيد', 'تاكيد الطلب'].includes(command)) {
    if (!submitOrderConfirmation(db, ticket.order_id, message.guildId, message.author.id)) {
      await message.reply('تمت معالجة هذا الطلب مسبقًا أو لم يعد بانتظار التأكيد.').catch(() => {});
      return;
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.order_id);
    try {
      const ordersChannel = await message.guild.channels.fetch(config.ordersChannelId);
      await findOrPostOrderMessage(db, order, ordersChannel);
      await message.channel.send('تم إرسال طلبك إلى الإدارة للمراجعة. ستبقى هذه التذكرة مفتوحة حتى صدور القرار.');
    } catch (error) {
      console.error(`تعذر إرسال الطلب #${order.id} بعد التأكيد:`, error.message);
      await message.channel.send('تم حفظ تأكيدك، لكن تعذر تنبيه الإدارة مؤقتًا. سيحاول البوت إعادة الإرسال تلقائيًا.').catch(() => {});
    }
    return;
  }

  if (['الغاء', 'الغاء الطلب'].includes(command)) {
    const order = cancelOrderConfirmation(db, ticket.order_id, message.guildId, message.author.id);
    if (!order) {
      await message.reply('تعذّر إلغاء الطلب؛ ربما عالجته الإدارة بالفعل.').catch(() => {});
      return;
    }
    await disableApprovalMessage(db, order, message.guild, config);
    const customer = await message.client.users.fetch(message.author.id).catch(() => null);
    if (customer) await customer.send(`تم إلغاء طلبك **#${order.id}** وحذف تذكرة التأكيد.`).catch(() => {});
    await removeConfirmationTicket(db, order.id, message.guild);
  }
}

async function handlePaymentPreference(db, interaction, orderId, preference) {
  const changed = updatePaymentPreference(
    db,
    orderId,
    interaction.channelId,
    interaction.guildId,
    interaction.user.id,
    preference,
  );
  if (!changed) {
    await interaction.reply({
      content: 'يمكن لصاحب الطلب اختيار تفضيل الدفع قبل إرسال التأكيد فقط.',
      ephemeral: true,
    });
    return;
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const ticket = db.prepare(`
    SELECT * FROM tickets WHERE order_id = ? AND kind = 'confirmation'
  `).get(orderId);
  await interaction.update({
    embeds: [ticketIntroEmbed(ticket, order)],
    components: [paymentPreferenceRow(orderId, preference), finishTicketRow()],
  });
}

function rejectOrder(db, orderId, guildId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND guild_id = ?').get(orderId, guildId);
  if (!order) return null;
  const result = db.prepare(`
    UPDATE orders SET status = 'rejected', updated_at = ?
    WHERE id = ? AND guild_id = ? AND status = 'pending_approval'
  `).run(Date.now(), orderId, guildId);
  return result.changes === 1 ? order : null;
}

function prepareTicketClosure(db, ticket) {
  const result = db.prepare(`
    UPDATE tickets SET status = 'closing'
    WHERE id = ? AND status = 'open'
  `).run(ticket.id);
  return result.changes === 1;
}

function finalizeTicketClosure(db, ticketId) {
  return withTransaction(db, () => {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket || ticket.status !== 'closing') return null;
    const updated = db.prepare(`
      UPDATE tickets SET status = 'closed', closed_at = ?
      WHERE id = ? AND status = 'closing'
    `).run(Date.now(), ticketId);
    if (updated.changes !== 1) return null;
    if (ticket.kind === 'purchase') {
      db.prepare(`
        UPDATE orders SET status = 'closed', updated_at = ?
        WHERE id = ? AND status = 'open'
      `).run(Date.now(), ticket.order_id);
    } else if (ticket.kind === 'confirmation') {
      db.prepare(`
        UPDATE orders SET status = 'cancelled', updated_at = ?
        WHERE id = ? AND status IN ('awaiting_confirmation', 'pending_approval')
      `).run(Date.now(), ticket.order_id);
    }
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  });
}

async function makeTicketCustomerReadOnly(ticket, guild) {
  const channel = await guild.channels.fetch(ticket.channel_id);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('قناة التذكرة غير موجودة أو ليست قناة نصية.');
  }
  await channel.permissionOverwrites.edit(ticket.customer_id, {
    ViewChannel: true,
    SendMessages: false,
    AttachFiles: false,
    SendMessagesInThreads: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
  });
  return channel;
}

async function closeTicket(db, interaction, guild) {
  const ticket = db.prepare(`
    SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ? AND status = 'open'
  `).get(interaction.channelId, guild.id);
  if (!ticket) {
    await interaction.reply({ content: 'هذه التذكرة مغلقة أو غير مسجّلة.', ephemeral: true });
    return;
  }
  if (!hasStaffRole(interaction.member, interaction.client.config.staffRoleId)) {
    await interaction.reply({ content: 'إنهاء العملية متاح للإدارة فقط.', ephemeral: true });
    return;
  }
  if (!prepareTicketClosure(db, ticket)) {
    await interaction.reply({ content: 'بدأ إغلاق هذه التذكرة بالفعل.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const channel = await makeTicketCustomerReadOnly(ticket, guild);
    const closedTicket = finalizeTicketClosure(db, ticket.id);
    if (!closedTicket) throw new Error('تعذر تثبيت حالة إغلاق التذكرة في قاعدة البيانات.');
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x72767d)
          .setTitle('تم إنهاء التذكرة')
          .setDescription('أُغلقت التذكرة للعميل. تبقى القناة متاحة للإدارة للمراجعة.'),
      ],
      components: [deleteTicketRow()],
    }).catch((error) => console.error(`تعذر نشر إشعار إغلاق التذكرة #${ticket.id}:`, error.message));
    await interaction.editReply('تم إنهاء التذكرة. لا يزال بإمكان الإدارة مراجعتها.');
    if (ticket.kind === 'confirmation') {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.order_id);
      if (order) await disableApprovalMessage(order, guild, interaction.client.config);
    }
  } catch (error) {
    db.prepare("UPDATE tickets SET status = 'open' WHERE id = ? AND status = 'closing'").run(ticket.id);
    throw error;
  }
}

async function deleteTicket(db, interaction, guild) {
  if (!hasStaffRole(interaction.member, interaction.client.config.staffRoleId)) {
    await interaction.reply({ content: 'حذف التذاكر متاح للإدارة فقط.', ephemeral: true });
    return;
  }
  const ticket = db.prepare(`
    SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ? AND status = 'open'
  `).get(interaction.channelId, guild.id);
  if (!ticket) {
    await interaction.reply({ content: 'هذه التذكرة مغلقة أو غير مسجّلة.', ephemeral: true });
    return;
  }
  if (!prepareTicketClosure(db, ticket)) {
    await interaction.reply({ content: 'بدأ إنهاء هذه التذكرة بالفعل.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const channel = await guild.channels.fetch(ticket.channel_id);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('قناة التذكرة غير موجودة.');
    await channel.delete(`Ticket deleted by staff ${interaction.user.id}`);
    const closedTicket = finalizeTicketClosure(db, ticket.id);
    if (!closedTicket) throw new Error('تعذر حفظ حالة حذف التذكرة.');
    await interaction.editReply('تم حذف التذكرة وتحديث حالة الطلب.');
    if (ticket.kind === 'confirmation') {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.order_id);
      if (order) await disableApprovalMessage(order, guild, interaction.client.config);
    }
  } catch (error) {
    db.prepare("UPDATE tickets SET status = 'open' WHERE id = ? AND status = 'closing'").run(ticket.id);
    throw error;
  }
}

async function reconcileTickets(db, guild, config) {
  const stale = db.prepare(`
    SELECT * FROM tickets
    WHERE status IN ('creating', 'closing')
    ORDER BY id ASC
  `).all();

  for (const ticket of stale) {
    try {
      if (ticket.status === 'creating') {
        const channel = await findNamedTicketChannel(guild, ticket.channel_name);
        if (!channel) {
          if (Date.now() - ticket.created_at >= TICKET_LEASE_MS) {
            withTransaction(db, () => {
              db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'creating'")
                .run(Date.now(), ticket.id);
              if (ticket.kind === 'purchase') {
                db.prepare(`
                  UPDATE orders SET status = 'pending_approval', ticket_channel_name = NULL,
                    ticket_creation_started_at = NULL, updated_at = ?
                  WHERE id = ? AND status = 'ticket_creating'
                `).run(Date.now(), ticket.order_id);
              } else if (ticket.kind === 'confirmation') {
                db.prepare(`
                  UPDATE orders SET status = 'cancelled', updated_at = ?
                  WHERE id = ? AND status = 'awaiting_confirmation'
                `).run(Date.now(), ticket.order_id);
              }
            });
          }
          continue;
        }
        db.prepare("UPDATE tickets SET channel_id = ?, status = 'open' WHERE id = ? AND status = 'creating'")
          .run(channel.id, ticket.id);
        if (ticket.kind === 'purchase') {
          db.prepare(`
            UPDATE orders SET status = 'open', ticket_channel_id = ?,
              ticket_creation_started_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'ticket_creating'
          `).run(channel.id, Date.now(), ticket.order_id);
        }
      } else {
        const channel = ticket.channel_id
          ? await guild.channels.fetch(ticket.channel_id).catch(() => null)
          : null;
        if (channel) await makeTicketCustomerReadOnly(ticket, guild);
        finalizeTicketClosure(db, ticket.id);
        if (ticket.kind === 'confirmation') {
          const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.order_id);
          if (order) await disableApprovalMessage(db, order, guild, config);
        }
      }
    } catch (error) {
      console.error(`تعذرت استعادة حالة التذكرة #${ticket.id}:`, error.message);
    }
  }

  const openTickets = db.prepare("SELECT * FROM tickets WHERE status = 'open' ORDER BY id ASC").all();
  for (const ticket of openTickets) {
    try {
      await ensureTicketPrompt(db, ticket, guild, config);
    } catch (error) {
      console.error(`تعذر فحص رسالة التذكرة #${ticket.id}:`, error.message);
    }
  }

  const orphanedConfirmations = db.prepare(`
    SELECT o.* FROM orders o
    LEFT JOIN tickets t ON t.order_id = o.id AND t.kind = 'confirmation'
      AND t.status IN ('creating', 'open', 'closing')
    WHERE o.status = 'awaiting_confirmation' AND t.id IS NULL
  `).all();
  for (const order of orphanedConfirmations) {
    db.prepare(`
      UPDATE orders SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'awaiting_confirmation'
    `).run(Date.now(), order.id);
  }
}

async function validateGuildSetup(client, config) {
  if (client.user.id !== config.clientId) {
    throw new Error('CLIENT_ID لا يطابق هوية البوت الذي سجّل الدخول.');
  }

  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) throw new Error('GUILD_ID غير صالح أو أن البوت غير موجود في هذا السيرفر.');
  await guild.fetch();

  const role = await guild.roles.fetch(config.staffRoleId).catch(() => null);
  if (!role) throw new Error('STAFF_ROLE_ID لا يشير إلى رتبة موجودة في السيرفر المحدد.');

  const orderNotifier = await guild.members.fetch(config.orderNotifyUserId).catch(() => null);
  if (!orderNotifier) throw new Error('ORDER_NOTIFY_USER_ID لا يشير إلى عضو موجود في السيرفر المحدد.');

  const orderNotifier = await guild.members.fetch(config.orderNotifyUserId).catch(() => null);
  if (!orderNotifier) throw new Error('ORDER_NOTIFY_USER_ID لا يشير إلى عضو موجود في السيرفر المحدد.');

  const ordersChannel = await guild.channels.fetch(config.ordersChannelId).catch(() => null);
  if (!ordersChannel || ordersChannel.type !== ChannelType.GuildText || ordersChannel.guildId !== guild.id) {
    throw new Error('ORDERS_CHANNEL_ID يجب أن يكون قناة نصية داخل GUILD_ID.');
  }

  const category = await guild.channels.fetch(config.ticketCategoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== guild.id) {
    throw new Error('TICKET_CATEGORY_ID يجب أن يكون فئة قنوات داخل GUILD_ID.');
  }

  const me = await guild.members.fetchMe();
  const requiredPermissions = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.AttachFiles,
  ];
  const botPermissions = ordersChannel.permissionsFor(me);
  const missing = requiredPermissions.filter((permission) => !botPermissions?.has(permission));
  if (missing.length) {
    throw new Error('البوت يفتقد صلاحيات في قناة الطلبات. امنحه View Channel وSend Messages وRead Message History وEmbed Links وManage Channels وAttach Files.');
  }

  const guildManageChannels = me.permissions.has(PermissionsBitField.Flags.ManageChannels);
  if (!guildManageChannels) {
    throw new Error('يحتاج البوت إلى صلاحية Manage Channels لإنشاء التذاكر الخاصة.');
  }
  return { guild, ordersChannel, role, category, orderNotifier };
}

function storeCommand() {
  return {
    name: 'store',
    description: 'عرض متجر Vanta Market وبدء طلب جديد',
  };
}

function customButtonCommand() {
  return {
    name: 'custom_button',
    description: 'إنشاء زر طلب مخصص',
    options: [
      {
        type: 3,
        name: 'name',
        description: 'الاسم الذي يظهر على الزر والتذكرة',
        required: true,
        max_length: 80,
      },
      {
        type: 10,
        name: 'price',
        description: 'سعر الطلب بالدولار',
        required: true,
        min_value: 0.01,
        max_value: 100000,
      },
    ],
  };
}

async function createCustomButtonPanel(db, interaction) {
  if (!hasStaffRole(interaction.member, interaction.client.config.staffRoleId)) {
    await interaction.reply({ content: 'إنشاء أزرار الطلب متاح للإدارة فقط.', ephemeral: true });
    return;
  }

  const label = interaction.options.getString('name', true).trim();
  const price = interaction.options.getNumber('price', true);
  const priceCents = Math.round(price * 100);
  if (!label || label.length > 80 || !Number.isFinite(priceCents) || priceCents < 1) {
    await interaction.reply({ content: 'أدخل اسم زر صالحًا وسعرًا موجبًا.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const button = saveCustomButton(db, interaction.guildId, interaction.user.id, label, priceCents);
  try {
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x7546ff)
          .setTitle(label)
          .setDescription(`السعر: **${money(priceCents)}**\nاضغط الزر لفتح تذكرة تأكيد خاصة.`),
      ],
      components: [customButtonRow(button.id, button.label)],
    });
    await interaction.editReply(`تم إنشاء زر **${button.label}** ونشره في هذه القناة.`);
  } catch (error) {
    db.prepare('UPDATE custom_buttons SET active = 0 WHERE id = ?').run(button.id);
    throw error;
  }
}

async function start() {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  const client = createClient();
  client.config = config;

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      const setup = await validateGuildSetup(readyClient, config);
      const rest = new REST({ version: '10' }).setToken(config.token);
      await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: [storeCommand(), customButtonCommand()] },
      );

      await reconcileTickets(db, setup.guild, config);
      await publishUnannouncedOrders(db, setup.ordersChannel);

      console.info(`تم تسجيل الدخول كبوت Vanta Market في السيرفر ${setup.guild.name}.`);
    } catch (error) {
      console.error('فشل فحص إعدادات البوت:', error.message);
      readyClient.destroy();
      process.exitCode = 1;
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
        if (interaction.isRepliable()) {
          await interaction.reply({ content: 'هذا البوت مخصص للسيرفر المحدد فقط.', ephemeral: true }).catch(() => {});
        }
        return;
      }

      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'store') {
          await interaction.deferReply({ ephemeral: true });
          const logo = new AttachmentBuilder(path.join(__dirname, 'assets', 'vanta-market-logo.png'));
          await interaction.channel.send({
            embeds: [createStoreEmbed()],
            components: [storeButtons()],
            files: [logo],
          });
          await interaction.editReply('تم نشر قائمة المتجر.');
          return;
        }
        if (interaction.commandName === 'custom_button') {
          await createCustomButtonPanel(db, interaction);
          return;
        }
        return;
      }

      if (!interaction.isButton()) return;
      const id = interaction.customId;

      if (id === COMPONENT_IDS.buyMinecraft || id === COMPONENT_IDS.buyService) {
        await interaction.deferReply({ ephemeral: true });
        const product = id === COMPONENT_IDS.buyMinecraft ? PRODUCTS.minecraft : PRODUCTS.digital_service;
        await beginOrder(db, interaction, product, interaction.guild, config);
        return;
      }

      const customBuyMatch = id.match(/^custombuy:(\d+)$/);
      if (customBuyMatch) {
        const buttonId = parsePositiveInteger(customBuyMatch[1]);
        if (!buttonId) {
          await interaction.reply({ content: 'رقم الزر غير صالح.', ephemeral: true });
          return;
        }
        const customButton = db.prepare(`
          SELECT * FROM custom_buttons
          WHERE id = ? AND guild_id = ? AND active = 1
        `).get(buttonId, interaction.guildId);
        if (!customButton) {
          await interaction.reply({ content: 'هذا الزر غير متاح حاليًا.', ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        await beginOrder(db, interaction, {
          key: `custom_${customButton.id}`,
          name: customButton.label,
          priceCents: customButton.price_cents,
        }, interaction.guild, config);
        return;
      }

      if (id === 'shop:support') {
        await interaction.reply({ content: 'زر الدعم لم يعد متاحًا. اختر أحد أزرار الطلب الحالية.', ephemeral: true });
        return;
      }

      if (id === COMPONENT_IDS.finishTicket) {
        await closeTicket(db, interaction, interaction.guild);
        return;
      }
      if (id === COMPONENT_IDS.deleteTicket) {
        await deleteTicket(db, interaction, interaction.guild);
        return;
      }

      const preferenceMatch = id.match(/^paypref:(crypto|staff):(\d+)$/);
      if (preferenceMatch) {
        const orderId = parsePositiveInteger(preferenceMatch[2]);
        if (!orderId) {
          await interaction.reply({ content: 'رقم الطلب غير صالح.', ephemeral: true });
          return;
        }
        await handlePaymentPreference(db, interaction, orderId, preferenceMatch[1]);
        return;
      }

      const approvalMatch = id.match(/^order:(accept|reject):(\d+)$/);
      if (approvalMatch) {
        const orderId = parsePositiveInteger(approvalMatch[2]);
        if (interaction.channelId !== config.ordersChannelId) {
          await interaction.reply({ content: 'أزرار مراجعة الطلب تعمل في قناة الطلبات فقط.', ephemeral: true });
          return;
        }
        if (!hasStaffRole(interaction.member, config.staffRoleId)) {
          await interaction.reply({ content: 'قبول الطلبات ورفضها متاحان للإدارة فقط.', ephemeral: true });
          return;
        }
        if (!orderId) {
          await interaction.reply({ content: 'رقم الطلب غير صالح.', ephemeral: true });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        if (approvalMatch[1] === 'accept') {
          const previousStatus = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId)?.status;
          await acceptOrder(db, interaction, orderId, interaction.guild, config);
          const updatedStatus = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId)?.status;
          if (updatedStatus === 'open') {
            await interaction.message.edit({ components: [orderApprovalButtons(orderId, true)] }).catch(() => {});
          } else if (previousStatus === 'pending_approval' && updatedStatus === 'ticket_creating') {
            // Keep the approval buttons available so staff can retry after a transient Discord failure.
          }
        } else {
          const rejected = rejectOrder(db, orderId, interaction.guildId);
          if (!rejected) {
            await interaction.editReply('تمت معالجة هذا الطلب مسبقًا أو لم يعد بانتظار الموافقة.');
            return;
          }
          await interaction.message.edit({ components: [orderApprovalButtons(orderId, true)] }).catch(() => {});
          await removeConfirmationTicket(db, orderId, interaction.guild);
          const customer = await interaction.client.users.fetch(rejected.customer_id).catch(() => null);
          if (customer) await customer.send(`تم رفض طلبك **#${orderId}** من Vanta Market.`).catch(() => {});
          await interaction.editReply(`تم رفض الطلب #${orderId} وإبلاغ العميل.`);
        }
        return;
      }

    } catch (error) {
      console.error('خطأ أثناء معالجة تفاعل Discord:', error.message);
      if (interaction.isRepliable()) {
        const message = 'تعذر إكمال الإجراء الآن. تحقق من حالة الطلب أو التذكرة قبل إعادة المحاولة.';
        if (interaction.deferred) await interaction.editReply(message).catch(() => {});
        else if (!interaction.replied) await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleOrderConfirmationMessage(db, message, config);
    } catch (error) {
      console.error('تعذر معالجة تأكيد الطلب:', error.message);
      await message.reply('تعذر معالجة رسالتك الآن. أعد المحاولة بعد قليل أو تواصل مع الإدارة.').catch(() => {});
    }
  });

  client.on(Events.Error, (error) => console.error('خطأ في اتصال Discord:', error.message));
  process.on('SIGINT', () => {
    db.close();
    client.destroy();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    db.close();
    client.destroy();
    process.exit(0);
  });

  await client.login(config.token);
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`تعذر تشغيل بوت Vanta Market: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  COMPONENT_IDS,
  PRODUCTS,
  createDatabase,
  finalizeTicketClosure,
  orderApprovalButtons,
  prepareTicketClosure,
  loadConfig,
  rejectOrder,
  storeButtons,
  finishTicketRow,
};
