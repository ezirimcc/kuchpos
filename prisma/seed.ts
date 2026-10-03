/**
 * Fills the database with INVENTED sample data: one owner and two businesses,
 * each with one person per role. It first EMPTIES every table.
 *
 * Run with:  npm run db:seed
 *
 * It refuses to run against anything but a local development or test database
 * unless SEED_CONFIRM is set to that database's exact name (used for the online
 * test site only — never the live system).
 */
import { randomUUID } from "node:crypto";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { hashPassword } from "better-auth/crypto";
import "dotenv/config";
import { PrismaClient, type Role } from "../src/generated/prisma/client";

const ROLES: { role: Exclude<Role, "OWNER">; label: string }[] = [
  { role: "ADMIN", label: "Admin" },
  { role: "MANAGER", label: "Manager" },
  { role: "ACCOUNTANT", label: "Accountant" },
  { role: "CASHIER", label: "Cashier" },
  { role: "STOREKEEPER", label: "Storekeeper" },
];

type SampleUnit = { name: string; factor: string; price: string | null; forSale?: boolean };
type SampleProduct = {
  name: string;
  code: string;
  category: string;
  allowsFraction: boolean;
  taxable?: boolean;
  units: SampleUnit[];
};

// The first unit of each product is its base unit. Prices are invented.
const GREEN_VALLEY_PRODUCTS: SampleProduct[] = [
  {
    name: "Tomato Seed Sachet",
    code: "GV-SEED-01",
    category: "Seeds",
    allowsFraction: false,
    units: [
      { name: "sachet", factor: "1", price: "500.00" },
      { name: "pack", factor: "10", price: "4500.00" },
      { name: "carton", factor: "100", price: "42000.00" },
    ],
  },
  {
    name: "NPK 15-15-15 Fertilizer",
    code: "GV-FERT-01",
    category: "Fertilizers",
    allowsFraction: true,
    units: [
      { name: "kg", factor: "1", price: "1250.50" },
      { name: "bag", factor: "50", price: "58000.00" },
    ],
  },
  {
    name: "Liquid Herbicide",
    code: "GV-HERB-01",
    category: "Crop protection",
    allowsFraction: true,
    units: [
      { name: "litre", factor: "1", price: "6500.00" },
      { name: "250 ml bottle", factor: "0.25", price: "1800.00" },
      { name: "5 litre keg", factor: "5", price: "30000.00" },
    ],
  },
  {
    name: "Maize Grain (untaxed sample)",
    code: "GV-GRAIN-01",
    category: "Grains",
    allowsFraction: true,
    taxable: false,
    units: [
      { name: "kg", factor: "1", price: "900.00" },
      { name: "bag", factor: "100", price: "85000.00" },
    ],
  },
];

const SUNRISE_PRODUCTS: SampleProduct[] = [
  {
    name: "Layer Mash Poultry Feed",
    code: "SF-FEED-01",
    category: "Feeds",
    allowsFraction: true,
    units: [
      { name: "kg", factor: "1", price: "780.00" },
      { name: "bag", factor: "25", price: "18500.00" },
    ],
  },
  {
    name: "Poultry Vaccine Vial",
    code: "SF-VAC-01",
    category: "Animal health",
    allowsFraction: false,
    units: [
      { name: "vial", factor: "1", price: "2200.00" },
      { name: "box", factor: "20", price: "40000.00" },
    ],
  },
];

