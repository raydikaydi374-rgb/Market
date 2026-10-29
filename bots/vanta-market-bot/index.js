'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
  ModalBuilder,
  PermissionsBitField,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const dotenv = require('dotenv');
const database = require('./database');

dotenv.config({ path: path.join(__dirname, '.env') });

const { ORDER_STATUSES } = database;
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_ACTIVE_PRODUCTS = 25;
const MAX_QUANTITY = 10000;
const TICKET_LEASE_MS = 2 * 60 * 1000;
const COMPONENT_IDS = Object.freeze({
  finishTicket: 'ticket:finish',
  deleteTicket: 'ticket:delete',
});

const COMMANDS = [
  { name: 'store', description: 'نشر لوحة متجر Vanta Market', summary: 'نشر لوحة المنتجات القابلة للشراء.', access: 'public' },
  { name: 'cmd', description: 'عرض أوامر بوت Vanta Market وصلاحياتها', summary: 'عرض الأوامر مع توضيح صلاحيات كل أمر.', access: 'public' },
  {
    name: 'custom_button', description: 'إضافة منتج وزر شراء مخصص',
    summary: 'إضافة منتج وزر شراء في المتجر.', access: 'admin',
    options: [
      { type: 3, name: 'name', description: 'اسم المنتج والزر', required: true, max_length: 80 },
      { type: 10, name: 'price', description: 'السعر بالدولار', required: true, min_value: 0.01, max_value: 100000 },
    ],
  },
  {
    name: 'setowner', description: 'تعيين الأونر الذي يظهر في الطلبات والتكتات',
    summary: 'تعيين الأونر ومنحه رؤية التكتات.', access: 'admin',
    options: [{ type: 6, name: 'user', description: 'عضو السيرفر الجديد', required: true }],
  },
  {
    name: 'removeowner', description: 'استبدال الأونر الحالي بأونر بديل',
    summary: 'استبدال الأونر؛ يلزم تعيين بديل قبل إزالة الحالي.', access: 'admin',
    options: [{ type: 6, name: 'replacement', description: 'الأونر البديل', required: true }],
  },
  {
    name: 'addadminrole', description: 'إضافة رتبة مخولة بإدارة الطلبات والتكتات',
    summary: 'إضافة رتبة أدمن وتطبيقها على التكتات الحالية.', access: 'admin',
    options: [{ type: 8, name: 'role', description: 'الرتبة المخولة', required: true }],
  },
  {
    name: 'removeadminrole', description: 'إزالة رتبة من صلاحيات الأدمن',
    summary: 'إزالة الرتبة وتحديث صلاحيات التكتات الحالية.', access: 'admin',
    options: [{ type: 8, name: 'role', description: 'الرتبة المراد إزالتها', required: true }],
  },
  { name: 'listadminroles', description: 'عرض رتب الأدمن الحالية', summary: 'عرض الرتب المخولة حاليًا.', access: 'admin' },
  {
    name: 'addstaffrole', description: 'إضافة رتبة ستاف مخولة بإدارة الطلبات',
    summary: 'إضافة رتبة تشغيلية للموافقة والدفع دون تعديل إعدادات البوت.', access: 'admin',
    options: [{ type: 8, name: 'role', description: 'رتبة الستاف المخولة', required: true }],
  },
  {
    name: 'removestaffrole', description: 'إزالة رتبة ستاف من الصلاحيات',
    summary: 'إزالة صلاحية إدارة الطلبات من رتبة ستاف.', access: 'admin',
    options: [{ type: 8, name: 'role', description: 'رتبة الستاف المراد إزالتها', required: true }],
  },
  { name: 'liststaffroles', description: 'عرض رتب الستاف التشغيلية', summary: 'عرض الرتب المسموح لها بإدارة الطلبات دون إعدادات البوت.', access: 'admin' },
  {
    name: 'setorderschannel', description: 'تحديد قناة استقبال طلبات المتجر',
    summary: 'تحديد قناة نشر الطلبات وأزرار مراجعتها.', access: 'admin',
    options: [{ type: 7, name: 'channel', description: 'قناة نصية داخل السيرفر', required: true, channel_types: [0] }],
  },
  {
    name: 'setticketcategory', description: 'تحديد فئة قنوات التكتات الخاصة',
    summary: 'تحديد الفئة التي تُنشأ فيها التكتات.', access: 'admin',
    options: [{ type: 7, name: 'category', description: 'فئة قنوات داخل السيرفر', required: true, channel_types: [4] }],
  },
  {
    name: 'setpaymentwallet', description: 'تعيين عنوان محفظة LTC للاستقبال',
    summary: 'حفظ عنوان LTC ليستخدمه الستاف عند الاتفاق.', access: 'admin',
    options: [{ type: 3, name: 'address', description: 'عنوان محفظة Litecoin', required: true, min_length: 3, max_length: 128 }],
  },
  {
    name: 'setmentionuser', description: 'تحديد العضو الذي تتم منشنته مع الطلب',
    summary: 'تغيير عضو الإشعارات دون تغيير الأونر.', access: 'admin',
    options: [{ type: 6, name: 'user', description: 'عضو السيرفر', required: true }],
  },
  {
    name: 'setbuttonname', description: 'تغيير الاسم الظاهر على زر منتج',
    summary: 'تعديل اسم زر منتج موجود.', access: 'admin',
    options: [
      { type: 4, name: 'product_id', description: 'رقم المنتج الظاهر في لوحة المتجر', required: true, min_value: 1 },
      { type: 3, name: 'name', description: 'الاسم الجديد للزر', required: true, min_length: 1, max_length: 80 },
    ],
  },
  {
    name: 'setticketname', description: 'تغيير اسم تكت منتج',
    summary: 'تعديل اسم القناة التي ينشئها المنتج.', access: 'admin',
    options: [
      { type: 4, name: 'product_id', description: 'رقم المنتج الظاهر في لوحة المتجر', required: true, min_value: 1 },
      { type: 3, name: 'name', description: 'اسم التكت الجديد', required: true, min_length: 1, max_length: 80 },
    ],
  },
  {
    name: 'addproductbutton', description: 'إضافة منتج وزر جديد إلى لوحة المتجر',
    summary: 'إضافة منتج بسعر واسم زر واسم تكت مخصص.', access: 'admin',
    options: [
      { type: 3, name: 'product_name', description: 'اسم المنتج', required: true, max_length: 100 },
      { type: 3, name: 'button_name', description: 'الاسم الظاهر على الزر', required: true, max_length: 80 },
      { type: 3, name: 'ticket_name', description: 'اسم قناة التكت', required: true, max_length: 80 },
      { type: 10, name: 'price', description: 'السعر بالدولار', required: true, min_value: 0.01, max_value: 100000 },
    ],
  },
  {
    name: 'removeproductbutton', description: 'حذف زر منتج من لوحة المتجر',
    summary: 'إخفاء زر المنتج من لوحات المتجر دون حذف الطلبات.', access: 'admin',
    options: [{ type: 4, name: 'product_id', description: 'رقم المنتج الظاهر في لوحة المتجر', required: true, min_value: 1 }],
  },
  {
    name: 'editproduct', description: 'تعديل اسم المنتج أو الزر أو التكت أو السعر',
    summary: 'تعديل بيانات منتج موجود دون تغيير الطلبات السابقة.', access: 'admin',
    options: [
      { type: 4, name: 'product_id', description: 'رقم المنتج الظاهر في لوحة المتجر', required: true, min_value: 1 },
      { type: 3, name: 'product_name', description: 'اسم المنتج الجديد', required: false, max_length: 100 },
      { type: 3, name: 'button_name', description: 'اسم الزر الجديد', required: false, max_length: 80 },
      { type: 3, name: 'ticket_name', description: 'اسم التكت الجديد', required: false, max_length: 80 },
      { type: 10, name: 'price', description: 'السعر الجديد بالدولار', required: false, min_value: 0.01, max_value: 100000 },
    ],
  },
  { name: 'sendpaymentinfo', description: 'إرسال عنوان الدفع ومعلومات التحويل داخل التكت', summary: 'إرسال عنوان LTC المحفوظ داخل تكت الطلب.', access: 'staff' },
  { name: 'confirmpayment', description: 'تأكيد استلام الدفع يدويًا للطلب الحالي', summary: 'تسجيل الدفع بعد تحقق الستاف يدويًا.', access: 'staff' },
  { name: 'completeorder', description: 'تحديد الطلب الحالي كمكتمل بعد الدفع', summary: 'إكمال طلب حالته مدفوع فقط.', access: 'staff' },
];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`متغير البيئة ${name} مطلوب. أضفه إلى Replit Secrets أو إعدادات البيئة.`);
  return value;
}

function loadConfig() {
  const config = {
    token: requiredEnv('DISCORD_TOKEN'),
    clientId: requiredEnv('CLIENT_ID'),
    guildId: requiredEnv('GUILD_ID'),
    staffRoleId: process.env.STAFF_ROLE_ID?.trim() || null,
    ordersChannelId: process.env.ORDERS_CHANNEL_ID?.trim() || null,
    ticketCategoryId: process.env.TICKET_CATEGORY_ID?.trim() || null,
    orderNotifyUserId: process.env.ORDER_NOTIFY_USER_ID?.trim() || null,
    ownerId: process.env.OWNER_ID?.trim() || null,
    paymentWallet: process.env.LTC_WALLET_ADDRESS?.trim() || null,
    databasePath: process.env.DATABASE_PATH?.trim() || path.join(__dirname, 'data', 'vanta-market.sqlite'),
  };
  for (const [name, value] of Object.entries({
    CLIENT_ID: config.clientId,
    GUILD_ID: config.guildId,
    STAFF_ROLE_ID: config.staffRoleId,
    ORDERS_CHANNEL_ID: config.ordersChannelId,
    TICKET_CATEGORY_ID: config.ticketCategoryId,
    ORDER_NOTIFY_USER_ID: config.orderNotifyUserId,
    OWNER_ID: config.ownerId,
  })) {
    if (value && !SNOWFLAKE.test(value)) throw new Error(`${name} يجب أن يكون Discord ID صالحًا.`);
  }
  if (config.token.length < 20) throw new Error('DISCORD_TOKEN غير صالح أو غير مكتمل.');
  return config;
}

function parsePositiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : null;
}

function priceToCents(price) {
  if (!Number.isFinite(price) || price <= 0 || price > 100000) return null;
  const cents = Math.round(price * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatOrderCode(order) {
  return order.order_code || database.orderCode(order.id);
}

function normalizeArabicCommand(text) {
  return text.normalize('NFKC').trim().replace(/[أإآ]/gu, 'ا').replace(/[.!؟?،]+$/gu, '').toLocaleLowerCase();
}

function hasAdminAccess(member, ownerId, adminRoleIds) {
  if (!member) return false;
  if (ownerId && member.id === ownerId) return true;
  const roles = Array.isArray(adminRoleIds) ? adminRoleIds : [...(adminRoleIds || [])];
  if (member.roles?.cache?.some) return roles.some((roleId) => member.roles.cache.has(roleId));
  const memberRoles = Array.isArray(member.roles) ? member.roles : [];
  return roles.some((roleId) => memberRoles.includes(roleId));
}

function getAdminRoleIds(db, guildId) {
  return db.prepare('SELECT role_id FROM admin_roles WHERE guild_id = ? ORDER BY created_at, role_id')
    .all(guildId).map((row) => row.role_id);
}

function getTicketRoleIds(db, guildId) {
  return [...new Set([
    ...getAdminRoleIds(db, guildId),
    ...database.getStaffRoleIds(db, guildId),
  ])];
}

function isAuthorized(db, guildId, member) {
  return hasAdminAccess(member, database.getSetting(db, guildId, 'owner_id'), getAdminRoleIds(db, guildId));
}

function hasStaffAccess(member, ownerId, adminRoleIds, staffRoleIds) {
  return hasAdminAccess(member, ownerId, [
    ...adminRoleIds,
    ...staffRoleIds,
  ]);
}

function isStaffAuthorized(db, guildId, member) {
  return hasStaffAccess(
    member,
    database.getSetting(db, guildId, 'owner_id'),
    getAdminRoleIds(db, guildId),
    database.getStaffRoleIds(db, guildId),
  );
}

function isBootstrapAdmin(member) {
  return Boolean(member?.permissions?.has?.(PermissionsBitField.Flags.ManageGuild));
}

function ticketOverwrites(guild, ticket, db) {
  const readWrite = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.EmbedLinks,
  ];
  const adminRoleIds = getTicketRoleIds(db, guild.id);
  const overwrites = [{
    id: guild.roles.everyone.id,
    deny: [PermissionsBitField.Flags.ViewChannel],
  }];
  const customerOpen = ticket.status === 'open';
  overwrites.push({
    id: ticket.customer_id,
    allow: customerOpen ? readWrite : [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
    ],
    deny: [
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.CreateInstantInvite,
      PermissionsBitField.Flags.CreatePrivateThreads,
      PermissionsBitField.Flags.CreatePublicThreads,
    ].concat(customerOpen ? [] : [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles]),
  });

  const ownerId = database.getSetting(db, guild.id, 'owner_id');
  if (ownerId && ownerId !== ticket.customer_id) {
    overwrites.push({ id: ownerId, allow: readWrite });
  }
  for (const roleId of adminRoleIds) {
    if (roleId === guild.roles.everyone.id) continue;
    overwrites.push({ id: roleId, allow: readWrite });
  }
  overwrites.push({
    id: guild.client.user.id,
    allow: [
      ...readWrite,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.ManageMessages,
    ],
  });
  if (overwrites.length > 100) throw new Error('تجاوزت إعدادات التكت حد Discord البالغ 100 إذن قناة.');
  return overwrites;
}

function storeEmbed(products) {
  return new EmbedBuilder()
    .setColor(0x7546ff)
    .setTitle('Vanta Market | المتجر')
    .setDescription(products.length
      ? products.map((product) =>
        `**${product.product_name.slice(0, 48)}** — ${money(product.price_cents)} · التكت: ${product.ticket_name.slice(0, 32)} · \`P${product.id}\``,
      ).join('\n')
      : 'لا توجد منتجات متاحة حاليًا.')
    .setThumbnail('attachment://vanta-market-logo.png')
    .setFooter({ text: 'اختر منتجًا للشراء. لا ترسل كلمات مرور أو مفاتيح خاصة.' });
}

function storeComponents(products) {
  const rows = [];
  for (let offset = 0; offset < products.length; offset += 5) {
    const row = new ActionRowBuilder();
    for (const product of products.slice(offset, offset + 5)) {
      row.addComponents(new ButtonBuilder()
        .setCustomId(`product:${product.id}`)
        .setLabel(`${product.button_label.slice(0, 55).trim()} · ${money(product.price_cents)}`)
        .setStyle(ButtonStyle.Primary));
    }
    rows.push(row);
  }
  return rows;
}

function approvalButtons(orderId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`order:accept:${orderId}`).setLabel('قبول الطلب')
      .setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`order:reject:${orderId}`).setLabel('رفض الطلب')
      .setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function ticketDeleteRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(COMPONENT_IDS.deleteTicket)
      .setLabel('حذف التذكرة').setStyle(ButtonStyle.Danger),
  );
}

function initialTicketComponents(order) {
  const rows = [];
  if (order.status === 'Pending' && !order.payment_method) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`payment:ltc:${order.id}`)
        .setLabel('الدفع عبر LTC').setStyle(ButtonStyle.Success),
    ));
  }
  rows.push(ticketDeleteRow());
  return rows;
}

function discussionComponents(order) {
  const rows = [];
  if (order.status === 'Payment Pending') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`order:paymentinfo:${order.id}`)
        .setLabel('إرسال بيانات الدفع').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`order:paid:${order.id}`)
        .setLabel('تأكيد استلام الدفع').setStyle(ButtonStyle.Success),
    ));
  } else if (order.status === 'Paid') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`order:complete:${order.id}`)
        .setLabel('إكمال الطلب').setStyle(ButtonStyle.Success),
    ));
  }
  rows.push(ticketDeleteRow());
  return rows;
}

function orderEmbed(order) {
  return new EmbedBuilder()
    .setColor(0x7546ff)
    .setTitle(`طلب جديد ${formatOrderCode(order)}`)
    .setDescription([
      `**العميل:** <@${order.customer_id}> (\`${order.customer_id}\`)`,
      `**المنتج:** ${order.product_name}`,
      `**الكمية:** ${order.quantity}`,
      `**سعر الوحدة:** ${money(order.unit_price_cents)}`,
      `**الإجمالي:** ${money(order.price_cents)}`,
      `**طريقة الدفع:** ${order.payment_method || 'غير محددة'}`,
      `**الحالة:** ${order.status}`,
    ].join('\n'))
    .setTimestamp(new Date(order.created_at));
}

function ticketEmbed(order, kind) {
  const isDiscussion = kind === 'purchase';
  const lines = [
    `**رقم الطلب:** ${formatOrderCode(order)}`,
    `**المنتج:** ${order.product_name}`,
    `**الكمية:** ${order.quantity}`,
    `**سعر الوحدة:** ${money(order.unit_price_cents)}`,
    `**الإجمالي:** ${money(order.price_cents)}`,
    `**طريقة الدفع:** ${order.payment_method || 'اختر LTC للمتابعة'}`,
    `**الحالة:** ${order.status}`,
    '',
  ];
  if (isDiscussion) {
    lines.push(
      'تم قبول الطلب وفتح هذه التذكرة للتنسيق مع الستاف. القبول لا يعني أن الدفع تم.',
      'اتفق مع الستاف على تفاصيل التحويل. لن يُسجل الطلب مدفوعًا إلا بعد تأكيد يدوي من الستاف.',
      'لا ترسل كلمات مرور أو عبارات استرداد.',
    );
  } else if (order.payment_method === 'LTC') {
    lines.push(
      'هل أنت متأكد أنك تريد شراء هذا المنتج؟',
      'لإرسال الطلب إلى الإدارة، اكتب كلمة **تأكيد** هنا.',
      'اكتب **إلغاء** قبل إرسال الطلب لإلغائه.',
    );
  } else {
    lines.push(
      'اختر طريقة الدفع. المتاح حاليًا هو LTC.',
      'بعد اختيارها، سنطلب منك كتابة **تأكيد** لإرسال الطلب إلى الإدارة.',
      'اكتب **إلغاء** قبل إرسال الطلب لإلغائه.',
    );
  }
  return new EmbedBuilder().setColor(0x7546ff)
    .setTitle(isDiscussion ? `مناقشة الطلب ${formatOrderCode(order)}` : `طلب شراء ${formatOrderCode(order)}`)
    .setDescription(lines.join('\n'));
}

function getMentions(db, guildId, customerId, includeRoles = false) {
  const users = new Set([customerId]);
  const ownerId = database.getSetting(db, guildId, 'owner_id');
  const mentionUserId = database.getSetting(db, guildId, 'mention_user_id');
  if (ownerId) users.add(ownerId);
  if (mentionUserId) users.add(mentionUserId);
  return {
    users: [...users],
    roles: includeRoles ? getTicketRoleIds(db, guildId) : [],
  };
}

