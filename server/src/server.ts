import { env } from "./env";
import { buildApp } from "./app";
import { startRoundCheckCron } from "./cron/round-check";
import { seedAdminAccount } from "./seed/admin-seed";
import { seedAll } from "./db/seed";

async function main() {
  const app = await buildApp({ env });

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}. Shutting down gracefully...`);
      await app.close();
      process.exit(0);
    });
  }

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`NEON//DUSK running at http://${env.HOST}:${env.PORT}`);
    // ND-052: seed admin account from env vars (idempotent).
    await seedAdminAccount();
    // ND-054: seed content catalog (chrome, vendors, gigs, loot) — idempotent upserts.
    await seedAll();
    // ND-017: hourly round-expiry check (single-instance MVP, ADR-4).
    startRoundCheckCron(app);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
