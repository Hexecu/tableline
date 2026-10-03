"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

function createDemo(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT,country TEXT NOT NULL,segment TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,price REAL NOT NULL CHECK(price>=0),currency TEXT NOT NULL,stock INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),status TEXT NOT NULL,total REAL NOT NULL CHECK(total>=0),currency TEXT NOT NULL,created_at TEXT NOT NULL,notes TEXT);
      CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),product_id INTEGER NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity>0),unit_price REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id);
      CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at);
      CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);`);
    if (db.prepare("SELECT count(*) AS n FROM orders").get().n) return;
    db.exec("BEGIN IMMEDIATE");
    const customers = db.prepare("INSERT INTO customers VALUES(?,?,?,?,?,?)");
    const names = [
      "Davide Leopardi",
      "Sofia Rossi",
      "Léa Martin",
      "Müller GmbH",
      "東京デザイン",
      "Lucía García",
      "André Silva",
      "Acme Studio",
      "Nordic Labs",
      "Zürich Tech",
    ];
    for (let i = 1; i <= 120; i++)
      customers.run(
        i,
        names[(i - 1) % names.length] + (i > 10 ? ` ${i}` : ""),
        i % 13 === 0 ? null : `hello${i}@example.com`,
        ["IT", "FR", "DE", "JP", "ES", "PT", "US", "SE", "CH", "GB"][
          (i - 1) % 10
        ],
        ["Enterprise", "Growth", "Starter"][i % 3],
        `2025-${String((i % 12) + 1).padStart(2, "0")}-01`,
      );
    const products = db.prepare("INSERT INTO products VALUES(?,?,?,?,?,?)");
    const productNames = [
      "Studio Display",
      "Mechanical Keyboard",
      "USB-C Hub",
      "Desk Light",
      "Notebook Pro",
      "Wireless Mouse",
      "Focus Headphones",
      "Laptop Stand",
      "4K Camera",
      "Travel Dock",
      "Cloud Backup",
      "Team Workspace",
    ];
    for (let i = 1; i <= 36; i++)
      products.run(
        i,
        productNames[(i - 1) % 12] + (i > 12 ? ` ${i}` : ""),
        ["Hardware", "Accessories", "Software"][i % 3],
        19.9 + (i % 11) * 35,
        ["EUR", "USD", "GBP"][i % 3],
        i % 9 === 0 ? 0 : 10 + i * 3,
      );
    const orders = db.prepare("INSERT INTO orders VALUES(?,?,?,?,?,?,?)");
    const items = db.prepare("INSERT INTO order_items VALUES(?,?,?,?,?)");
    let itemId = 1;
    for (let i = 1; i <= 1000; i++) {
      const productId = ((i * 7) % 36) + 1,
        quantity = (i % 4) + 1,
        price = 19.9 + (productId % 11) * 35;
      orders.run(
        i,
        ((i * 11) % 120) + 1,
        ["paid", "paid", "shipped", "pending", "cancelled", "refunded"][i % 6],
        Math.round(price * quantity * 100) / 100,
        ["EUR", "USD", "GBP"][productId % 3],
        `2026-${String((i % 9) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`,
        i % 17 === 0 ? "Consegna urgente · 日本語 ✓" : null,
      );
      items.run(itemId++, i, productId, quantity, price);
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    db.close();
    fs.chmodSync(filename, 0o600);
  }
}
module.exports = { createDemo };
