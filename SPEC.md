# KuchPos — Specification

**Status:** Draft 4 — hosting moved to the owner's existing HOSTAFRICA plan and the database changed to MariaDB (2026-10-02); Batch 1 and Batch 2 answered; permission table and proposed defaults accepted · **Date:** 2026-10-01 · **Nothing has been built yet.**

KuchPos is a point-of-sale (POS) and inventory application for agricultural products shops. It holds several independent businesses, each kept completely separate.

How to read this document:

- **Confirmed** = you told me this. I treat it as fixed.
- **Proposed** = my suggested default.
- **Open** = I need an answer from you before the related part can be built.

> **Accepted on 2026-10-01:** you approved the permission table (§5) and all proposed defaults (§7, and the items marked "Proposed" inside §4 and §8). They are now treated as **confirmed**, except where §10 still lists a question. The word "Proposed" is left in place so you can see which items came from me rather than from you.

---

## 1. Goals

1. Cashiers can sell quickly and correctly, in any unit, with any mix of payment methods.
2. The owner always knows how much stock is on the shelf and in the storeroom, and why it changed.
3. The owner always knows who owes the shop money, and how much.
4. Managers and the accountant can see reports from their own computers over the internet.
5. Every change to stock or money can be traced to a person, a time, and a reason.

## 2. Confirmed requirements