function mentionText(mentions) {
  return [...mentions.users.map((id) => `<@${id}>`), ...mentions.roles.map((id) => `<@&${id}>`)]
    .join(' ');
}

async function refreshStorePanels(db, guild, guildId) {
  const products = database.listProducts(db, guildId);
  const panels = db.prepare('SELECT * FROM store_panels WHERE guild_id = ?').all(guildId);
  for (const panel of panels) {
    try {
      const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
      const message = await channel?.messages.fetch(panel.message_id).catch(() => null);
      if (!message) {
        db.prepare('DELETE FROM store_panels WHERE message_id = ?').run(panel.message_id);
        continue;
      }
      await message.edit({ embeds: [storeEmbed(products)], components: storeComponents(products) });
    } catch (error) {
      console.error(`تعذر تحديث لوحة المتجر ${panel.message_id}:`, error.message);
    }
  }
}

async function upgradeLegacyStorePanels(db, guild) {
  const products = database.listProducts(db, guild.id);
  const bot = await guild.members.fetchMe();
  const channels = await guild.channels.fetch();
  const legacyIds = new Set([
    'shop:buy:minecraft',
    'shop:buy:digital_service',
    'shop:support',
  ]);
  for (const channel of channels.values()) {
    if (channel?.type !== ChannelType.GuildText) continue;
    const permissions = channel.permissionsFor(bot);
    if (!permissions?.has([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
    ])) continue;
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) continue;
    for (const message of messages.values()) {
      if (message.author.id !== guild.client.user.id) continue;
      const isLegacyPanel = message.components.some((row) =>
        row.components.some((component) => legacyIds.has(component.customId)),
      );
      if (!isLegacyPanel) continue;
      try {
        await message.edit({ embeds: [storeEmbed(products)], components: storeComponents(products) });
        db.prepare(`
          INSERT OR IGNORE INTO store_panels (guild_id, channel_id, message_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(guild.id, channel.id, message.id, Date.now());
      } catch (error) {
        console.error(`تعذر تحديث لوحة المتجر القديمة ${message.id}:`, error.message);
      }
    }
  }
}

async function ensureTicketPrompt(db, ticket, guild) {
  if (!ticket.channel_id || !['open', 'closing', 'closed'].includes(ticket.status)) return;
  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const order = ticket.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.order_id) : null;
  if (!order) return;
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const buttonNeedle = ticket.kind === 'confirmation'
    ? `payment:ltc:${order.id}`
    : `order:paymentinfo:${order.id}`;
  const existing = messages?.find((message) => message.author.id === guild.client.user.id &&
    message.components.some((row) => row.components.some((component) =>
      component.customId === buttonNeedle || component.customId === COMPONENT_IDS.deleteTicket,
    )));
  const mentions = getMentions(db, guild.id, order.customer_id, ticket.kind === 'purchase');
  const content = ticket.kind === 'purchase'
    ? mentionText(mentions)
    : `<@${order.customer_id}>`;
  const payload = {
    content,
    allowedMentions: { users: mentions.users, roles: mentions.roles },
    embeds: [ticketEmbed(order, ticket.kind)],
    components: ticket.kind === 'confirmation'
      ? initialTicketComponents(order)
      : discussionComponents(order),
  };
  if (existing) await existing.edit(payload);
  else await channel.send(payload);
}

async function notifyAdmins(db, guild, message) {
  const channelId = database.getSetting(db, guild.id, 'orders_channel_id');
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  const mentions = {
    users: [database.getSetting(db, guild.id, 'owner_id')].filter(Boolean),
    roles: getTicketRoleIds(db, guild.id),
  };
  if (channel?.isTextBased()) {
    await channel.send({
      content: `${mentionText(mentions)}\n${message}`,
      allowedMentions: mentions,
    }).catch((error) => console.error('تعذر تنبيه الإدارة:', error.message));
  }
}

async function syncTicketPermissions(db, guild) {
  const tickets = db.prepare(`
    SELECT * FROM tickets WHERE channel_id IS NOT NULL AND status IN ('open', 'closing', 'closed')
    ORDER BY id
  `).all();
  const failures = [];
  for (const ticket of tickets) {
    try {
      const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) continue;
      await channel.permissionOverwrites.set(ticketOverwrites(guild, ticket, db), 'Synchronize Vanta Market ticket access');
    } catch (error) {
      failures.push(`التذكرة ${ticket.channel_id}: ${error.message}`);
      console.error(`تعذر تحديث صلاحيات التذكرة ${ticket.channel_id}:`, error.message);
    }
  }
  if (failures.length) {
    await notifyAdmins(db, guild,
      `تعذر تحديث صلاحيات ${failures.length} تذكرة. تحقق من صلاحية Manage Channels وترتيب رتبة البوت.\n${failures.slice(0, 5).join('\n')}`,
    );
  }
  return failures;
}

async function getTicketCategory(guild, db) {
  const categoryId = database.getSetting(db, guild.id, 'ticket_category_id');
  const category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
  if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== guild.id) {
    throw new Error('حدد فئة التكتات أولًا باستخدام /setticketcategory.');
  }
  return category;
}

async function createPrivateTicketChannel(db, guild, ticket, order) {
  const category = await getTicketCategory(guild, db);
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    throw new Error('يحتاج البوت إلى صلاحية Manage Channels لإنشاء التكتات الخاصة.');
  }
  const roles = getTicketRoleIds(db, guild.id);
  for (const roleId of roles) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) throw new Error(`رتبة الأدمن ${roleId} غير موجودة.`);
    if (role.comparePositionTo(botMember.roles.highest) >= 0) {
      throw new Error(`يجب رفع رتبة البوت فوق رتبة الأدمن ${role.name} ليتمكن من ضبط صلاحياتها.`);
    }
  }
  return guild.channels.create({
    name: ticket.channel_name,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `vanta-order:${formatOrderCode(order)};owner:${order.customer_id}`,
    permissionOverwrites: ticketOverwrites(guild, ticket, db),
    reason: `Private Vanta Market order ${formatOrderCode(order)}`,
  });
}

async function createOrderTicket(db, interaction, product, quantity, guild) {
  if (!database.getSetting(db, guild.id, 'owner_id')) {
    await interaction.editReply('يجب أن يعيّن الأونر نفسه أولًا باستخدام /setowner قبل استقبال الطلبات.');
    return;
  }
  const created = database.createOrder(db, {
    interactionId: interaction.id,
    guildId: guild.id,
    customerId: interaction.user.id,
    product,
    quantity,
  });
  if (created.existing) {
    const channelId = created.order.active_channel_id ||
      created.order.discussion_channel_id || created.order.ticket_channel_id;
    await interaction.editReply(channelId
      ? `لديك طلب مفتوح بالفعل: <#${channelId}>`
      : `لديك طلب مفتوح بالفعل ${formatOrderCode(created.order)}. انتظر تجهيز تذكرته.`);
    return;
  }

  let ticket;
  let channel;
  try {
    ticket = database.createInitialTicketReservation(db, created.order);
    channel = await createPrivateTicketChannel(db, guild, ticket, created.order);
    const saved = database.saveInitialTicketChannel(db, ticket.id, channel.id);
    if (!saved) throw new Error('تعذر حفظ قناة التذكرة في قاعدة البيانات.');
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(created.order.id);
    await ensureTicketPrompt(db, saved, guild);
    await interaction.editReply(`تم فتح تكت الطلب الخاصة: <#${channel.id}>`);
    return;
  } catch (error) {
    if (channel) await channel.delete('Rollback failed initial ticket creation').catch(() => {});
    if (ticket) database.recordTicketCreationFailure(db, created.order.id, ticket.id, interaction.user.id);
    else database.cancelInitialOrder(db, created.order.id, interaction.user.id, 'تعذر إنشاء تذكرة الطلب');
    throw error;
  }
}

function createQuantityModal(product) {
  const quantity = new TextInputBuilder()
    .setCustomId('quantity')
    .setLabel('الكمية')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(4)
    .setPlaceholder('1')
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`quantity:${product.id}`)
    .setTitle(`طلب ${product.product_name}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(quantity));
}

async function findOrdersChannel(db, guild) {
  const id = database.getSetting(db, guild.id, 'orders_channel_id');
  const channel = id ? await guild.channels.fetch(id).catch(() => null) : null;
  if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guild.id) {
    throw new Error('حدد قناة الطلبات أولًا باستخدام /setorderschannel.');
  }
  return channel;
}

async function findOrPostOrderMessage(db, order, guild) {
  const ordersChannel = await findOrdersChannel(db, guild);
  if (order.staff_message_id) {
    const existing = await ordersChannel.messages.fetch(order.staff_message_id).catch(() => null);
    if (existing) return existing;
  }
  const recent = await ordersChannel.messages.fetch({ limit: 100 }).catch(() => null);
  const existing = recent?.find((message) => message.author.id === guild.client.user.id &&
    message.components.some((row) => row.components.some((component) =>
      component.customId === `order:accept:${order.id}`,
    )));
  if (existing) {
    db.prepare(`
      UPDATE orders SET staff_message_id = ?, announcement_started_at = NULL, updated_at = ?
      WHERE id = ? AND staff_message_id IS NULL
    `).run(existing.id, Date.now(), order.id);
    return existing;
  }
  const mentions = getMentions(db, guild.id, order.customer_id, true);
  const claimed = database.withTransaction(db, () => {
    const current = db.prepare('SELECT * FROM orders WHERE id = ? AND guild_id = ?')
      .get(order.id, guild.id);
    if (!current || current.staff_message_id) return false;
    if (current.announcement_started_at &&
        Date.now() - current.announcement_started_at < TICKET_LEASE_MS) return false;
    return db.prepare(`
      UPDATE orders SET announcement_started_at = ?, updated_at = ?
      WHERE id = ? AND guild_id = ? AND staff_message_id IS NULL
    `).run(Date.now(), Date.now(), order.id, guild.id).changes === 1;
  });
  if (!claimed) return null;
  try {
    const message = await ordersChannel.send({
      content: mentionText(mentions),
      allowedMentions: mentions,
      embeds: [orderEmbed(order)],
      components: [approvalButtons(order.id)],
    });
    db.prepare(`
      UPDATE orders SET staff_message_id = ?, announcement_started_at = NULL, updated_at = ?
      WHERE id = ? AND staff_message_id IS NULL
    `).run(message.id, Date.now(), order.id);
    return message;
  } catch (error) {
    db.prepare('UPDATE orders SET announcement_started_at = NULL WHERE id = ?')
      .run(order.id);
    throw error;
  }
}

async function publishUnannouncedOrders(db, guild) {
  const orders = db.prepare(`
    SELECT * FROM orders WHERE status = 'Pending' AND customer_confirmed = 1
      AND staff_message_id IS NULL ORDER BY created_at
  `).all();
  for (const order of orders) {
    try {
      await findOrPostOrderMessage(db, order, guild);
    } catch (error) {
      console.error(`تعذر إرسال الطلب ${formatOrderCode(order)} إلى قناة الطلبات:`, error.message);
    }
  }
}

async function deleteInitialTicket(db, orderId, guild, replacementChannelId) {
  const ticket = db.prepare(`
    SELECT * FROM tickets WHERE order_id = ? AND kind = 'confirmation' AND status = 'open'
  `).get(orderId);
  if (!ticket) return true;
  const channel = ticket.channel_id
    ? await guild.channels.fetch(ticket.channel_id).catch(() => null)
    : null;
  if (channel) {
    if (!replacementChannelId) {
      const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
      if (!['Rejected', 'Cancelled'].includes(order?.status)) return false;
    }
    try {
      await channel.delete(replacementChannelId
        ? 'Accepted order discussion ticket created successfully'
        : 'Order cancelled or rejected');
    } catch (error) {
      console.error(`تعذر حذف تذكرة الطلب الأولى ${orderId}:`, error.message);
      const notice = replacementChannelId
        ? `تم تجهيز تذكرة المناقشة: <#${replacementChannelId}>. لا ترسل معلومات جديدة هنا.`
        : 'تم اتخاذ قرار نهائي بشأن هذا الطلب. لا ترسل معلومات جديدة هنا.';
      await channel.permissionOverwrites.edit(ticket.customer_id, {
        ViewChannel: true,
        SendMessages: false,
        AttachFiles: false,
        CreatePrivateThreads: false,
        CreatePublicThreads: false,
      }).catch((permissionError) => {
        console.error(`تعذر جعل التذكرة القديمة للقراءة فقط ${orderId}:`, permissionError.message);
      });
      await channel.send(notice).catch(() => {});
      database.closeTicketRecord(db, ticket.id);
      await notifyAdmins(db, guild, `تعذر حذف القناة القديمة للطلب ${orderId}؛ جُعلت للقراءة فقط.`);
      return false;
    }
  }
  database.closeTicketRecord(db, ticket.id);
  return true;
}