const BUSINESSES = [
  { name: "Green Valley Agro (sample)", prefix: "gv", short: "Green Valley", products: GREEN_VALLEY_PRODUCTS },
  { name: "Sunrise Farm Supplies (sample)", prefix: "sf", short: "Sunrise", products: SUNRISE_PRODUCTS },
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const password = process.env.SEED_PASSWORD;
  if (!connectionString) throw new Error("DATABASE_URL is not set. See .env.example.");
  if (!password || password.length < 8) {
    throw new Error("SEED_PASSWORD is not set (or is shorter than 8 characters). See .env.example.");
  }

  const databaseName = new URL(connectionString).pathname.replace(/^\//, "");
  const isLocalSample = /_(dev|test)$/.test(databaseName);
  if (!isLocalSample && process.env.SEED_CONFIRM !== databaseName) {
    throw new Error(
      `Refusing to wipe and seed "${databaseName}". This command is for sample-data databases only. ` +
        `To seed the online TEST site, set SEED_CONFIRM to the database name. Never do this on the live system.`,
    );
  }

  const url = new URL(connectionString);
  const db = new PrismaClient({
    adapter: new PrismaMariaDb({
      host: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: databaseName,
      connectionLimit: 2,
      initSql: "SET time_zone = '+00:00'",
    }),
  });
  const passwordHash = await hashPassword(password);

  const person = (name: string, username: string, role: Role, businessId: string | null) => {
    const id = randomUUID();
    return db.user.create({
      data: {
        id,
        name,
        username,
        displayUsername: username,
        email: `${username}@users.kuchpos.invalid`,
        role,
        businessId,
        accounts: {
          create: { id: randomUUID(), accountId: id, providerId: "credential", password: passwordHash },
        },
      },
    });
  };

  // The activity log refuses row deletions (database trigger), so it is emptied with TRUNCATE.
  await db.$executeRawUnsafe("TRUNCATE TABLE `activity_log`");
  await db.$executeRawUnsafe("TRUNCATE TABLE `price_change`");
  await db.$executeRawUnsafe("TRUNCATE TABLE `tax_rate_change`");
  await db.productUnit.deleteMany();
  await db.product.deleteMany();
  await db.category.deleteMany();
  await db.terminal.deleteMany();
  await db.location.deleteMany();
  await db.rateLimit.deleteMany();
  await db.session.deleteMany();
  await db.account.deleteMany();
  await db.verification.deleteMany();
  await db.user.deleteMany();
  await db.business.deleteMany();

  await person("Sample Owner", "owner", "OWNER", null);
  const usernames = ["owner"];

  for (const business of BUSINESSES) {
    const created = await db.business.create({
      data: { name: business.name, nameKey: business.name.toLowerCase() },
    });
    for (const { role, label } of ROLES) {
      const username = `${business.prefix}.${label.toLowerCase()}`;
      await person(`${business.short} ${label}`, username, role, created.id);
      usernames.push(username);
    }

    await db.location.createMany({
      data: [
        { businessId: created.id, name: "Shelf", kind: "SHELF" },
        { businessId: created.id, name: "Storeroom", kind: "STOREROOM" },
      ],
    });
    await db.terminal.create({ data: { businessId: created.id, code: "T1", name: "Checkout 1", paperWidth: "MM80" } });

    const categoryIds = new Map<string, string>();
    for (const name of new Set(business.products.map((sample) => sample.category))) {
      const category = await db.category.create({ data: { businessId: created.id, name } });
      categoryIds.set(name, category.id);
    }

    for (const sample of business.products) {
      const product = await db.product.create({
        data: {
          businessId: created.id,
          categoryId: categoryIds.get(sample.category),
          name: sample.name,
          code: sample.code,
          allowsFraction: sample.allowsFraction,
          taxable: sample.taxable ?? true,
        },
      });
      for (const [index, unit] of sample.units.entries()) {
        const row = await db.productUnit.create({
          data: {
            businessId: created.id,
            productId: product.id,
            name: unit.name,
            activeName: unit.name,
            factor: unit.factor,
            isBase: index === 0,
            forSale: unit.price !== null,
            price: unit.price,
          },
        });
        if (unit.price !== null) {
          await db.priceChange.create({
            data: {
              businessId: created.id,
              productId: product.id,
              productUnitId: row.id,
              unitName: unit.name,
              oldPrice: null,
              newPrice: unit.price,
              changedByName: "Sample data",
            },
          });
        }
      }
    }
  }

  await db.$disconnect();
  console.log(`Sample data loaded into "${databaseName}".`);
  console.log(`Sample usernames: ${usernames.join(", ")}`);
  console.log("They all share the password set as SEED_PASSWORD in your .env file.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