| # | Requirement |
|---|---|
| C1 | Modern, easy-to-use web application, used mainly on computers. |
| C2 | Online access from separate computers for managers and the accountant. |
| C3 | Individual staff accounts with roles and permissions. Starting roles: admin, manager, accountant, cashier, storekeeper. |
| C4 | Separate **shelf** and **storeroom** stock. Receive goods, transfer between locations, count stock, record adjustments with reasons. |
| C5 | Several units per product. One base unit, plus other units with conversions specific to that product (e.g. single = 1, pack = 10 singles, carton = 100 singles). |
| C6 | Each selling unit has its own price. A pack or carton price may already include a bulk discount. |
| C7 | All units draw from one base-unit stock balance per location. Purchases, transfers and sales all let the user choose a unit. |
| C8 | Some products are sold by weight (e.g. base unit kilogram, a bag = 50 kg, a sale of 2.5 kg). |
| C9 | Payments: cash, external card/POS terminal, bank transfer, split payments, and credit. Version 1 only *records* external payments; no direct link to banks or terminals. |
| C10 | Customer accounts showing credit sales, part payments, outstanding balance, later repayments. |
| C11 | Extra discounts need a manager's approval. Preset unit prices do not. Record cashier, approving manager, reason, amount, time. The approval is valid only for that specific sale and that specific discount. |
| C12 | Reports on sales, collections, stock movement and customer debt, for authorised users only. |
| C13 | Basic offline checkout is wanted. Design for it from the start; build it after the online workflows are dependable. |
| C14 | **Currency: Nigerian Naira (₦) with kobo.** Most prices are whole Naira, but kobo must be supported (two decimal places). |
| C15 | **Tax rate is a setting**, changeable in the app because the rate changes in Nigeria. **Default 0%.** |
| C16 | **Several independent businesses: 5 now, possibly 20.** Each has its own products, prices, stock, customers, staff, settings and reports. Nothing is shared and nothing moves between them. **There is no "branch" level.** |
| C17 | **Owner role.** An owner has full admin rights in every business and can view all businesses. There can be several owners. |
| C18 | Checkout computers run **Windows**. |
| C19 | Receipts print on a **58 mm or 80 mm receipt printer**. A **barcode scanner** will be added in future; products have no barcodes today. |
| C20 | Existing records are in **Excel**. **Admins can import records from Excel** into the app. |
| C21 | **Tax:** shelf prices **include** tax. Each product has a **"taxable" tick-box**. |
| C22 | **Internet/power outages are frequent.** Offline checkout is therefore required **before go-live**, not after. |
| C23 | **One checkout computer per business** today; more may be added later. |
| C24 | **Automatic sign-out is a setting per business**, changed by that business's admin. A screen left unused for longer than the setting asks for the password again. |
| C25 | **Everyone can change their own password** after signing in (they must type their current password first). |
| C27 | **No special prices per customer.** Every customer pays the same preset unit prices. |
| C28 | **Cart discount as a percentage or an amount.** At the cart, a discount can be entered either as a percentage or as a Naira value. It is allowed only when approved by a manager or someone above (admin, owner). The system always stores the resulting Naira amount. |
| C29 | **No product images.** The app does not store pictures of products, to keep it fast and light. |
| C30 | **Product categories.** Each business keeps its own list of categories; a product can be placed in one. Lists can be filtered by category. |
| C31 | **Long lists are split into pages and can be filtered.** Every screen with a table shows a page at a time, with search that updates as you type and filters suited to the list (products: category; activity log: date range and text). |
| C32 | **Modern dashboard look**, following the reference design the owner supplied on 2026-10-03: soft grey background, large rounded panels, lime and deep-green gradients, pill-shaped buttons — without slowing the app down. Includes: a **light / dark mode switch**; a **side menu that collapses** to icons only and expands to icons with titles; a **user menu** (drop-down under the person's name) holding Profile, Change password and Sign out; the menu item is named **"Products & Categories"**. |
| C33 | **Home dashboard**: a greeting by time of day ("Good morning, Name") with snapshot figures. It shows only figures the person's role may see. Sales, collections and debt figures appear on it as those features are built. |
| C34 | **Profile page**: basic information about the signed-in person (name, username, role, business, when the account was created), with the change-password form. **Each person can edit their own full name and username** (they must type their current password; the change is recorded in the activity log). Role and business can only be changed by an admin or owner. |
| C35 | **Backdating a delivery.** Admins and managers (and owners) may record a delivery with an earlier date, but only with a written note explaining why. Storekeepers cannot. Every backdated delivery is marked as such and recorded in the activity log. Future dates are never allowed. |
| C36 | **Cost prices on deliveries** are visible to storekeepers, managers and admins. |
| C37 | **Batch number and expiry date are per product.** When a product is created (or edited), two tick-boxes say whether it uses a batch number and whether it uses an expiry date. Deliveries of such a product must give them; other products are never asked. |
| C38 | **"Expiring soon" is a setting.** Each business's admin sets how many months ahead counts as expiring soon (default 3). |
| C39 | **Deliveries can be corrected after saving, without losing history** (owner's requirement, 2026-10-06). A correction never overwrites: every version of the delivery is kept as an unchangeable snapshot (the original is version 1), and every changed field is recorded with its previous value, new value, who, when and a required reason. Stock is corrected by a new, compensating stock movement — past movements are never edited. A correction that would leave less than zero in a location is refused. The corrected delivery, its history, the stock movements, the balances and the average cost are saved together or not at all. Only admins, managers and owners may correct. Corrected deliveries are marked, and their full history is shown. Nothing in the history can be deleted. |
| C40 | **Adjustment reasons are a fixed list plus a note** (owner, 2026-10-07): Damaged, Expired, Missing or stolen, Counting error, Found, Sample or gift, Data entry error, Other. A note is required with "Other". The reason is chosen per product line, so reports can later say how much was lost to each cause. |
| C41 | **Stock counts are "blind"** (owner, 2026-10-07): while counting, the sheet does not show what the system expects. The expected quantity and the difference are shown once the count is submitted. |
| C42 | **A count may cover part of a location** (owner, 2026-10-07): the sheet can be narrowed to a category, and only the products actually filled in are counted — a product left blank is "not counted", never "zero". |
| C43 | **Delivery corrections by a manager need no second approval** (owner, 2026-10-07). |
| C44 | **What a sales receipt shows** (owner, 2026-10-07; answers Q14): business name; the header text from Settings (address, phone); the business's tax number (TIN), a new optional setting, printed only if filled in; receipt number; date and time; cashier's name; each item with unit, quantity, unit price and line total; the total; amount paid and change; the footer text from Settings (return policy, thank-you line). The tax amount is printed only when the tax rate is above 0%. |
| C45 | **After a sale is saved** (owner, 2026-10-07): the receipt is shown and the print window opens automatically, with "New sale" ready for the Enter key. A receipt can be printed again later from the sale's page and is then marked "REPRINT". |
| C46 | **Payment methods are a list the admin manages** (owner, 2026-10-07). Each has a name the business chooses (for example "Transfer – GTBank", "POS – Moniepoint") and a kind: cash, bank transfer or POS/card. The kind is what tells the till how much cash should be in the drawer. "Cash" always exists and cannot be removed. A method that has been used is switched off, never deleted. The method is chosen at checkout; one sale may be split across several; transfer and POS payments may carry a reference number. |
| C47 | **A sale can be kept pending while another is made** (owner, 2026-10-07). A pending sale is kept on that checkout computer for the cashier who parked it (up to 10), survives a page reload, reserves no stock, and has its prices and stock checked again when it is completed. It is not a sale until completed. |
| C48 | **Admins and managers can cancel a sale with a note** (owner, 2026-10-07), for example when the customer changes their mind. Whole sale only, on the same business day. The sale stays on record marked "Cancelled"; its stock goes back to where it came from by new movements; the refund is recorded against the till so the till still balances. Part of a sale, or a sale from an earlier day, is a return (M13). |
| C49 | **Customer details** (owner, 2026-10-07): name and phone are required; address, city and state are optional. A sale with no customer chosen is a walk-in. A customer is required only for a credit sale. |
| C50 | **Order of the selling milestones** (owner, 2026-10-07): M9 payment methods, split payments and till sessions → M9b pending sales and cancelling a sale → M10 customers and credit → M11 discounts. |
| C51 | **A till belongs to a checkout computer** — one cash drawer — not to a person (owner, 2026-10-08). The cashier's count at closing is blind, **and the cashier is not told whether it balanced**: the expected cash and the difference are shown only to those who review tills (admin, manager, accountant, owner). A closing note is optional. Each payment method is used at most once per sale. |
| C52 | **A manager or admin can recount a closed till on the same business day** (owner, 2026-10-08). Each recount is saved as a separate record with who, when, the amount counted and a note; the cashier's own closing count is never replaced. |
| C26 | **Zero extra hosting budget.** The app is hosted on the existing HOSTAFRICA web hosting account at **`pos.kuch99.com`**, and uses the **MariaDB** database included in that plan. |

## 3. Out of scope for version 1

- Direct integration with banks, card terminals or mobile money.
- Full accounting (general ledger, payroll, tax filing). KuchPos produces figures the accountant can export.
- Online shop / customer-facing website.
- Phone-first layouts (the app will open on a phone, but is designed for computer screens).
- Product pictures (confirmed not wanted).
- Customer-specific price lists (confirmed not needed).
- Supplier purchase orders and supplier debt tracking (only *receiving goods* is included; see §7, P9).
- Moving stock, customers or debts between businesses (confirmed not needed).
- Branches inside a business (confirmed not needed).
- Charging businesses a subscription for using KuchPos, or letting a business sign itself up.

---

## 4. How the main features will work

### 4.1 Products, units and prices

- Every product has exactly one **base unit** (e.g. "single", "kg", "litre"). Stock is always stored in the base unit.
- A product can have any number of **other units**. Each has a name and a **conversion**: how many base units it contains (pack = 10, carton = 100, bag = 50 kg).
- Each unit can be marked as usable for **selling**, **purchasing/receiving**, or both.
- Each selling unit has **its own price**. The carton price does not have to equal 100 × the single price.
- A product is marked either **whole-number only** (you cannot sell 2.5 cartons of sachets) or **fractional allowed** (you can sell 2.5 kg). Fractional quantities are kept to 3 decimal places (so kilograms are accurate to the gram).
- **Changing settings never rewrites history.** Every sale line, receipt line and transfer line stores a copy of the unit name, the conversion and the price *as they were at that moment*. If you later change "carton" from 100 to 96, old sales still say 100.
- A unit that has already been used in a transaction cannot be deleted or have its conversion edited in place. It is retired and a new unit is created. A product's base unit cannot be changed once it has any stock history.
- Price changes are kept in a price history (old price, new price, who, when).
- A product's **name, code, barcode, category and taxable tick can be changed at any time**. What cannot change is its base unit and whether it is sold in whole units or by weight/volume.
- **Categories** (for example Seeds, Fertilizers, Feeds) belong to one business. A category that still has products in it cannot be removed; rename it or move the products first.

### 4.2 Stock locations and stock movements

- A **business** has **locations**. Version 1 starts with two per business: **Shelf** and **Storeroom**. (The design allows more locations later without rework.)
- Stock belongs to one business. Transfers happen only between locations **inside the same business**.
- Each product has one stock balance **per location**, in base units.
- Stock only ever changes through a recorded **stock movement**. Each movement stores: product, location, quantity change in base units, the unit and conversion the user picked, type, the document it belongs to, who did it, and when. Movements are never edited or deleted — a mistake is fixed by a new, opposite movement.
- Movement types:
  - **Goods received** — stock arrives from a supplier into a chosen location (usually Storeroom). Records supplier, unit, quantity, cost price, and — for products that use them — batch number and expiry date. A delivery normally carries today's date; an admin or manager may give an earlier date with a note (C35). The stock itself changes at the moment the delivery is saved, whatever date it carries. A saved delivery can later be **corrected** by an admin or manager with a reason (C39): the supplier, date, invoice number, note, location, and each line's unit, quantity, cost, batch and expiry can be changed, and lines added or removed. The original and every later version stay on record.
  - **Transfer** — moves stock between Storeroom and Shelf. One document, two movements (out of one, into the other), saved together. Any of the product's units may be chosen. A transfer of more than the location holds is refused whole. A saved transfer is never changed; a mistake is put right with a transfer the other way. The list of transfers can be read by everyone who can read the stock reports (admin, manager, accountant, storekeeper).
  - **Sale** — takes stock out of the selling location.
  - **Stock count** — staff enter what they physically counted in one location, in any of the product's units (for example 2 cartons and 7 singles); the system records what it expected at that moment and shows the difference (C41, C42). A saved count is never changed. The differences of a count can be turned into one adjustment, once.
  - **Adjustment** — adds to or takes from the stock of one location, always with a **reason** per line chosen from a list (C40). It is stored as a difference ("5 fewer"), never as "set to 95", so anything sold or moved between counting and applying is not wiped out. A storekeeper's adjustment waits for an admin or manager to approve or reject it (P5); an admin's or manager's applies at once. An adjustment that would take out more than is there cannot be applied. Adjustments do not change the average cost.
  - **Return** *(proposed, §7)*.
- **Stock cannot go below zero** while online. If the Shelf has 3 and the cashier tries to sell 5, the sale is refused with a clear message.

### 4.3 Checkout (selling)

1. Cashier finds a product by name, code, or barcode.
2. Cashier picks the unit (single / pack / carton / kg…) and quantity. The preset price for that unit fills in automatically.
3. Optional: attach a customer (required for credit sales).
4. Optional: request an extra discount (needs manager approval, §4.5).
5. Take payment: one method or several (split).
6. The sale is saved, stock is reduced, payments are recorded, and a receipt is shown for printing.

Rules:

- **All or nothing.** The sale, its stock movements, its payments and any customer debt are saved in one step. If any part fails, none of it is saved.
- **No double sales.** Each sale gets a unique ID on the cashier's computer before it is sent. If the Save button is pressed twice, or the network repeats the request, the server recognises the ID and saves it only once.
- **Two cashiers at once.** If two cashiers try to sell the last item at the same moment, exactly one succeeds; the other gets an "insufficient stock" message.
- A completed sale is never edited. Corrections happen by cancelling the whole sale on the same day (C48) or, later or in part, by a return *(proposed, §7)*.
- A sale in progress can be parked as a **pending sale** and picked up again later on the same computer (C47).
- **Proposed:** sales take stock from the **Shelf** by default; a permitted user can choose **Storeroom** for a line (useful for 50 kg bags that never sit on the shelf). Permitted users are managers, admins and owners (accepted as P7).
- **Till sessions** (built at M9): a till session belongs to one checkout terminal — one cash drawer. It is opened with the cash in the drawer (the float) and closed with a count. A terminal has one open session at a time, and **nothing can be sold at a terminal whose till is not open**. Whoever may sell can sell into the open till (each sale still records who made it); the person who opened it, or an admin or manager, closes it. Expected cash = float + cash payments (change given is already left out). The count is **blind** (C51): the person running the till is never shown the expected cash or whether the count balanced; admins, managers and accountants can see both at any time. An admin or manager may **recount** a closed till on the same business day, as a separate record (C52). This is what makes the cash collections report trustworthy.

### 4.4 Payments and customer accounts

- Payment methods are a list managed by the admin (C46), each of the kind **cash**, **bank transfer** or **POS/card** (recorded, with optional reference number); plus **Credit** (added to the customer's account), which is not in the list.
- **Split payment:** any combination. The parts must add up exactly to the sale total.
- Cash: the app records amount tendered and change given.
- **Credit sales** require a named customer account. Walk-in customers cannot buy on credit.
- Each customer has an **account history** that only grows: credit sales increase the balance, repayments reduce it. The outstanding balance is always the sum of that history, so it can always be explained line by line.
- **Repayments** can be made at any time, by any payment method, in part or in full. **Proposed:** a repayment is applied to the oldest unpaid sale first, unless the user picks a specific sale.
- A customer **statement** shows every credit sale, every repayment and the running balance.

### 4.5 Extra discounts and manager approval

- A preset unit price (including a cheaper carton price) is **not** a discount and needs no approval.
- An **extra discount** is any reduction below the preset price, on one line or on the whole sale. It can be typed as a **percentage** or as a **Naira amount**; the system works out and stores the Naira amount.
- Flow: cashier enters the discount and a reason → a manager approves it → the sale can be completed.
- **Two ways to approve (proposed):** (a) the manager types their own username and password/PIN on the cashier's screen, or (b) the manager approves from their own computer, in a "waiting for approval" list.
- The approval is tied to **that sale and that exact discount**. If the cashier changes the items, quantities or discount afterwards, the approval no longer matches and a new one is needed. An approval can be used once, and expires if unused (**proposed:** 10 minutes).
- Stored for every approval: cashier, approving manager, reason, discount amount, time requested, time approved, and the sale it was used on.
- The server checks the approval when saving the sale. Hiding the button is not the protection; the server check is.

### 4.6 Reports

All reports cover one business at a time. They can be filtered by date range and (where it applies) location, cashier, product or customer, and exported as a spreadsheet file (CSV).

| Report | Shows |
|---|---|
| Sales | Sales by day, product, unit, cashier; discounts given; (proposed) cost and profit margin |
| Collections | Money actually received, by method (cash / card / transfer), by cashier and till session; includes debt repayments |
| Stock on hand | Current quantity per product per location, shown in base units and in larger units |
| Stock movement | Every change to stock for a product or period, with who and why |
| Customer debt | Outstanding balance per customer, age of debt, statement per customer |
| Discounts & approvals | Every extra discount: cashier, approver, reason, amount |
| Activity log | Who changed what and when (staff, prices, settings) |

### 4.7 Businesses and owners

Two levels:

```
KuchPos (the whole system)          ← owners work here, across all businesses
 └─ Business   e.g. "Kuch Agro – Main Market"   ← completely separate from other businesses
     ├─ Locations   Shelf, Storeroom
     ├─ Terminals   the checkout computer(s)
     ├─ Products, units, prices
     ├─ Customers and their debts
     └─ Staff       admin, manager, accountant, cashier, storekeeper
```

- Each **business** is sealed off. Its products, prices, stock, customers, staff, settings and reports are invisible to every other business. A customer who owes one business owes nothing at another. This is checked on the server for every request, not just hidden on screen.
- Each **staff member** (admin, manager, accountant, cashier, storekeeper) belongs to **exactly one business**.
- **Owners** sit above the businesses:
  - An owner can **create a business**, rename it, and deactivate it (deactivated = nobody can sign in to it; its records are kept).
  - An owner can **open any business** and do anything its admin can do. The owner picks which business to work in from a list; the screen always shows clearly which business is open.
  - An owner can create and disable **other owners**. The system refuses to disable the last remaining owner.
  - An owner sees an **overview page** listing every business side by side (e.g. today's sales, cash collected, outstanding customer debt). Figures are shown per business and are not mixed together.
  - Everything an owner does inside a business is written to that business's activity log under the owner's name.
- A person needing ordinary access to two businesses gets two separate accounts (or is made an owner).

### 4.8 Importing from Excel

- A business **admin** (or an owner) can bring in existing records from Excel instead of typing them. An import always goes into the one business that is open.
- What can be imported: **products with their units and prices**, **opening stock per location**, **customers**, and **customers' opening debts**. (Suppliers too, if useful.)
- How it works:
  1. Download a **template** spreadsheet from the app (the columns the app expects, with an example row).
  2. Copy your data into the template and upload it.
  3. The app shows a **preview**: how many rows are fine, and for each problem row, the row number and what is wrong ("row 14: price is not a number").
  4. Nothing is saved until you press Confirm. **The whole file is saved, or none of it** — never half a file.
- Imports are **traceable**: each one is recorded (who, when, which file, how many rows). Imported opening stock is recorded as "opening balance" stock movements, and imported debts as "opening balance" entries on the customer's account, so they appear in the history like everything else.
- Uploading the same file twice by mistake is detected and refused.
- Import is meant for **setting up** a business. Day-to-day changes are made on the normal screens.
- Because the businesses are independent, each one is imported separately. The same template can be reused, so a shared product list can be loaded into each business in turn.

### 4.9 Tax

- **Confirmed:** the tax rate is a **setting per business**, starting at **0%**. An admin can change it.
- A rate change takes effect **from the moment it is changed** (or from a chosen date). Old sales keep the rate they were sold at — each sale line stores its own tax rate and tax amount.
- While the rate is 0%, receipts and reports show no tax line.
- **Confirmed:** shelf prices **already include tax**. When the rate is above 0, the customer pays the same shelf price, and the receipt shows how much of the total is tax.
- **Confirmed:** each product has a **"taxable" tick-box**. Unticked products carry no tax whatever the rate.
- Worked example at 7.5%: a taxable product priced ₦1,075.00 contains ₦75.00 tax (1,075 × 7.5 ÷ 107.5). Tax is worked out per line and rounded to the kobo.
- Note: because prices include tax, raising the rate does not raise what the customer pays — it reduces what the business keeps. Prices must be raised separately if you want to pass the tax on.

---

## 5. Permission table — **approved 2026-10-01**

✅ = allowed · 👁 = view only · 📝 = can request, needs approval · — = not allowed

**Owner** (not shown as a column): everything in the Admin column, in **every** business, plus the owner-only actions below.

| Owner-only action | Owner | Everyone else |
|---|:-:|:-:|
| Create, rename or deactivate a business | ✅ | — |
| Open any business and act as its admin | ✅ | — |
| Create or disable owners | ✅ | — |
| View the all-businesses overview | ✅ | — |
| View the System check page (a report on the hosting server, used after each upload) | ✅ | — |

The table below applies **inside one business**.

| Action | Admin | Manager | Accountant | Cashier | Storekeeper |
|---|:-:|:-:|:-:|:-:|:-:|
| **Staff & settings** | | | | | |
| Create / disable staff accounts, set roles, reset passwords | ✅ | — | — | — | — |
| Change business settings (tax rate, receipt text, automatic sign-out time) | ✅ | — | — | — | — |
| Change own password | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit own full name and username | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create locations and terminals | ✅ | — | — | — | — |
| Import records from Excel | ✅ | — | — | — | — |
| View activity log | ✅ | 👁 | 👁 | — | — |
| **Products & prices** | | | | | |
| Create / edit products and units | ✅ | ✅ | — | — | — |
| Create / rename / remove product categories | ✅ | ✅ | — | — | — |
| Change selling prices | ✅ | ✅ | — | — | — |
| View selling prices | ✅ | ✅ | ✅ | ✅ | ✅ |
| View cost prices and profit margins | ✅ | ✅ | ✅ | — | — |
| **Selling** | | | | | |
| Make a sale at preset prices | ✅ | ✅ | — | ✅ | — |
| Take cash / card / transfer / split payment | ✅ | ✅ | — | ✅ | — |
| Sell on credit to a customer | ✅ | ✅ | — | ✅ | — |
| Request an extra discount | ✅ | ✅ | — | 📝 | — |
| Approve an extra discount | ✅ | ✅ | — | — | — |
| Cancel a whole sale on the same day, with a note (C48) | ✅ | ✅ | — | — | — |
| Process a return *(proposed feature)* | ✅ | ✅ | — | 📝 | — |
| Open and close own till session | ✅ | ✅ | — | ✅ | — |
| Review any till session (expected cash, and whether a count balanced) | ✅ | ✅ | ✅ | — | — |
| Recount a closed till on the same day (C52) | ✅ | ✅ | — | — | — |
| **Customers** | | | | | |
| Create a customer, edit contact details | ✅ | ✅ | ✅ | ✅ | — |
| Set a customer's credit limit *(proposed feature)* | ✅ | ✅ | — | — | — |
| Record a debt repayment | ✅ | ✅ | ✅ | ✅ | — |
| View customer statements and balances | ✅ | ✅ | ✅ | 👁 balance only | — |
| **Stock** | | | | | |
| View stock quantities | ✅ | ✅ | ✅ | ✅ | ✅ |
| Receive goods from a supplier | ✅ | ✅ | — | — | ✅ |
| Add and edit suppliers | ✅ | ✅ | — | — | ✅ |
| View deliveries, including their cost prices | ✅ | ✅ | ✅ | — | ✅ |
| Give a delivery an earlier date (with a note) | ✅ | ✅ | — | — | — |
| Correct a saved delivery (with a reason) | ✅ | ✅ | — | — | — |
| Transfer between Storeroom and Shelf | ✅ | ✅ | — | — | ✅ |
| Enter a stock count | ✅ | ✅ | — | — | ✅ |
| Record a stock adjustment | ✅ | ✅ | — | — | 📝 |
| Approve or reject a stock adjustment | ✅ | ✅ | — | — | — |
| **Reports** | | | | | |
| Sales report | ✅ | ✅ | ✅ | own shift only | — |
| Collections report | ✅ | ✅ | ✅ | own shift only | — |
| Stock on hand / stock movement report | ✅ | ✅ | ✅ | — | ✅ |
| Customer debt report | ✅ | ✅ | ✅ | — | — |
| Discounts & approvals report | ✅ | ✅ | ✅ | — | — |
| Export reports to spreadsheet | ✅ | ✅ | ✅ | — | — |

How this table fits with businesses:

- Every permission applies **only inside the person's own business**. A manager of one business cannot see or approve anything in another.
- "Admin" means the **admin of one business**. Only owners cross businesses.

Points accepted as part of the approval (say if you want any changed later — permissions are defined in one place so this is cheap):

- The **accountant can record debt repayments** but cannot sell or change stock.
- The **storekeeper enters and sees cost prices on deliveries** (C36) but cannot see profit or margin reports. The accountant, who already sees costs in reports, can view deliveries too.
- **Cashiers cannot move stock** from Storeroom to Shelf.
- A **manager who is also selling** can approve their own discount. It is recorded and shown on the approvals report.
- Only **managers, admins and owners** may sell a line directly from the Storeroom (P7).
- Each person has exactly one role.

---

## 6. Recommended technical approach

One approach, chosen because it is widely used, well documented, and lets the whole application live in **one project in one programming language** (TypeScript). Versions were checked against official sources on 2026-10-01.

| Part | Plain-language meaning | Choice | Version checked |
|---|---|---|---|
| **Interface** | The screens staff see in the browser | **Next.js** (with React), **Tailwind CSS** and **shadcn/ui** for ready-made, clean-looking buttons, tables and forms | Next.js 16.3 · React 19 · Tailwind CSS 4.3 |
| **Server** | The program on the internet that checks permissions, applies business rules, and talks to the database | The **same Next.js project** — it contains both the screens and the server code | Runs on Node.js 24, on both your Mac and the hosting server |
| **Database** | Where all products, stock, sales and debts are permanently stored | **MariaDB**, the database included in your hosting plan. It supports "save everything together or nothing" and simultaneous users. *(Changed from PostgreSQL on 2026-10-02 so the app can run on your existing hosting at no extra cost.)* | MariaDB 10.6 on the hosting server; 10.11 on your Mac |
| **Database toolkit** | Lets the code read and write the database safely, and applies structure changes in a controlled, recorded way | **Prisma ORM** with its MariaDB connector | **7.10** (stable). *Version 8 is still a release candidate and must not be used yet.* |
| **Login system** | Staff accounts, passwords, sessions | **Better Auth**, storing accounts in *our own* database. Staff sign in with a username and password. Only an admin or owner can create accounts — there is no public sign-up page. Passwords are stored scrambled (hashed), never readable. Usernames: 3–30 characters (letters, numbers, dot, underscore), not case-sensitive. Passwords: at least 8 characters. | 1.7 |
| **Hosting** | The company that keeps the app running online | **Your existing HOSTAFRICA web hosting account** (the `kuch99.com` account), at the address **`pos.kuch99.com`**. The app and its database sit on the same server. | 1 GB memory, DirectAdmin control panel |
| **Offline storage** | Where the checkout keeps data on the cashier's computer when the internet is down | The browser's built-in database (**IndexedDB**, used through the **Dexie** library), plus a **service worker** (through **Serwist**) so the app opens without internet | Dexie 4 · Serwist 9 |
| **Money & quantity maths** | Avoids rounding errors | Exact decimal numbers in the database (`DECIMAL`) and the **decimal.js** library in code. Ordinary computer "floating point" numbers are never used for money or quantities. | decimal.js 10 |
| **Input checking** | Rejects bad data before it is saved | **Zod** | 4 |
| **Excel import** | Reads the spreadsheet an admin uploads | A spreadsheet-reading library, **to be chosen at the import milestone** after checking which is currently maintained (two of the well-known ones have not been updated on the package registry for a long time) | — |
| **Automated tests** | Programs that check the app still works after each change | **Vitest** (rules and database behaviour) and **Playwright** (clicks through the real screens) | Vitest 5 · Playwright 1.63 |
| **Version control** | A history of every change, with the ability to go back | **Git** (installed: 2.39) with a private **GitHub** repository as the off-computer copy | — |

Why this combination:

- **One project, one language.** Fewer moving parts for a single owner to maintain or hand to another developer.
- **Mainstream.** Next.js, PostgreSQL and Prisma are among the most widely used tools of their kind, so help and developers are easy to find.
- **No lock-in.** Accounts and data live in a standard PostgreSQL database that you own. The app uses no hosting-company-only features, so it can move to another host if needed.
- **Offline is possible later without a rewrite**, because it is a browser app that can be "installed" on the checkout computer.

Things you should know:

- **Zero extra hosting cost** was the deciding factor (your decision, 2026-10-02). The app uses hosting you already pay for.
- **Shared hosting is less robust than a dedicated service.** The app shares a server with other customers' websites, with limits of 1 GB memory and part of one processor. That is enough for a handful of shops. If it ever proves too small, the app can move to a small private server (a "VPS") without being rewritten.
- **Node.js 24** is used on the hosting server (HOSTAFRICA added it on request on 2026-10-02). It is a long-term-support version that still receives security fixes.
- **MariaDB is a little less strict than PostgreSQL.** The gaps are covered by extra rules written into the database (checks and triggers) and by automated tests.
- **The database on your Mac (10.11) is newer than the one on the server (10.6).** Only features that exist in 10.6 may be used, and the full test suite must be run against the server before go-live.
- **Backups:** HOSTAFRICA takes daily backups of the account. In addition, KuchPos will make its own scheduled backup copy, and restoring from it will be practised before go-live (PLAN M17). A host's backup alone is not enough for records of money.
- **Updates are uploaded, not automatic.** Each new version is built on your Mac and sent to the server, because shared hosting is too small to build the app itself.
- **Windows checkout computers.** The app runs in the browser (Chrome or Edge), so nothing special is installed. The app is developed on your Mac but must be tried on a real Windows checkout computer with the real receipt printer before go-live.
- **Barcode scanners need no special work.** A scanner behaves like a very fast keyboard. Products get an optional barcode field now; when you buy a scanner, scanning into the search box finds the product.
- **Receipt printing in version 1** uses the browser's normal Print function with a layout sized for receipt paper. This works with any printer already installed in Windows and needs no special drivers in the app. Each terminal has a **paper width setting: 58 mm or 80 mm**.

### 6.1 Likely cost categories (no prices — these change; check each provider's site)

| Category | What it is | Type |
|---|---|---|
| App and database hosting | Your existing HOSTAFRICA web hosting plan, which you already pay for | Yearly (existing) |
| Domain name | `kuch99.com`, which you already own; `pos.kuch99.com` is a free subdomain of it | Yearly (existing) |
| Possible later upgrade | A small private server (VPS), only if the shared plan proves too small or too slow | Monthly, only if needed |
| Email sending *(optional)* | Only if you want password-reset emails; otherwise the admin resets passwords | Free tier or monthly |
| Error monitoring *(optional)* | A service that alerts when the app crashes | Free tier or monthly |
| Extra backup storage *(optional)* | A second copy of nightly backups held somewhere else | Small monthly |
| Code storage | GitHub private repository | Normally free for this size |
| Hardware | Checkout computers, receipt printer(s), barcode scanner(s), cash drawer, scale, backup power, backup internet (e.g. mobile data) | One-off + upkeep |
| Development | The AI assistant subscription/usage, and your time | Ongoing |
| Maintenance | Security updates, small fixes, occasional help from a developer | Ongoing |

---

## 7. Defaults — **all accepted 2026-10-01**

| # | Topic | Proposal | Why |
|---|---|---|---|
| P1 | **Batch and expiry tracking** | *Refined by the owner on 2026-10-03 (C37, C38):* each product says whether it uses a batch number and/or an expiry date; deliveries of such products must give them; an "expiring soon" list is built from those deliveries, looking ahead the number of months the admin sets. Stock balances are **not** split per batch. Full per-batch tracking (sell oldest-expiry first, per-batch balances) is a later phase. | Seeds, feeds and agro-chemicals expire, so the dates matter. But full batch tracking makes every sale, transfer and count more complicated. This gives the warning without the complexity. |
| P2 | **Returns and refunds** | Include a simple version: a return must refer to an original sale; needs manager approval; returned stock goes either back to a chosen location or is written off as damaged; refund is paid out in cash/transfer or deducted from the customer's debt. A **void** (cancel the whole sale, same day, before till close) follows the same approval rule. The original sale is never altered. | Mistakes at the till are certain to happen. Without a proper return, staff will "fix" them with stock adjustments, which hides the truth. |
| P3 | **Credit limits** | Each customer may have an optional credit limit. A credit sale that would take the balance over the limit needs manager approval (same mechanism as discounts). No limit set = manager approval for every credit sale above an amount you choose, or no restriction — your choice. | Protects against debts growing unnoticed while keeping the cashier fast for trusted customers. |
| P4 | **Costing method** | **Moving weighted average cost** per product. Each time goods are received, the average cost is recalculated. Each sale line stores the average cost at that moment, so profit reports stay stable even if costs change later. | Simple, standard, works without batch tracking, and good enough for margin reporting. (The alternative, first-in-first-out, needs batch-level tracking.) Your accountant should confirm. |
| P5 | **Stock adjustment approval** | Adjustments entered by a **storekeeper** wait for a manager's approval before they change stock. Adjustments by a manager or admin apply immediately. All are logged with a reason and appear on the stock movement report. | Adjustments are the easiest way to hide missing stock, so a second person should see them. |
| P6 | **Till sessions (cash-up)** | Cashier opens a shift with a starting cash amount and closes it by entering counted cash. The system shows expected vs counted. | Needed for a meaningful collections report. |
| P7 | **Selling location** | Sales draw from Shelf by default; managers/admins (or all sellers, if you prefer) may pick Storeroom per line. | Bulky bags often never reach the shelf. |
| P8 | **Staff sign-in** | Username + password, created by the admin. No email needed for staff. Admin can disable an account instantly and reset a password. Sessions end automatically after a period of inactivity. | Many shop staff do not use work email. |
| P9 | **Suppliers** | Keep a simple supplier list (name, phone) used when receiving goods. No purchase orders or supplier debts in version 1. | Enough to trace where stock came from. |
| P10 | **Rounding** | Each sale line total is rounded to the nearest kobo (half rounds up). The sale total is the sum of the rounded lines. Stored totals are never recalculated later. Amounts display as ₦1,250.00. | Makes receipts, reports and the database always agree. Matters for weighed goods (e.g. 2.375 kg × ₦1,333). |
| P11 | **Business structure** | *Replaced by your decision:* independent businesses with no branch level, and owners above them (§4.7). | — |
| P12 | **Dates and times** | Stored in universal time, displayed in Nigerian time (West Africa Time). "Today's sales" means the Nigerian calendar day. | Avoids reports splitting a day at the wrong hour. |
| P13 | **Sign-in names** | Each username is unique across the whole system (not just within one business), so the sign-in page needs only username and password. | Simplest for staff. The alternative — typing a business code as well — is only needed if unrelated businesses want the same usernames. |

---

## 8. Offline checkout — design from the start, build before go-live

Because outages are frequent (C22), a shop could not rely on an online-only system. Offline checkout is therefore built as soon as the online selling workflows are complete and tested, and **before** any business goes live. See PLAN M12.

Two practical points outside the software:

- Offline checkout covers **internet** outages. During a **power** outage the checkout computer and receipt printer still need electricity — a laptop, or a backup power unit (UPS/inverter) for a desktop and the printer.
- Managers and the accountant working from other computers need internet; only the checkout works offline.

Decisions made now so that offline can be added without rework:

1. **Every sale gets its ID on the cashier's computer**, not from the server. (This is the same mechanism that prevents duplicate sales online.)
2. **Each checkout computer is a registered "terminal"** with a short code. Receipt numbers are *terminal code + running number*, so two computers can never produce the same receipt number even when disconnected.
3. **The server accepts a sale together with the prices and conversions the cashier saw**, checks them, and records both the device time and the server time.
4. The checkout screen is built so it can run from data held on the computer (product list, units, prices) rather than asking the server for every keystroke.

Proposed offline behaviour (to be confirmed before that milestone):

- Works for: sales at preset prices paid by cash, card terminal, or transfer.
- Does **not** work offline: extra discounts needing approval, credit sales (or only up to a small limit), returns, stock receiving/transfers/counts, reports.
- The cashier must have signed in on that computer while online; offline use is allowed for a limited time (e.g. one working day).
- Offline sales wait in a queue on the computer and are sent automatically when the internet returns. A clear indicator shows "offline — N sales waiting".
- Stock is checked against the last known figures. If an offline sale later turns out to exceed stock, the sale is still accepted (the goods have already left the shop) and listed in an **offline exceptions report** for a manager to review.
- Risk to understand: if a checkout computer is lost or its browser data is cleared before syncing, sales still in the queue are lost. Printed receipts and a daily "queue is empty" check reduce this risk.

---

## 9. Quality and safety rules the system must meet

1. **Permissions are enforced on the server.** Hiding a button is for convenience only.
2. **Traceable history.** Stock movements, payments, and customer account entries are add-only records. Corrections are new records, never edits or deletions.
3. **All-or-nothing saving.** A sale and its stock and payment changes are saved together or not at all. The same applies to transfers, receipts, adjustments and returns.
4. **No duplicates; safe with simultaneous users.** Unique IDs per submission; the database itself refuses negative stock.
5. **Exact arithmetic** for money and fractional quantities.
6. **History is preserved** when units, conversions or prices change.
7. **Sample data** is used during development; real shop data is entered only in the live system.
8. **Passwords and secret keys never go into source control.**
9. **Backups** exist, and restoring from one has been practised before go-live.
10. **Activity log** for sensitive actions: sign-ins, staff changes, price changes, approvals, adjustments, voids, imports.
11. **Businesses are sealed off from each other.** Every record belongs to a business; the server limits every read and write to the signed-in person's business (or, for an owner, the business they have opened). Automated tests try to reach another business's data and must be refused.

---

## 10. Open questions

### Batch 1 — answered 2026-10-01

| # | Question | Answer |
|---|---|---|
| Q1 | Currency and country | Naira and kobo; Nigeria. Most prices whole Naira, kobo supported. → C14 |
| Q2 | Tax | Rate is an app setting, default 0%. → C15. *Inclusive/exempt details still open: Q9.* |
| Q3 | Size | 5 shops now, up to 20; independent; no stock movement between them; app must support separate businesses; Windows. → C16, C18 |
| Q4 | Hardware | 58 mm or 80 mm receipt printer; barcode scanner later; no barcodes now. → C19 |
| Q5 | Existing records | In Excel; admins must be able to import. → C20 |

### Batch 2 — answered 2026-10-01

| # | Question | Answer |
|---|---|---|
| Q6 | Shared or separate catalogue | Treat every shop as an **independent business**. **No branch level.** Each business has its own products and prices. → C16 |
| Q7 | Who businesses are for; who sees across them | An **owner** role with full admin rights in every business and a view of all businesses. Several owners allowed. → C17 |
| Q8 | Customers and staff across shops | Not shared. Each business has its own customers, debts and staff. → C16 |
| Q9 | Tax when not zero | Prices include tax; "taxable" tick-box per product. → C21 |
| Q10 | Internet and checkout computers | Outages are frequent; one checkout computer per business, possibly more later. → C22, C23 |
| Q11 | Permission table and proposed defaults | Accepted. → §5, §7 |
| Q12 | Manager approving own discount | Allowed and recorded (accepted with the permission table). |
| Q13 | Selling from the Storeroom | Managers, admins and owners only (accepted as P7). |
| Q23 | Automatic sign-out | 8 hours is too long; make it an admin setting per business. → C24. *Details chosen by me, say if you want them changed:* a new business starts at **30 minutes**; the admin may choose between **5 minutes and 8 hours**; **owners** are always signed out after **30 minutes** unused, whichever business they have open. |
| Q24 | Changing your own password | Yes. → C25. Changing it signs that person out on any other computer. |
| Q17 | Backdated entries | Admins and managers may backdate a delivery with a note; tracked in the activity log. → C35 |
| Q15 | Special customer prices | No. → C27. Instead: a cart discount as % or value, approved by a manager or above. → C28 |

### Still open — each will be asked when its milestone is reached

Nothing below blocks the first milestones (M1–M3).

| # | Question | Needed before |
|---|---|---|
| Q14 | What must appear on the receipt (business name, address, phone, tax number, return policy)? | M8 Checkout |
| Q16 | May a customer pay in advance (hold a deposit with the shop)? *Default if unanswered: no.* | M10 Customers and credit |
| Q18 | What format does the accountant need for exports? *Default: CSV, which opens in Excel.* | M14 Reports |
| Q19 | Who will be the owners, who will be the admin of each business, and who holds the hosting and domain accounts? | M3 First online deployment |
| Q20 | What do your Excel files look like today (which columns; one file per shop)? A sample with made-up or non-sensitive rows is enough. | M15 Excel import |
| Q21 | Credit limits (P3): for a customer with **no** limit set, should credit sales be unrestricted, or need manager approval above a set amount? *Default: unrestricted.* | M10 Customers and credit |
| Q22 | **What must work during an outage?** With frequent outages, should credit sales to existing customers and manager-approved discounts be possible offline (with weaker checking), or only ordinary paid sales? | M12 Offline checkout |