async function archiveInitialTicket(db, ticket, guild, reason) {
  if (!ticket) return false;
  if (!ticket.channel_id) {
    database.closeTicketRecord(db, ticket.id);
    return true;
  }
  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) {
    database.closeTicketRecord(db, ticket.id);
    return true;
  }
  try {
    await channel.permissionOverwrites.set(
      ticketOverwrites(guild, { ...ticket, status: 'closed' }, db),
      reason,
    );
    db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'")
      .run(Date.now(), ticket.id);
    const closedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    await ensureTicketPrompt(db, closedTicket, guild).catch((error) => {
      console.error(`تعذر تحديث واجهة التذكرة المؤرشفة ${ticket.id}:`, error.message);
    });
    return true;
  } catch (error) {
    console.error(`تعذر أرشفة تكت الطلب ${ticket.order_id}:`, error.message);
    await notifyAdmins(db, guild, `تعذر جعل تكت الطلب ${ticket.order_id} للقراءة فقط؛ تحقق من صلاحيات البوت.`);
    return false;
  }
}

async function acceptOrder(db, interaction, orderId, guild) {
  const reservation = database.reserveAcceptance(db, orderId, guild.id, interaction.user.id);
  if (reservation.error === 'not_found') {
    await interaction.editReply('لم يتم العثور على الطلب في هذا السيرفر.');
    return;
  }
  if (reservation.error === 'already_accepted') {
    await interaction.editReply('تمت معالجة الطلب مسبقًا أو أن تذكرة المناقشة مفتوحة بالفعل.');
    return;
  }
  if (reservation.error === 'processed') {
    await interaction.editReply('لا يمكن قبول هذا الطلب بحالته الحالية.');
    return;
  }
  if (reservation.error === 'in_progress') {
    await interaction.editReply('يجري تجهيز تذكرة المناقشة بالفعل. انتظر قليلًا.');
    return;
  }

  const order = reservation.order;
  const customer = await guild.members.fetch(order.customer_id).catch(() => null);
  const ticket = {
    customer_id: order.customer_id,
    guild_id: guild.id,
    status: 'open',
    channel_name: `chat-${String(order.ticket_name || order.product_name).toLowerCase()
      .normalize('NFKC').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/-+/g, '-')
      .replace(/^-|-$/g, '').slice(0, 32) || 'order'}-${order.customer_id.slice(-4)}-${order.id}`,
  };
  let channel;
  try {
    if (!customer) throw new Error('تعذر العثور على عضو السيرفر صاحب الطلب.');
    channel = await createPrivateTicketChannel(db, guild, ticket, order);
    const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const mentions = getMentions(db, guild.id, order.customer_id, false);
    await channel.send({
      content: mentionText(mentions),
      allowedMentions: { users: mentions.users },
      embeds: [ticketEmbed({ ...current, status: 'Payment Pending' }, 'purchase')],
      components: discussionComponents({ ...current, status: 'Payment Pending' }),
    });
    const savedOrder = database.completeAcceptance(
      db, orderId, guild.id, channel.id, ticket.channel_name, interaction.user.id,
    );
    if (!savedOrder) throw new Error('تعذر حفظ تذكرة المناقشة وحالة الطلب في قاعدة البيانات.');

    await interaction.message.edit({ embeds: [orderEmbed(savedOrder)], components: [approvalButtons(orderId, true)] })
      .catch((error) => console.error(`تعذر تحديث رسالة الطلب ${orderId}:`, error.message));
    const initialDeleted = await deleteInitialTicket(db, orderId, guild, channel.id);
    if (!initialDeleted) {
      await notifyAdmins(db, guild, `تعذر حذف تكت الطلب الأولى ${formatOrderCode(savedOrder)} بعد فتح تكت المناقشة.`);
    }
    await interaction.editReply(
      `تم قبول ${formatOrderCode(savedOrder)} وحفظ القرار باسمك. تذكرة المناقشة الخاصة: <#${channel.id}>. لم يتم تسجيل الدفع.`,
    );
    return savedOrder;
  } catch (error) {
    const persisted = db.prepare('SELECT discussion_channel_id FROM orders WHERE id = ?').get(orderId);
    if (channel && persisted?.discussion_channel_id !== channel.id) {
      await channel.delete('Rollback incomplete order discussion creation').catch(() => {});
    }
    database.resetAcceptanceAttempt(db, orderId);
    throw error;
  }
}

async function disableOrderMessage(db, order, guild) {
  if (!order.staff_message_id) return;
  const channel = await findOrdersChannel(db, guild).catch(() => null);
  const message = await channel?.messages.fetch(order.staff_message_id).catch(() => null);
  if (message) {
    const disabled = [approvalButtons(order.id, true)];
    await message.edit({ embeds: [orderEmbed(order)], components: disabled }).catch(() => {});
  }
}

async function handleLtcChoice(db, interaction, orderId) {
  const changed = database.selectPaymentMethod(db, {
    orderId,
    guildId: interaction.guildId,
    customerId: interaction.user.id,
    channelId: interaction.channelId,
  });
  if (!changed) {
    await interaction.reply({ content: 'اختيار الدفع متاح لصاحب الطلب في تكت الطلب المفتوحة فقط.', ephemeral: true });
    return;
  }
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const ticket = database.getTicket(db, interaction.channelId, interaction.guildId);
  await interaction.update({
    embeds: [ticketEmbed(order, ticket.kind)],
    components: initialTicketComponents(order),
  });
}

