# Vanta Market Discord Bot

Arabic Discord shop and private-ticket bot. Its product catalog, role permissions, channel settings, and order lifecycle are managed with Discord slash commands and stored in SQLite.

## Run & Operate

- `pnpm --filter @workspace/vanta-market-bot run check` — syntax-check the bot and database modules
- `pnpm --filter @workspace/vanta-market-bot test` — run the bot's SQLite and permission tests
- `pnpm --filter @workspace/vanta-market-bot start` — start the Discord bot
- Required secret: `DISCORD_TOKEN`
- Required shared environment: `CLIENT_ID`, `GUILD_ID`
- Optional initial settings: `STAFF_ROLE_ID`, `ORDERS_CHANNEL_ID`, `TICKET_CATEGORY_ID`, `ORDER_NOTIFY_USER_ID`, `DATABASE_PATH`

## Stack

- pnpm workspace monorepo, Node.js 20+
- Bot: CommonJS, discord.js v14
- Bot data: SQLite through better-sqlite3
- The bot does not serve HTTP; its runtime is separate from the API and mockup artifacts.

## Where things live

- `bots/vanta-market-bot/index.js` — Discord commands, interactions, private channel permissions, and startup registration.
- `bots/vanta-market-bot/database.js` — SQLite schema, legacy migration, product settings, tickets, orders, and status transitions.
- `bots/vanta-market-bot/test/bot.test.js` — automated database, migration, order-state, and permission-overwrite tests.
- `bots/vanta-market-bot/README.md` — setup, commands, and Discord permission limitations.

## Architecture decisions

- Keep one bot process per SQLite database; order/ticket records are durable and are not removed when a Discord channel is deleted.
- Payment is confirmed manually by authorized staff; accepting an order never marks it paid.
- Ticket channels deny `ViewChannel` to `@everyone`; Discord's server-wide `Administrator` permission bypasses channel overwrites.

## Product

Customers select a product, quantity, and LTC, then type an Arabic confirmation to submit a persistent order. Authorized users review it, create a private discussion ticket, coordinate payment, and manually record payment and completion.

## User preferences

Preserve the existing Vanta Market bot and its data. Do not replace it with a new bot. Bot settings are administered through protected slash commands; operational staff roles can process orders but cannot change bot settings.

## Gotchas

- Put `DISCORD_TOKEN` in Replit Secrets, never in source or `.env.example`.
- Enable Discord Message Content Intent for typed customer confirmation.
- The bot needs Manage Channels, channel access to Orders and the ticket category, and a higher role than configured admin roles.
- Test with `pnpm --filter @workspace/vanta-market-bot run check && pnpm --filter @workspace/vanta-market-bot test`.

## Pointers

- Bot setup details and `/cmd` command inventory are in `bots/vanta-market-bot/README.md`.