async function handleTicketConfirmation(db, message) {
  if (message.author.bot || !message.guildId) return;
  const ticket = db.prepare(`
    SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ? AND kind = 'confirmation' AND status = 'open'
  `).get(message.channelId, message.guildId);
  if (!ticket || ticket.customer_id !== message.author.id) return;
  const value = normalizeArabicCommand(message.content);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.order_id);
  if (!order || order.status !== 'Pending') return;

  if (['الغاء', 'الغاء الطلب'].includes(value)) {
    const cancelled = database.cancelInitialOrder(db, order.id, message.author.id, 'ألغى العميل الطلب قبل الإرسال');
    if (!cancelled) {
      await message.reply('تعذر إلغاء الطلب؛ ربما عالجته الإدارة بالفعل.').catch(() => {});
      return;
    }
    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    await disableOrderMessage(db, updatedOrder, message.guild).catch(() => {});
    await message.channel.send('تم إلغاء الطلب. سيبقى سجله محفوظًا في قاعدة البيانات.').catch(() => {});
    await archiveInitialTicket(db, ticket, message.guild, 'Customer cancelled the pending order');
    return;
  }

  if (!['تاكيد', 'تاكيد الطلب'].includes(value)) return;
  if (!order.payment_method) {
    await message.reply('اختر زر **الدفع عبر LTC** أولًا، ثم اكتب **تأكيد**.').catch(() => {});
    return;
  }
  const confirmed = database.confirmOrder(db, {
    orderId: order.id,
    guildId: message.guildId,
    customerId: message.author.id,
    channelId: message.channelId,
  });
  if (!confirmed) {
    await message.reply('تمت معالجة هذا الطلب مسبقًا أو لم يعد بانتظار التأكيد.').catch(() => {});
    return;
  }
  try {
    const announced = await findOrPostOrderMessage(db, confirmed, message.guild);
    await message.channel.send(announced
      ? `تم إرسال ${formatOrderCode(confirmed)} إلى الإدارة للمراجعة. لم يتم تسجيل الدفع.`
      : `تم حفظ ${formatOrderCode(confirmed)} ويجري تنبيه الإدارة به. لم يتم تسجيل الدفع.`)
      .catch(() => {});
  } catch (error) {
    console.error(`تعذر إرسال ${formatOrderCode(confirmed)} بعد التأكيد:`, error.message);
    await message.channel.send('تم حفظ تأكيدك، لكن تعذر تنبيه الإدارة الآن. سيعيد البوت محاولة الإرسال بعد تشغيله أو ضبط قناة الطلبات.')
      .catch(() => {});
  }
}

async function requireAdmin(interaction, db, { allowBootstrap = true } = {}) {
  const authorized = isAuthorized(db, interaction.guildId, interaction.member);
  const noConfiguredAuthority = !database.getSetting(db, interaction.guildId, 'owner_id') &&
    getAdminRoleIds(db, interaction.guildId).length === 0 &&
    database.getStaffRoleIds(db, interaction.guildId).length === 0;
  if (authorized || (allowBootstrap && noConfiguredAuthority && isBootstrapAdmin(interaction.member))) return true;
  await interaction.reply({
    content: 'هذا الأمر متاح للأونر أو لأعضاء رتب الأدمن المحددة فقط.',
    ephemeral: true,
  });
  return false;
}

async function requireStaff(interaction, db) {
  if (isStaffAuthorized(db, interaction.guildId, interaction.member)) return true;
  await sendEphemeral(interaction, 'هذا الإجراء متاح للأونر ورتب الأدمن أو الستاف المخولة فقط.');
  return false;
}

async function sendEphemeral(interaction, content) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(content);
  return interaction.reply({ content, ephemeral: true });
}

function commandHelp() {
  const accessLabels = {
    admin: 'إداري · الأونر أو رتب الأدمن',
    staff: 'ستاف · الأونر أو رتب الأدمن/الستاف',
    public: 'عام',
  };
  const fields = COMMANDS.map((command) => ({
    name: `/${command.name} · ${accessLabels[command.access]}`,
    value: command.summary,
    inline: false,
  }));
  const pages = [];
  for (let offset = 0; offset < fields.length; offset += 25) {
    pages.push(new EmbedBuilder()
      .setColor(0x7546ff)
      .setTitle(pages.length ? 'أوامر Vanta Market (متابعة)' : 'أوامر Vanta Market')
      .setDescription('الأوامر الإدارية موضحة بوضوح؛ صلاحيات كل أمر تُفحص عند استخدامه.')
      .addFields(fields.slice(offset, offset + 25)));
  }
  return pages;
}

async function handleStoreCommand(db, interaction) {
  const products = database.listProducts(db, interaction.guildId);
  const logoPath = path.join(__dirname, 'assets', 'vanta-market-logo.png');
  const files = fs.existsSync(logoPath) ? [new AttachmentBuilder(logoPath)] : [];
  const message = await interaction.channel.send({
    embeds: [storeEmbed(products)],
    components: storeComponents(products),
    files,
    allowedMentions: { parse: [] },
  });
  db.prepare(`
    INSERT OR IGNORE INTO store_panels (guild_id, channel_id, message_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(interaction.guildId, interaction.channelId, message.id, Date.now());
  await interaction.reply({ content: 'تم نشر لوحة المتجر.', ephemeral: true });
}

async function ensureRoleManageable(interaction, role) {
  if (!role || role.id === interaction.guild.roles.everyone.id) {
    await sendEphemeral(interaction, 'لا يمكن استخدام رتبة @everyone كرتبة أدمن.');
    return false;
  }
  const botMember = await interaction.guild.members.fetchMe();
  if (role.comparePositionTo(botMember.roles.highest) >= 0) {
    await sendEphemeral(interaction, 'ارفع رتبة البوت فوق الرتبة المحددة قبل اعتمادها في التكتات.');
    return false;
  }
  return true;
}

async function changeAdminRole(db, interaction, role, shouldAdd) {
  if (shouldAdd && !(await ensureRoleManageable(interaction, role))) return;
  if (shouldAdd) {
    if (getTicketRoleIds(db, interaction.guildId).length >= 96 &&
        !getTicketRoleIds(db, interaction.guildId).includes(role.id)) {
      return sendEphemeral(interaction, 'وصلت إلى الحد الأقصى لرتب الأدمن التي يمكن إضافتها إلى صلاحيات التكتات.');
    }
    const result = db.prepare(`
      INSERT OR IGNORE INTO admin_roles (guild_id, role_id, added_by, created_at)
      VALUES (?, ?, ?, ?)
    `).run(interaction.guildId, role.id, interaction.user.id, Date.now());
    if (!result.changes) {
      await sendEphemeral(interaction, 'هذه الرتبة مخولة بالفعل.');
      return;
    }
  } else {
    if (!database.getSetting(db, interaction.guildId, 'owner_id') &&
        getAdminRoleIds(db, interaction.guildId).length <= 1) {
      return sendEphemeral(interaction, 'عيّن أونرًا أو أضف رتبة أدمن بديلة قبل إزالة آخر رتبة مخولة.');
    }
    const result = db.prepare('DELETE FROM admin_roles WHERE guild_id = ? AND role_id = ?')
      .run(interaction.guildId, role.id);
    if (!result.changes) {
      await sendEphemeral(interaction, 'هذه الرتبة غير موجودة في قائمة الأدمن.');
      return;
    }
  }
  await interaction.deferReply({ ephemeral: true });
  const failures = await syncTicketPermissions(db, interaction.guild);
  await interaction.editReply(
    shouldAdd
      ? `تمت إضافة ${role} إلى رتب الأدمن وتحديث التكتات.${failures.length ? ` تعذر تحديث ${failures.length} تكت؛ أُبلغت الإدارة.` : ''}`
      : `تمت إزالة ${role} من رتب الأدمن وتحديث التكتات.${failures.length ? ` تعذر تحديث ${failures.length} تكت؛ أُبلغت الإدارة.` : ''}`,
  );
}

async function changeStaffRole(db, interaction, role, shouldAdd) {
  if (shouldAdd && !(await ensureRoleManageable(interaction, role))) return;
  if (shouldAdd) {
    if (getTicketRoleIds(db, interaction.guildId).length >= 96 &&
        !getTicketRoleIds(db, interaction.guildId).includes(role.id)) {
      return sendEphemeral(interaction, 'وصلت إلى الحد الأقصى لرتب الستاف التي يمكن إضافتها إلى التكتات.');
    }
    const result = db.prepare(`
      INSERT OR IGNORE INTO staff_roles (guild_id, role_id, added_by, created_at)
      VALUES (?, ?, ?, ?)
    `).run(interaction.guildId, role.id, interaction.user.id, Date.now());
    if (!result.changes) return sendEphemeral(interaction, 'هذه الرتبة موجودة بالفعل ضمن رتب الستاف.');
  } else {
    const result = db.prepare('DELETE FROM staff_roles WHERE guild_id = ? AND role_id = ?')
      .run(interaction.guildId, role.id);
    if (!result.changes) return sendEphemeral(interaction, 'هذه الرتبة غير موجودة ضمن رتب الستاف.');
  }
  await interaction.deferReply({ ephemeral: true });
  const failures = await syncTicketPermissions(db, interaction.guild);
  await interaction.editReply(
    shouldAdd
      ? `تمت إضافة ${role} كرتبة ستاف. لا تمنح صلاحية تعديل إعدادات البوت.${failures.length ? ` تعذر تحديث ${failures.length} تكت؛ أُبلغت الإدارة.` : ''}`
      : `تمت إزالة ${role} من رتب الستاف وتحديث التكتات.${failures.length ? ` تعذر تحديث ${failures.length} تكت؛ أُبلغت الإدارة.` : ''}`,
  );
}

async function handleConfigCommand(db, interaction) {
  const name = interaction.commandName;
  if (name === 'store') return handleStoreCommand(db, interaction);
  if (name === 'cmd') {
    return interaction.reply({ embeds: commandHelp(), ephemeral: true });
  }

  if (name === 'sendpaymentinfo') {
    if (!(await requireStaff(interaction, db))) return;
    const ticket = database.getTicket(db, interaction.channelId, interaction.guildId);
    if (!ticket || ticket.kind !== 'purchase') return sendEphemeral(interaction, 'استخدم الأمر داخل تكت مناقشة طلب.');
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.order_id);
    if (!order || order.status !== 'Payment Pending') {
      return sendEphemeral(interaction, 'بيانات الدفع متاحة للطلب الذي حالته Payment Pending فقط.');
    }
    const wallet = database.getSetting(db, interaction.guildId, 'payment_wallet_ltc');
    if (!wallet) return sendEphemeral(interaction, 'لم تُحفظ محفظة LTC بعد. استخدم /setpaymentwallet.');
    await interaction.channel.send({
      content: `<@${order.customer_id}>`,
      allowedMentions: { users: [order.customer_id] },
      embeds: [new EmbedBuilder().setColor(0x7546ff).setTitle(`معلومات دفع ${formatOrderCode(order)}`)
        .setDescription([
          '**طريقة الدفع:** Litecoin (LTC)',
          `**المبلغ المتفق عليه مبدئيًا:** ${money(order.price_cents)}`,
          `**عنوان المحفظة:** \`${wallet}\``,
          'اتفق مع الستاف على تفاصيل التحويل قبل الإرسال. لا يُعتبر الطلب مدفوعًا حتى يؤكد الستاف الاستلام يدويًا.',
        ].join('\n'))],
    });
    return sendEphemeral(interaction, 'تم إرسال معلومات LTC داخل التكت.');
  }

  if (name === 'confirmpayment') {
    if (!(await requireStaff(interaction, db))) return;
    const ticket = database.getTicket(db, interaction.channelId, interaction.guildId);
    if (!ticket || ticket.kind !== 'purchase') return sendEphemeral(interaction, 'استخدم الأمر داخل تكت مناقشة طلب.');
    const paid = database.markOrderPaid(db, ticket.order_id, interaction.guildId, interaction.user.id);
    if (!paid) return sendEphemeral(interaction, 'تعذر التأكيد: يجب أن تكون حالة الطلب Payment Pending.');
    await interaction.channel.send(`أكد الستاف <@${interaction.user.id}> استلام الدفع للطلب **${formatOrderCode(paid)}** يدويًا. لا تُستخدم الصور وحدها كدليل.`);
    await ensureTicketPrompt(db, ticket, interaction.guild);
    return sendEphemeral(interaction, 'تم تسجيل الدفع يدويًا. يمكنك إكمال الطلب بعد تسليمه.');
  }

  if (name === 'completeorder') {
    if (!(await requireStaff(interaction, db))) return;
    const ticket = database.getTicket(db, interaction.channelId, interaction.guildId);
    if (!ticket || ticket.kind !== 'purchase') return sendEphemeral(interaction, 'استخدم الأمر داخل تكت مناقشة طلب.');
    const completed = database.completeOrder(db, ticket.order_id, interaction.guildId, interaction.user.id);
    if (!completed) return sendEphemeral(interaction, 'يجب تأكيد الدفع يدويًا قبل إكمال الطلب.');
    await interaction.channel.send(`تم تسجيل ${formatOrderCode(completed)} كمكتمل بواسطة <@${interaction.user.id}>.`);
    await ensureTicketPrompt(db, ticket, interaction.guild);
    return sendEphemeral(interaction, 'تم إكمال الطلب وحفظ سجل الحالة.');
  }

  if (!(await requireAdmin(interaction, db))) return;

  if (name === 'setowner' || name === 'removeowner') {
    const user = interaction.options.getUser(name === 'setowner' ? 'user' : 'replacement', true);
    if (user.bot || user.id === interaction.client.user.id) {
      return sendEphemeral(interaction, 'اختر عضوًا حقيقيًا في السيرفر ليكون الأونر.');
    }
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return sendEphemeral(interaction, 'يجب أن يكون الأونر عضوًا في هذا السيرفر.');
    const previousOwner = database.getSetting(db, interaction.guildId, 'owner_id');
    if (previousOwner === user.id) return sendEphemeral(interaction, 'هذا العضو هو الأونر الحالي بالفعل.');
    database.setSetting(db, interaction.guildId, 'owner_id', user.id, interaction.user.id);
    await interaction.deferReply({ ephemeral: true });
    const failures = await syncTicketPermissions(db, interaction.guild);
    await interaction.editReply(
      `تم تعيين <@${user.id}> كأونر وتحديث صلاحيات التكتات.${failures.length ? ` تعذر تحديث ${failures.length} تكت؛ أُبلغت الإدارة.` : ''}`,
    );
    return;
  }

  if (['addadminrole', 'removeadminrole'].includes(name)) {
    return changeAdminRole(
      db,
      interaction,
      interaction.options.getRole('role', true),
      name === 'addadminrole',
    );
  }

  if (['addstaffrole', 'removestaffrole'].includes(name)) {
    return changeStaffRole(
      db,
      interaction,
      interaction.options.getRole('role', true),
      name === 'addstaffrole',
    );
  }

  if (name === 'listadminroles') {
    const roleIds = getAdminRoleIds(db, interaction.guildId);
    const display = await Promise.all(roleIds.map(async (id) => {
      const role = await interaction.guild.roles.fetch(id).catch(() => null);
      return role ? `${role} (\`${role.id}\`)` : `رتبة غير موجودة (\`${id}\`)`;
    }));
    return sendEphemeral(interaction, display.length ? `**رتب الأدمن:**\n${display.join('\n')}` : 'لا توجد رتب أدمن مضبوطة.');
  }

  if (name === 'liststaffroles') {
    const roleIds = database.getStaffRoleIds(db, interaction.guildId);
    const display = await Promise.all(roleIds.map(async (id) => {
      const role = await interaction.guild.roles.fetch(id).catch(() => null);
      return role ? `${role} (\`${role.id}\`)` : `رتبة غير موجودة (\`${id}\`)`;
    }));
    return sendEphemeral(interaction, display.length
      ? `**رتب الستاف التشغيلية:**\n${display.join('\n')}`
      : 'لا توجد رتب ستاف تشغيلية مضبوطة.');
  }

  if (name === 'setorderschannel' || name === 'setticketcategory') {
    const channel = interaction.options.getChannel(name === 'setorderschannel' ? 'channel' : 'category', true);
    const expectedType = name === 'setorderschannel' ? ChannelType.GuildText : ChannelType.GuildCategory;
    if (channel.guildId !== interaction.guildId || channel.type !== expectedType) {
      return sendEphemeral(interaction, 'اختر قناة أو فئة من نفس السيرفر وبالنوع الصحيح.');
    }
    if (name === 'setorderschannel') {
      const botMember = await interaction.guild.members.fetchMe();
      const permissions = channel.permissionsFor(botMember);
      const required = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.EmbedLinks,
      ];
      if (!permissions || required.some((permission) => !permissions.has(permission))) {
        return sendEphemeral(interaction, 'امنح البوت View Channel وSend Messages وRead Message History وEmbed Links في قناة الطلبات.');
      }
    }
    const setting = name === 'setorderschannel' ? 'orders_channel_id' : 'ticket_category_id';
    database.setSetting(db, interaction.guildId, setting, channel.id, interaction.user.id);
    if (name === 'setorderschannel') await publishUnannouncedOrders(db, interaction.guild);
    return sendEphemeral(interaction, `تم حفظ ${channel} كإعداد جديد.`);
  }

  if (name === 'setpaymentwallet') {
    const wallet = interaction.options.getString('address', true).trim();
    if (wallet.length < 3 || wallet.length > 128 || /[\s<>@]/u.test(wallet)) {
      return sendEphemeral(interaction, 'أدخل عنوان LTC صالحًا دون مسافات أو منشنات.');
    }
    database.setSetting(db, interaction.guildId, 'payment_wallet_ltc', wallet, interaction.user.id);
    return sendEphemeral(interaction, 'تم حفظ عنوان محفظة LTC.');
  }

  if (name === 'setmentionuser') {
    const user = interaction.options.getUser('user', true);
    if (user.bot || !(await interaction.guild.members.fetch(user.id).catch(() => null))) {
      return sendEphemeral(interaction, 'اختر عضوًا حقيقيًا موجودًا في السيرفر.');
    }
    database.setSetting(db, interaction.guildId, 'mention_user_id', user.id, interaction.user.id);
    return sendEphemeral(interaction, `تم تحديد <@${user.id}> لرسائل الطلبات.`);
  }

  if (name === 'addproductbutton' || name === 'custom_button') {
    const productName = name === 'custom_button'
      ? interaction.options.getString('name', true).trim()
      : interaction.options.getString('product_name', true).trim();
    const buttonLabel = name === 'custom_button'
      ? productName
      : interaction.options.getString('button_name', true).trim();
    const ticketName = name === 'custom_button'
      ? productName
      : interaction.options.getString('ticket_name', true).trim();
    const priceCents = priceToCents(interaction.options.getNumber('price', true));
    if (!productName || productName.length > 100 || !buttonLabel || buttonLabel.length > 80 ||
        !ticketName || ticketName.length > 80 || !priceCents) {
      return sendEphemeral(interaction, 'تحقق من أسماء المنتج والزر والتكت ومن أن السعر موجب.');
    }
    if (database.listProducts(db, interaction.guildId).length >= MAX_ACTIVE_PRODUCTS) {
      return sendEphemeral(interaction, 'وصل المتجر إلى الحد الأقصى البالغ 25 زرًا. احذف زرًا قبل إضافة منتج.');
    }
    const product = database.addProduct(db, interaction.guildId, interaction.user.id, {
      productName, buttonLabel, ticketName, priceCents,
    });
    await refreshStorePanels(db, interaction.guild, interaction.guildId);
    if (name === 'custom_button') {
      const logoPath = path.join(__dirname, 'assets', 'vanta-market-logo.png');
      const panel = await interaction.channel.send({
        embeds: [storeEmbed([product])],
        components: storeComponents([product]),
        files: fs.existsSync(logoPath) ? [new AttachmentBuilder(logoPath)] : [],
      });
      db.prepare(`
        INSERT OR IGNORE INTO store_panels (guild_id, channel_id, message_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(interaction.guildId, interaction.channelId, panel.id, Date.now());
    }
    return sendEphemeral(interaction, `تمت إضافة المنتج **${product.product_name}** برقم \`P${product.id}\` إلى لوحة المتجر.`);
  }

  if (name === 'setbuttonname' || name === 'setticketname' || name === 'removeproductbutton' || name === 'editproduct') {
    const productId = interaction.options.getInteger('product_id', true);
    const product = database.getProduct(db, interaction.guildId, productId);
    if (!product) return sendEphemeral(interaction, 'لم يتم العثور على هذا المنتج في السيرفر.');
    if (name === 'removeproductbutton') {
      if (!database.removeProduct(db, interaction.guildId, productId)) {
        return sendEphemeral(interaction, 'هذا المنتج محذوف بالفعل.');
      }
      await refreshStorePanels(db, interaction.guild, interaction.guildId);
      return sendEphemeral(interaction, `تم حذف زر **${product.button_label}** من لوحات المتجر. تبقى الطلبات السابقة محفوظة.`);
    }
    const changes = {};
    if (name === 'setbuttonname') changes.buttonLabel = interaction.options.getString('name', true).trim();
    else if (name === 'setticketname') changes.ticketName = interaction.options.getString('name', true).trim();
    else {
      const productName = interaction.options.getString('product_name');
      const buttonName = interaction.options.getString('button_name');
      const ticketName = interaction.options.getString('ticket_name');
      const price = interaction.options.getNumber('price');
      if (productName !== null) changes.productName = productName.trim();
      if (buttonName !== null) changes.buttonLabel = buttonName.trim();
      if (ticketName !== null) changes.ticketName = ticketName.trim();
      if (price !== null) changes.priceCents = priceToCents(price);
      if (Object.values(changes).some((value) => typeof value === 'string' && !value)) {
        return sendEphemeral(interaction, 'لا يمكن حفظ اسم فارغ.');
      }
      if (price !== null && !changes.priceCents) return sendEphemeral(interaction, 'أدخل سعرًا موجبًا صالحًا.');
    }
    database.updateProduct(db, interaction.guildId, productId, changes);
    await refreshStorePanels(db, interaction.guild, interaction.guildId);
    return sendEphemeral(interaction, `تم تحديث المنتج \`P${productId}\`. الطلبات المحفوظة لا تتغير.`);
  }
}

async function handleTicketDelete(db, interaction) {
  if (!(await requireStaff(interaction, db))) return;
  const ticket = db.prepare(`
    SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ? AND status IN ('open', 'closed')
  `).get(interaction.channelId, interaction.guildId);
  if (!ticket) return sendEphemeral(interaction, 'هذه التذكرة غير مفتوحة أو غير مسجلة.');
  const updated = db.prepare(`
    UPDATE tickets SET status = 'closing' WHERE id = ? AND status IN ('open', 'closed')
  `).run(ticket.id);
  if (updated.changes !== 1) return sendEphemeral(interaction, 'بدأ إغلاق التذكرة بالفعل.');
  await interaction.deferReply({ ephemeral: true });
  try {
    const channel = await interaction.guild.channels.fetch(ticket.channel_id);
    if (!channel) throw new Error('قناة التذكرة غير موجودة.');
    await channel.delete(`Vanta Market ticket deleted by ${interaction.user.id}`);
    database.closeTicketRecord(db, ticket.id);
    if (ticket.kind === 'confirmation') {
      database.cancelInitialOrder(db, ticket.order_id, interaction.user.id, 'حذف الستاف تكت الطلب قبل إرساله');
    }
    await interaction.editReply('تم حذف القناة. بقي سجل التذكرة والطلب محفوظًا.');
  } catch (error) {
    db.prepare("UPDATE tickets SET status = ? WHERE id = ? AND status = 'closing'")
      .run(ticket.status, ticket.id);
    throw error;
  }
}

async function handleTicketFinish(db, interaction) {
  if (!(await requireStaff(interaction, db))) return;
  const ticket = database.getTicket(db, interaction.channelId, interaction.guildId);
  if (!ticket) return sendEphemeral(interaction, 'هذه التذكرة غير مفتوحة أو غير مسجلة.');
  await interaction.deferReply({ ephemeral: true });
  const channel = await interaction.guild.channels.fetch(ticket.channel_id);
  const closed = { ...ticket, status: 'closed' };
  await channel.permissionOverwrites.set(ticketOverwrites(interaction.guild, closed, db), 'Close Vanta Market ticket');
  db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'")
    .run(Date.now(), ticket.id);
  await channel.send({
    content: 'تم إغلاق التذكرة للعميل. سجل الطلب محفوظ؛ ويمكن للإدارة حذف القناة لاحقًا.',
    components: [ticketDeleteRow()],
  });
  await interaction.editReply('تم إغلاق التذكرة مع الاحتفاظ بسجل الطلب.');
}

async function handleOrderAction(db, interaction, action, orderId) {
  if (!(await requireStaff(interaction, db))) return;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND guild_id = ?')
    .get(orderId, interaction.guildId);
  if (!order) return sendEphemeral(interaction, 'لم يتم العثور على الطلب.');
  if (interaction.channelId !== order.discussion_channel_id) {
    return sendEphemeral(interaction, 'هذا الإجراء يعمل داخل تكت مناقشة الطلب فقط.');
  }
  if (action === 'paymentinfo') {
    const wallet = database.getSetting(db, interaction.guildId, 'payment_wallet_ltc');
    if (!wallet) return sendEphemeral(interaction, 'لم تُحفظ محفظة LTC بعد. استخدم /setpaymentwallet.');
    await interaction.channel.send({
      content: `<@${order.customer_id}>`,
      allowedMentions: { users: [order.customer_id] },
      embeds: [new EmbedBuilder().setColor(0x7546ff)
        .setTitle(`معلومات دفع ${formatOrderCode(order)}`)
        .setDescription(`**الطريقة:** LTC\n**المبلغ المبدئي:** ${money(order.price_cents)}\n**المحفظة:** \`${wallet}\`\nاتفق مع الستاف على التفاصيل. لا يُسجل الدفع إلا بعد تأكيد يدوي.`)],
    });
    return sendEphemeral(interaction, 'تم إرسال معلومات الدفع داخل التكت.');
  }
  if (action === 'paid') {
    const paid = database.markOrderPaid(db, orderId, interaction.guildId, interaction.user.id);
    if (!paid) return sendEphemeral(interaction, 'لا يمكن تأكيد الدفع إلا عندما تكون الحالة Payment Pending.');
    await interaction.channel.send(`أكد الستاف <@${interaction.user.id}> استلام الدفع يدويًا للطلب **${formatOrderCode(paid)}**.`);
    await interaction.message.edit({ embeds: [ticketEmbed(paid, 'purchase')], components: discussionComponents(paid) });
    return sendEphemeral(interaction, 'تم تسجيل الدفع يدويًا.');
  }
  if (action === 'complete') {
    const completed = database.completeOrder(db, orderId, interaction.guildId, interaction.user.id);
    if (!completed) return sendEphemeral(interaction, 'يجب تأكيد الدفع يدويًا قبل إكمال الطلب.');
    await interaction.channel.send(`تم إكمال الطلب **${formatOrderCode(completed)}** بواسطة <@${interaction.user.id}>.`);
    await interaction.message.edit({ embeds: [ticketEmbed(completed, 'purchase')], components: discussionComponents(completed) });
    return sendEphemeral(interaction, 'تم إكمال الطلب.');
  }
}

async function handleRejectionModal(db, interaction, orderId) {
  if (!(await requireStaff(interaction, db))) return;
  if (interaction.channelId !== database.getSetting(db, interaction.guildId, 'orders_channel_id')) {
    return sendEphemeral(interaction, 'يمكن رفض الطلب من قناة الطلبات فقط.');
  }
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const rejected = database.rejectOrder(db, orderId, interaction.guildId, interaction.user.id, reason || null);
  if (!rejected) return sendEphemeral(interaction, 'تمت معالجة الطلب مسبقًا أو لم يعد بانتظار القرار.');
  await interaction.deferReply({ ephemeral: true });
  await interaction.message.edit({ embeds: [orderEmbed(rejected)], components: [approvalButtons(orderId, true)] })
    .catch(() => {});
  const ticket = db.prepare(`
    SELECT * FROM tickets WHERE order_id = ? AND kind = 'confirmation' AND status = 'open'
  `).get(orderId);
  if (ticket?.channel_id) {
    const channel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (channel) await channel.send({
      content: `<@${rejected.customer_id}>`,
      allowedMentions: { users: [rejected.customer_id] },
      embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle(`رفض الطلب ${formatOrderCode(rejected)}`)
        .setDescription(reason ? `سبب الرفض: ${reason}` : 'تم رفض الطلب من الإدارة.')],
    }).catch(() => {});
  }
  await interaction.editReply(`تم رفض ${formatOrderCode(rejected)} وحفظ اسم الرافض${reason ? ' وسبب الرفض' : ''}.`);
  await archiveInitialTicket(db, ticket, interaction.guild, 'Order rejected; preserve the reason for the customer');
}

async function validateGuildSetup(client, config, db) {
  if (client.user.id !== config.clientId) {
    throw new Error('CLIENT_ID لا يطابق هوية البوت الذي سجّل الدخول.');
  }
  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) throw new Error('GUILD_ID غير صالح أو أن البوت غير موجود في هذا السيرفر.');
  await guild.fetch();
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    throw new Error('يحتاج البوت إلى صلاحية Manage Channels لإنشاء قنوات التكتات الخاصة.');
  }
  if (!database.getSetting(db, guild.id, 'owner_id')) {
    console.warn('لم يتم تعيين الأونر بعد؛ عيّنه بأمر /setowner قبل استقبال طلبات المتجر.');
  }
  const channelId = database.getSetting(db, guild.id, 'orders_channel_id');
  if (channelId) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guild.id) {
      console.error('قناة الطلبات غير صالحة؛ استخدم /setorderschannel بعد تشغيل البوت.');
    }
  } else {
    console.warn('لم تُحدد قناة الطلبات بعد؛ استخدم /setorderschannel داخل Discord.');
  }
  const categoryId = database.getSetting(db, guild.id, 'ticket_category_id');
  if (categoryId) {
    const category = await guild.channels.fetch(categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== guild.id) {
      console.error('فئة التكتات غير صالحة؛ استخدم /setticketcategory بعد تشغيل البوت.');
    }
  } else {
    console.warn('لم تُحدد فئة التكتات بعد؛ استخدم /setticketcategory داخل Discord.');
  }
  return guild;
}

async function reconcileTickets(db, guild) {
  const stale = db.prepare("SELECT * FROM tickets WHERE status = 'creating' ORDER BY id").all();
  for (const ticket of stale) {
    try {
      const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null) ||
        await guild.channels.fetch().then((channels) =>
          channels.find((item) => item?.type === ChannelType.GuildText && item.name === ticket.channel_name) || null,
        );
      if (channel) {
        database.saveInitialTicketChannel(db, ticket.id, channel.id);
        const refreshed = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
        await ensureTicketPrompt(db, refreshed, guild);
      } else if (Date.now() - ticket.created_at > TICKET_LEASE_MS) {
        database.recordTicketCreationFailure(db, ticket.order_id, ticket.id, null);
      }
    } catch (error) {
      console.error(`تعذرت استعادة التذكرة ${ticket.id}:`, error.message);
    }
  }
  const openTickets = db.prepare("SELECT * FROM tickets WHERE status IN ('open', 'closed') ORDER BY id").all();
  for (const ticket of openTickets) {
    try {
      if (ticket.status === 'open') await ensureTicketPrompt(db, ticket, guild);
    } catch (error) {
      console.error(`تعذر استعادة واجهة التذكرة ${ticket.id}:`, error.message);
    }
  }
  db.prepare(`
    UPDATE orders SET discussion_creation_started_at = NULL
    WHERE status = 'Accepted' AND discussion_channel_id IS NULL
      AND discussion_creation_started_at < ?
  `).run(Date.now() - TICKET_LEASE_MS);
  db.prepare(`
    UPDATE orders SET announcement_started_at = NULL
    WHERE status = 'Pending' AND customer_confirmed = 1 AND staff_message_id IS NULL
      AND announcement_started_at < ?
  `).run(Date.now() - TICKET_LEASE_MS);
}

function createClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
}

async function start() {
  const config = loadConfig();
  const db = database.createDatabase(config.databasePath);
  database.initializeGuildData(db, config);
  const client = createClient();
  client.config = config;
  client.database = db;
  client.db = db;
  let announcementRetryTimer = null;

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      const guild = await validateGuildSetup(readyClient, config, db);
      const rest = new REST({ version: '10' }).setToken(config.token);
      await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: COMMANDS.map(({ summary, access, ...command }) => command) },
      );
      try {
        await upgradeLegacyStorePanels(db, guild);
      } catch (error) {
        console.error('تعذر ترقية بعض لوحات المتجر القديمة:', error.message);
      }
      await syncTicketPermissions(db, guild);
      await reconcileTickets(db, guild);
      await publishUnannouncedOrders(db, guild);
      announcementRetryTimer = setInterval(() => {
        publishUnannouncedOrders(db, guild).catch((error) => {
          console.error('تعذرت إعادة محاولة إرسال الطلبات غير المعلنة:', error.message);
        });
      }, 60_000);
      announcementRetryTimer.unref();
      console.info(`تم تسجيل الدخول كبوت Vanta Market في السيرفر ${guild.name}.`);
    } catch (error) {
      console.error('فشل إعداد بوت Vanta Market:', error.message);
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
        await handleConfigCommand(db, interaction);
        return;
      }

      if (interaction.isButton()) {
        const id = interaction.customId;
        const productMatch = id.match(/^(?:product|custombuy):(\d+)$/);
        if (productMatch) {
          const productId = parsePositiveInteger(productMatch[1]);
          const product = productId ? database.getProduct(db, interaction.guildId, productId, true) : null;
          if (!product) return interaction.reply({ content: 'هذا المنتج غير متاح حاليًا.', ephemeral: true });
          return interaction.showModal(createQuantityModal(product));
        }
        const oldBuiltIn = id.match(/^shop:buy:(minecraft|digital_service)$/);
        if (oldBuiltIn) {
          const product = db.prepare(`
            SELECT * FROM products WHERE guild_id = ? AND product_key = ? AND active = 1
          `).get(interaction.guildId, oldBuiltIn[1]);
          if (!product) return interaction.reply({ content: 'هذا المنتج غير متاح حاليًا.', ephemeral: true });
          return interaction.showModal(createQuantityModal(product));
        }
        const ltcMatch = id.match(/^payment:ltc:(\d+)$/);
        if (ltcMatch) return await handleLtcChoice(db, interaction, parsePositiveInteger(ltcMatch[1]));
        const orderAction = id.match(/^order:(accept|reject|paymentinfo|paid|complete):(\d+)$/);
        if (orderAction) {
          const action = orderAction[1];
          const orderId = parsePositiveInteger(orderAction[2]);
          if (!orderId) return interaction.reply({ content: 'رقم الطلب غير صالح.', ephemeral: true });
          if (action === 'reject') {
            if (!(await requireStaff(interaction, db))) return;
            if (interaction.channelId !== database.getSetting(db, interaction.guildId, 'orders_channel_id')) {
              return interaction.reply({ content: 'ارفض الطلب من قناة الطلبات فقط.', ephemeral: true });
            }
            const reason = new TextInputBuilder().setCustomId('reason').setLabel('سبب الرفض (اختياري)')
              .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500);
            return interaction.showModal(new ModalBuilder().setCustomId(`reject:${orderId}`)
              .setTitle('رفض الطلب').addComponents(new ActionRowBuilder().addComponents(reason)));
          }
          if (action === 'accept') {
            if (!(await requireStaff(interaction, db))) return;
            if (interaction.channelId !== database.getSetting(db, interaction.guildId, 'orders_channel_id')) {
              return interaction.reply({ content: 'اقبل الطلب من قناة الطلبات فقط.', ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: true });
            return await acceptOrder(db, interaction, orderId, interaction.guild);
          }
          await interaction.deferReply({ ephemeral: true });
          return await handleOrderAction(db, interaction, action, orderId);
        }
        if (id === COMPONENT_IDS.deleteTicket) return await handleTicketDelete(db, interaction);
        if (id === COMPONENT_IDS.finishTicket) return await handleTicketFinish(db, interaction);
        if (id === 'shop:support') {
          return interaction.reply({ content: 'زر الدعم أزيل. استخدم أزرار المنتجات الحالية.', ephemeral: true });
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        const quantityMatch = interaction.customId.match(/^quantity:(\d+)$/);
        if (quantityMatch) {
          const productId = parsePositiveInteger(quantityMatch[1]);
          const product = productId ? database.getProduct(db, interaction.guildId, productId, true) : null;
          if (!product) return interaction.reply({ content: 'هذا المنتج غير متاح حاليًا.', ephemeral: true });
          const quantity = parsePositiveInteger(interaction.fields.getTextInputValue('quantity'), MAX_QUANTITY);
          if (!quantity) return interaction.reply({ content: `أدخل كمية صحيحة من 1 إلى ${MAX_QUANTITY}.`, ephemeral: true });
          await interaction.deferReply({ ephemeral: true });
          return await createOrderTicket(db, interaction, product, quantity, interaction.guild);
        }
        const rejectMatch = interaction.customId.match(/^reject:(\d+)$/);
        if (rejectMatch) {
          const orderId = parsePositiveInteger(rejectMatch[1]);
          if (!orderId) return interaction.reply({ content: 'رقم الطلب غير صالح.', ephemeral: true });
          return await handleRejectionModal(db, interaction, orderId);
        }
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
      await handleTicketConfirmation(db, message);
    } catch (error) {
      console.error('تعذر معالجة رسالة تكت الطلب:', error.message);
      await message.reply('تعذر معالجة رسالتك الآن. أعد المحاولة بعد قليل أو تواصل مع الإدارة.').catch(() => {});
    }
  });

  client.on(Events.Error, (error) => console.error('خطأ في اتصال Discord:', error.message));
  const stop = () => {
    if (announcementRetryTimer) clearInterval(announcementRetryTimer);
    db.close();
    client.destroy();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await client.login(config.token);
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`تعذر تشغيل بوت Vanta Market: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  COMMANDS,
  COMPONENT_IDS,
  createClient,
  createDatabase: database.createDatabase,
  hasAdminAccess,
  hasStaffAccess,
  loadConfig,
  orderEmbed,
  parsePositiveInteger,
  priceToCents,
  start,
  storeComponents,
  storeEmbed,
  ticketOverwrites,
  ticketEmbed,
};
